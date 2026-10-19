#!/usr/bin/env python3
"""Convert only incompatible Nightstand values after a recoverable backup."""
import json
import os
from pathlib import Path
import sys
import tempfile

from switch_transaction import read_regular

DAYS = ('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday')


def fsync_directory(path):
    from switch_transaction import fsync_directory as flush
    flush(path)


def publish(path, data, metadata):
    from switch_transaction import publish as write
    write(path, data, metadata)


def snapshot_baselines(store, transaction, folder):
    """Capture both files, including absence, while callers hold the lock and stop writers."""
    for side in ('left', 'right'):
        store.snapshot(transaction, 'baseline-' + side, Path(folder) / (side + '_cap_baseline.json'))


def _baseline_records(store, transaction, folder, mutable=False):
    from switch_transaction import validate_snapshot_parent
    journal = store.load(transaction)
    if mutable and journal['phase'] not in ('snapshots-ready', 'installing'):
        raise ValueError('Baseline changes require complete offline snapshots')
    records = []
    for side in ('left', 'right'):
        path = Path(folder) / (side + '_cap_baseline.json')
        record = journal['snapshots'].get('baseline-' + side)
        if record is None or record['path'] != str(path):
            raise ValueError('Missing baseline snapshot for ' + side)
        validate_snapshot_parent(path, record)
        if path.is_dir() and not path.is_symlink():
            raise ValueError('Baseline path is a directory')
        records.append((path, record))
    return records


def quarantine_baselines(store, transaction, folder):
    """Keep Nightstand's set in the journal, requiring upstream to recalibrate."""
    records = _baseline_records(store, transaction, folder, mutable=True)
    store.intent(transaction, 'quarantine-baselines', {'folder': str(folder)})
    for path, _ in records:
        if path.exists() or path.is_symlink():
            path.unlink()
            fsync_directory(path.parent)


def restore_baselines(store, transaction, retained_transaction, folder):
    """Preserve current upstream files in this transaction before restoring the retained set."""
    from switch_transaction import digest
    _baseline_records(store, transaction, folder, mutable=True)
    records = _baseline_records(store, retained_transaction, folder)
    payloads = {}
    for path, record in records:
        if record['kind'] == 'symlink':
            raise ValueError('Cannot activate a retained baseline symlink')
        if record['kind'] == 'file':
            backup = store.directory(retained_transaction) / record['backup']
            if backup.is_symlink():
                raise ValueError('Invalid baseline backup')
            data = backup.read_bytes()
            if digest(data) != record['sha256']:
                raise ValueError('Baseline snapshot checksum mismatch')
            payloads[path] = data
    store.intent(transaction, 'restore-baselines', {'retainedTransaction': retained_transaction})
    for path, record in records:
        if record['kind'] == 'absent':
            if path.exists() or path.is_symlink():
                path.unlink()
                fsync_directory(path.parent)
        else:
            publish(path, payloads[path], record)


def prepare(folder):
    folder = Path(folder)
    paths = [folder / 'settingsDB.json', folder / 'schedulesDB.json']
    settings, schedules = [json.loads(read_regular(path)) for path in paths]
    if settings.get('temperatureFormat') == 'level':
        settings['temperatureFormat'] = 'fahrenheit'
    for side in ('left', 'right'):
        taps = settings.get(side, {}).get('taps', {})
        for gesture in ('doubleTap', 'tripleTap', 'quadTap'):
            if taps.get(gesture, {}).get('type') in ('base_control', 'set_temperature'):
                taps[gesture] = dict(type='alarm', behavior='dismiss',
                                     snoozeDuration=300, inactiveAlarmBehavior='none')
        for day in DAYS:
            entry = schedules.get(side, {}).get(day)
            if not isinstance(entry, dict):
                continue
            alarms = entry.pop('alarms', None)
            if isinstance(alarms, list):
                enabled = next((alarm for alarm in alarms if alarm.get('enabled') is True), None)
                selected = enabled or (alarms[0] if alarms else entry.get('alarm', {}))
                entry['alarm'] = dict(selected, enabled=enabled is not None)
            alarm = entry.get('alarm')
            if isinstance(alarm, dict) and isinstance(alarm.get('duration'), (int, float)):
                alarm['duration'] = min(alarm['duration'], 180)
    # Parse and transform both documents before publishing either one. The caller
    # stops writers and restores its backup if any publication fails.
    for path, value in zip(paths, (settings, schedules)):
        original = path.stat()
        descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=folder)
        try:
            with os.fdopen(descriptor, 'w') as output:
                json.dump(value, output, indent=2)
                output.write('\n')
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, original.st_mode & 0o777)
            if os.geteuid() == 0:
                os.chown(temporary, original.st_uid, original.st_gid)
            os.replace(temporary, path)
            fsync_directory(path.parent)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2:
            prepare(sys.argv[1])
        else:
            import argparse
            from switch_transaction import DEFAULT_ROOT, TransactionStore
            parser = argparse.ArgumentParser(description=__doc__)
            parser.add_argument('folder', type=Path)
            parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
            parser.add_argument('--transaction', required=True)
            parser.add_argument('--baselines', choices=('snapshot', 'quarantine', 'restore'), required=True)
            parser.add_argument('--retained-transaction')
            args = parser.parse_args()
            store = TransactionStore(args.root)
            if args.baselines == 'restore':
                if not args.retained_transaction:
                    parser.error('restore requires --retained-transaction')
                restore_baselines(store, args.transaction, args.retained_transaction, args.folder)
            elif args.baselines == 'snapshot':
                snapshot_baselines(store, args.transaction, args.folder)
            else:
                quarantine_baselines(store, args.transaction, args.folder)
    except (OSError, ValueError, TypeError, AttributeError, IndexError) as error:
        sys.exit('Could not prepare upstream settings: ' + str(error))
