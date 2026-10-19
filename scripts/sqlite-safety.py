#!/usr/bin/env python3
"""Consistent SQLite snapshots and conservative failed-migration checks.

Requires Python's standard sqlite3 module. Never falls back to copying a live
main file: committed data can still be in its WAL.
"""
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import time


def connect(database):
    # Root opens this read-write and SQLite creates its side files without
    # O_NOFOLLOW, so a link the server user left at any of them is refused.
    path = Path(database).absolute()
    for name in (path.name, path.name + '-wal', path.name + '-shm', path.name + '-journal'):
        if path.with_name(name).is_symlink():
            raise ValueError(f'{path.with_name(name)} is a link; refusing to open the database')
    return sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=5)


def hand_over(database, owner):
    """Gives the folder's owner any database file root left owned by itself.

    Only a plain file with one name is changed, through a descriptor opened
    without following links, so this never reaches another file.
    """
    path = os.path.abspath(database)
    for name in (path, path + '-wal', path + '-shm', path + '-journal'):
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            info = os.fstat(descriptor)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid != owner.st_uid:
                os.fchown(descriptor, owner.st_uid, owner.st_gid)
        finally:
            os.close(descriptor)


def as_owner(database, step, output):
    """Runs step(output) as the owner of the database's folder when root runs this.

    The database and its side files belong to that user, so a link left
    there only reaches what that user could already write. The step's
    bytes come back over a pipe into output, which root opened itself.
    """
    owner = os.stat(os.path.dirname(os.path.abspath(database)))
    if os.geteuid() != 0 or owner.st_uid == 0:
        step(output)
        return
    hand_over(database, owner)
    read_end, write_end = os.pipe()
    child = os.fork()
    if child == 0:
        status = 1
        try:
            # Keep only stdio and the pipe: nothing root holds open, such as
            # its backup file or the operation lock, reaches the other user.
            os.closerange(3, write_end)
            os.closerange(write_end + 1, os.sysconf('SC_OPEN_MAX'))
            os.setgroups([])
            os.setgid(owner.st_gid)
            os.setuid(owner.st_uid)
            with os.fdopen(write_end, 'wb') as pipe:
                step(pipe)
            status = 0
        except BaseException as error:
            print(f'Database safety check failed: {error}', file=sys.stderr)
        finally:
            os._exit(status)
    os.close(write_end)
    with os.fdopen(read_end, 'rb') as pipe:
        shutil.copyfileobj(pipe, output)
    _, status = os.waitpid(child, 0)
    if status != 0:
        raise RuntimeError('the database step failed')


def checkpoint(database):
    def step(_output):
        with closing(connect(database)) as source:
            busy, _, _ = source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
            if busy:
                raise RuntimeError('Database checkpoint is busy; keep the database and WAL together and retry after stopping writers.')
    as_owner(database, step, io.BytesIO())


def snapshot(database, output):
    """Writes a consistent copy of the database to output."""
    path = Path(database).absolute()
    descriptor, temporary = tempfile.mkstemp(prefix='.sqlite-snapshot-', dir=path.parent)
    os.close(descriptor)
    source = target = None
    try:
        source = connect(database)
        target = sqlite3.connect(temporary)
        deadline = time.monotonic() + 30

        def progress(_status, _remaining, _total):
            if time.monotonic() > deadline:
                raise RuntimeError('Database backup timed out; no snapshot was published.')

        source.backup(target, pages=256, progress=progress, sleep=0.1)
        target.close()
        target = None
        with open(temporary, 'rb') as copy:
            shutil.copyfileobj(copy, output)
    finally:
        if target is not None:
            target.close()
        if source is not None:
            source.close()
        os.unlink(temporary)


def backup(database, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.sqlite-backup-', dir=destination.parent)
    target = None
    try:
        with os.fdopen(descriptor, 'wb') as output:
            as_owner(database, lambda pipe: snapshot(database, pipe), output)
            output.flush()
            os.fsync(output.fileno())
        target = sqlite3.connect(temporary)
        if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('Database backup failed integrity_check')
        target.close()
        target = None
        # A hard link publishes the complete file atomically without replacing
        # an existing recovery copy, even if two callers choose the same name.
        os.link(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if target is not None:
            target.close()
        os.unlink(temporary)


def statements(sql):
    # Strip comments but preserve quoted values and identifiers. Restrict the
    # accepted grammar below rather than attempting to rewrite arbitrary SQL.
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^\]]*\]|--[^\n]*|/\*[\s\S]*?\*/|[^'\"`\[/-]+|.", sql)
    clean = ''.join(token if not token.startswith(('--', '/*')) else ' ' for token in tokens)
    result, current = [], ''
    for character in clean:
        current += character
        if character == ';' and sqlite3.complete_statement(current):
            result.append(current.strip())
            current = ''
    if current.strip():
        raise ValueError('Every migration statement must end with a semicolon')
    return result


def atomic_additive(sql):
    commands = statements(sql)
    if len(commands) < 3 or not re.fullmatch(r'BEGIN(?:\s+TRANSACTION)?\s*;', commands[0], re.I) or not re.fullmatch(r'COMMIT\s*;', commands[-1], re.I):
        raise ValueError('New migrations must have one BEGIN; ... COMMIT; transaction')
    for command in commands[1:-1]:
        if re.match(r'CREATE\s+TABLE\s+', command, re.I):
            # NOT NULL is safe in a genuinely new table. SQLite itself rejects
            # an existing table name, so CREATE cannot silently rebuild one.
            if re.match(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS|["`\[]?new_)', command, re.I):
                raise ValueError('Table rebuilds and conditional table creation are not allowed')
            continue
        if re.match(r'CREATE\s+INDEX\s+', command, re.I):
            continue
        if re.match(r'ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+ADD\s+(?:COLUMN\s+)?', command, re.I):
            keywords = re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^\]]*\]", '?', command)
            if re.search(r'\bNOT\s+NULL\b', keywords, re.I):
                if not re.search(r'\bDEFAULT\b', keywords, re.I) or re.search(r'\bDEFAULT\s*\(*\s*NULL\b', keywords, re.I):
                    raise ValueError('Required columns on existing tables need a non-null DEFAULT')
            if re.search(r'\b(?:UNIQUE|PRIMARY|REFERENCES|CHECK)\b', command, re.I):
                raise ValueError('New constraints on existing tables need compatibility review')
            continue
        if re.fullmatch(r'DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?\w+_idx"?\s*;', command, re.I):
            # A non-unique index only: older code reads the same rows through the unique one.
            continue
        raise ValueError('Only new tables, non-unique indexes, and additive columns are allowed')


def recoverable_migrations(database, directory):
    def step(output):
        with closing(connect(database)) as source:
            rows = source.execute('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL').fetchall()
        output.write(json.dumps(rows).encode())
    found = io.BytesIO()
    as_owner(database, step, found)
    rows = json.loads(found.getvalue())
    if not rows:
        raise ValueError('No failed migrations found')
    names = []
    for name, checksum in rows:
        if not re.fullmatch(r'\d{14}_\w+', name):
            raise ValueError('Invalid failed migration name')
        content = (Path(directory) / name / 'migration.sql').read_bytes()
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError(f'{name}: migration checksum differs; manual recovery required')
        atomic_additive(content.decode())
        names.append(name)
    # Validate the whole set before allowing the caller to resolve any rows.
    return sorted(set(names))


def main():
    operation, *arguments = sys.argv[1:]
    if operation == 'backup' and len(arguments) == 2:
        backup(*arguments)
    elif operation == 'checkpoint' and len(arguments) == 1:
        checkpoint(*arguments)
    elif operation == 'recoverable-migrations' and len(arguments) == 2:
        print('\n'.join(recoverable_migrations(*arguments)))
    else:
        raise ValueError('Usage: sqlite-safety.py backup DB DEST | checkpoint DB | recoverable-migrations DB MIGRATIONS_DIR')


if __name__ == '__main__':
    try:
        main()
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
        print(f'Database safety check failed: {error}', file=sys.stderr)
        sys.exit(1)
