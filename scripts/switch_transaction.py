#!/usr/bin/env python3
"""Durable cross-fork journals. Callers must hold the maintenance operation lock.

Arm before stopping writers, snapshot after stopping them, and publish intent
before changing live paths. A committed journal permits cleanup only. Retain
journals and their backups while a retained installation needs companion state.

Snapshot parents may contain symlinks. Each snapshot records its resolved real
parent, including any missing suffix for an absent path. Restoration checks all
parents before any live write and checks each again before restoring it. A parent
that resolves elsewhere, or a journal without this record, prevents restoration
and leaves the journal and backups intact. Callers must keep ancestors stable
under the maintenance lock throughout snapshotting and restoration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid

DEFAULT_ROOT = Path('/persistent/free-sleep-maintenance/nightstand-transactions')
TRANSITIONS = {
    'armed': {'writers-stopped', 'recovering'},
    'writers-stopped': {'snapshots-ready', 'recovering'},
    'snapshots-ready': {'installing', 'recovering'},
    'installing': {'validating', 'recovering'},
    'validating': {'committed', 'recovering'},
    'recovering': {'recovered'},
    'committed': {'cleaned'},
    'recovered': set(), 'cleaned': set(),
}


def identifier(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', value) is None:
        raise ValueError('Invalid transaction identifier')
    return value


def absolute_path(value):
    if not isinstance(value, str) or not value.startswith('/') or any(char in value for char in '\n\r\0'):
        raise ValueError('Invalid transaction path')
    if str(Path(value)) != value or '..' in Path(value).parts:
        raise ValueError('Transaction paths must be absolute and normalized')
    return Path(value)


def is_published(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Unexpected entry in transaction root')
    # No live mutation is allowed before the initial journal is published.
    return os.path.lexists(str(directory / 'journal.json'))


def read_regular(path):
    """Read a file another user can replace, refusing links, FIFOs and devices."""
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with open(descriptor, 'rb') as handle:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError('Not a regular file: ' + str(path))
        return handle.read()


def fsync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_directory(path):
    if path.is_symlink():
        raise ValueError('Transaction directories cannot be symlinks')
    if path.exists():
        if not path.is_dir():
            raise ValueError('Not a transaction directory')
        return
    durable_directory(path.parent)
    path.mkdir(mode=0o700)
    fsync_directory(path)
    fsync_directory(path.parent)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def publish(path, data, metadata=None):
    """Publish complete bytes and metadata, then flush the directory rename."""
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=str(path.parent))
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            if metadata:
                restore_metadata(temporary, metadata)
            os.fsync(output.fileno())
        fsync_directory(path.parent)
        os.replace(str(temporary), str(path))
        fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
            fsync_directory(path.parent)


def restore_metadata(path, record, symlink=False):
    current = path.lstat()
    if (current.st_uid, current.st_gid) != (record['uid'], record['gid']):
        os.chown(str(path), record['uid'], record['gid'], follow_symlinks=not symlink)
    if not symlink:
        os.chmod(str(path), record['mode'])
    os.utime(str(path), ns=(record['atimeNs'], record['mtimeNs']), follow_symlinks=not symlink)


def validate_identity(value):
    if not isinstance(value, dict) or value.get('fork') not in ('nightstand', 'upstream'):
        raise ValueError('Invalid installation identity')
    for field, pattern in [('commit', r'[0-9a-f]{40}'), ('treeSha256', r'[0-9a-f]{64}'),
                           ('version', r'[0-9]+\.[0-9]+\.[0-9]+')]:
        if not isinstance(value.get(field), str) or re.fullmatch(pattern, value[field]) is None:
            raise ValueError('Invalid installation ' + field)
    absolute_path(value.get('treePath'))


def validate_journal(journal, transaction_id):
    """Reject incomplete state before a recovery caller can act on it."""
    if (not isinstance(journal, dict) or type(journal.get('schemaVersion')) is not int
            or journal['schemaVersion'] != 1 or journal.get('id') != transaction_id):
        raise ValueError('Unsupported or mismatched transaction journal')
    if journal.get('phase') not in TRANSITIONS or type(journal.get('sequence')) is not int or journal['sequence'] < 0:
        raise ValueError('Invalid transaction phase or sequence')
    validate_identity(journal.get('source'))
    validate_identity(journal.get('target'))
    if not isinstance(journal.get('metadata'), dict) or not isinstance(journal.get('snapshots'), dict):
        raise ValueError('Invalid transaction metadata or snapshots')
    if not isinstance(journal.get('backups'), list) or not isinstance(journal.get('intents'), list):
        raise ValueError('Invalid transaction backups or intents')
    for path in journal['backups']:
        absolute_path(path)
    for intent in journal['intents']:
        if not isinstance(intent, dict) or not isinstance(intent.get('details'), dict):
            raise ValueError('Invalid mutation intent')
        identifier(intent.get('name'))
    for name, record in journal['snapshots'].items():
        identifier(name)
        if not isinstance(record, dict) or record.get('kind') not in ('absent', 'file', 'symlink'):
            raise ValueError('Invalid snapshot')
        absolute_path(record.get('path'))
        absolute_path(record.get('realParent'))
        if record['kind'] == 'absent':
            continue
        for field in ('mode', 'uid', 'gid', 'atimeNs', 'mtimeNs'):
            if type(record.get(field)) is not int or (field not in ('atimeNs', 'mtimeNs') and record[field] < 0):
                raise ValueError('Invalid snapshot metadata')
        if record['mode'] > 0o7777:
            raise ValueError('Invalid snapshot mode')
        if record['kind'] == 'file':
            identifier(record.get('backup'))
            if not isinstance(record.get('sha256'), str) or re.fullmatch(r'[0-9a-f]{64}', record['sha256']) is None:
                raise ValueError('Invalid snapshot checksum')
        elif not isinstance(record.get('linkTarget'), str) or '\0' in record['linkTarget']:
            raise ValueError('Invalid symlink snapshot')


def validate_snapshot_parent(path, record):
    resolved = str(path.parent.resolve())
    if resolved != record['realParent']:
        raise ValueError('Snapshot parent changed for ' + str(path) + ': expected '
                         + record['realParent'] + ', found ' + resolved)


class TransactionStore:
    def __init__(self, root=DEFAULT_ROOT):
        self.root = absolute_path(str(root))

    def directory(self, transaction_id):
        identifier(transaction_id)
        directory = self.root / transaction_id
        if self.root.is_symlink() or directory.is_symlink():
            raise ValueError('Transaction directories cannot be symlinks')
        return directory

    def _write(self, journal):
        validate_journal(journal, journal['id'])
        envelope = {'journal': journal, 'sha256': digest(canonical(journal))}
        publish(self.directory(journal['id']) / 'journal.json', canonical(envelope) + b'\n')

    def create(self, transaction_id, source, target, metadata=None):
        journal = {'schemaVersion': 1, 'id': identifier(transaction_id), 'sequence': 0, 'phase': 'armed',
                   'source': source, 'target': target, 'metadata': {} if metadata is None else metadata,
                   'snapshots': {}, 'backups': [], 'intents': []}
        validate_journal(journal, transaction_id)
        canonical(journal)
        durable_directory(self.root)
        directory = self.directory(transaction_id)
        directory.mkdir(mode=0o700)
        fsync_directory(directory)
        fsync_directory(self.root)
        self._write(journal)
        return journal

    def load(self, transaction_id):
        path = self.directory(transaction_id) / 'journal.json'
        if path.is_symlink():
            raise ValueError('Journal cannot be a symlink')
        try:
            envelope = json.loads(path.read_bytes())
            journal = envelope['journal']
            if envelope['sha256'] != digest(canonical(journal)):
                raise ValueError('Transaction journal checksum mismatch')
            validate_journal(journal, transaction_id)
            return journal
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ValueError('Unreadable transaction journal: ' + str(path)) from error

    def advance(self, transaction_id, phase):
        journal = self.load(transaction_id)
        if phase == journal['phase']:
            return journal
        if phase not in TRANSITIONS[journal['phase']]:
            raise ValueError('Invalid transaction phase transition')
        journal['phase'] = phase
        journal['sequence'] += 1
        self._write(journal)
        return journal

    def intent(self, transaction_id, name, details):
        journal = self.load(transaction_id)
        if journal['phase'] in ('committed', 'cleaned', 'recovered'):
            raise ValueError('Transaction no longer accepts mutation intents')
        journal['intents'].append({'name': identifier(name), 'details': details})
        journal['sequence'] += 1
        self._write(journal)

    def add_backup(self, transaction_id, path):
        journal = self.load(transaction_id)
        path = str(absolute_path(str(path)).resolve())
        if journal['phase'] in ('committed', 'cleaned', 'recovered'):
            raise ValueError('Cannot add backups after transaction completion')
        if path not in journal['backups']:
            journal['backups'].append(path)
            journal['sequence'] += 1
            self._write(journal)

    def snapshot(self, transaction_id, name, path):
        """Capture a stopped writer's file or absence before live mutation."""
        journal = self.load(transaction_id)
        name = identifier(name)
        path = absolute_path(str(path))
        if journal['phase'] != 'writers-stopped' or name in journal['snapshots']:
            raise ValueError('Snapshots require stopped writers and a new name')
        if any(record['path'] == str(path) for record in journal['snapshots'].values()):
            raise ValueError('Path already snapshotted')
        real_parent = str(path.parent.resolve())
        try:
            status = path.lstat()
        except FileNotFoundError:
            record = {'kind': 'absent', 'path': str(path)}
        else:
            record = {'path': str(path), 'mode': stat.S_IMODE(status.st_mode), 'uid': status.st_uid,
                      'gid': status.st_gid, 'atimeNs': status.st_atime_ns, 'mtimeNs': status.st_mtime_ns}
            if stat.S_ISREG(status.st_mode):
                data = read_regular(path)
                backup = 'snapshot-' + uuid.uuid4().hex
                publish(self.directory(transaction_id) / backup, data)
                record.update(kind='file', backup=backup, sha256=digest(data))
            elif stat.S_ISLNK(status.st_mode):
                record.update(kind='symlink', linkTarget=os.readlink(str(path)))
            else:
                raise ValueError('Snapshot requires a regular file, symlink or absent path')
        record['realParent'] = real_parent
        journal['snapshots'][name] = record
        journal['sequence'] += 1
        self._write(journal)
        return record

    def restore_snapshots(self, transaction_id):
        """Restore offline; verify backups and destination paths before any live write."""
        journal = self.load(transaction_id)
        if journal['phase'] != 'recovering':
            raise ValueError('Restoration requires an uncommitted recovering transaction')
        payloads = {}
        for name, record in journal['snapshots'].items():
            path = absolute_path(record['path'])
            validate_snapshot_parent(path, record)
            if path.is_dir() and not path.is_symlink():
                raise ValueError('Refusing to replace a directory with a file snapshot')
            if record['kind'] != 'absent' and not path.parent.is_dir():
                raise ValueError('Missing snapshot destination directory')
            if record['kind'] == 'file':
                backup = self.directory(transaction_id) / record['backup']
                if backup.is_symlink() or not backup.is_file():
                    raise ValueError('Missing snapshot backup')
                data = backup.read_bytes()
                if digest(data) != record['sha256']:
                    raise ValueError('Snapshot checksum mismatch')
                payloads[name] = data
        for name, record in journal['snapshots'].items():
            path = absolute_path(record['path'])
            validate_snapshot_parent(path, record)
            if record['kind'] == 'absent':
                try:
                    path.unlink()
                except FileNotFoundError:
                    if not path.parent.exists():
                        continue
                fsync_directory(path.parent)
            elif record['kind'] == 'file':
                publish(path, payloads[name], record)
            else:
                temporary = path.parent / ('.pending-' + uuid.uuid4().hex)
                try:
                    temporary.symlink_to(record['linkTarget'])
                    restore_metadata(temporary, record, symlink=True)
                    fsync_directory(path.parent)
                    os.replace(str(temporary), str(path))
                    fsync_directory(path.parent)
                finally:
                    if temporary.is_symlink():
                        temporary.unlink()
                        fsync_directory(path.parent)

    def protected_backups(self):
        if not self.root.exists() and not self.root.is_symlink():
            return set()
        if self.root.is_symlink() or not self.root.is_dir():
            raise ValueError('Invalid transaction root')
        protected = set()
        for directory in self.root.iterdir():
            if not is_published(directory):
                continue
            journal = self.load(directory.name)
            protected.update(journal['backups'])
        return protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('protected-backups')
    for command in ('show', 'create', 'advance', 'snapshot', 'intent', 'add-backup', 'restore'):
        subparser = commands.add_parser(command)
        subparser.add_argument('transaction')
        if command == 'create':
            subparser.add_argument('--source', type=Path, required=True)
            subparser.add_argument('--target', type=Path, required=True)
            subparser.add_argument('--metadata', type=Path)
        elif command == 'advance':
            subparser.add_argument('phase', choices=list(TRANSITIONS))
        elif command == 'snapshot':
            subparser.add_argument('name')
            subparser.add_argument('path', type=Path)
        elif command == 'intent':
            subparser.add_argument('name')
            subparser.add_argument('details', type=Path)
        elif command == 'add-backup':
            subparser.add_argument('path', type=Path)
    args = parser.parse_args()
    try:
        store = TransactionStore(args.root)
        if args.command == 'protected-backups':
            for path in sorted(store.protected_backups()):
                print(path)
        elif args.command == 'show':
            print(json.dumps(store.load(args.transaction), sort_keys=True))
        elif args.command == 'create':
            store.create(args.transaction, json.loads(args.source.read_text()), json.loads(args.target.read_text()),
                         json.loads(args.metadata.read_text()) if args.metadata else None)
        elif args.command == 'advance':
            store.advance(args.transaction, args.phase)
        elif args.command == 'snapshot':
            store.snapshot(args.transaction, args.name, args.path)
        elif args.command == 'intent':
            store.intent(args.transaction, args.name, json.loads(args.details.read_text()))
        elif args.command == 'add-backup':
            store.add_backup(args.transaction, args.path)
        elif args.command == 'restore':
            store.restore_snapshots(args.transaction)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
