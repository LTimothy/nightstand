#!/usr/bin/env python3
"""Offline switch recovery. The shell entry point serializes live restoration.

metadata.recovery records paths (kind, live, saved, failed, device, inode),
with realParents for each mapped path,
services (active and enabled booleans, optional enabledMode), and optionally the operation unit and
its systemd invocationId. Capture identities before arming, and run operations
in a dedicated systemd control group. Directory environments stay at their
original path on restore; prepared environments are never relocated.
Before controlled target starts, enter validating and record a validation-startup
intent listing the server and stream units. Their startup checks also require
the recorded operation invocation to be active and the maintenance lock held.
"""
import argparse
import fcntl
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import uuid

from switch_transaction import TransactionStore, absolute_path, fsync_directory, digest, is_published, read_regular
from switch_services import (Configuration, CONFIG_UNITS as FORK_CONFIG_UNITS,
                             restore as restore_configuration, restore_enablement)

WRITERS = ('free-sleep.service', 'free-sleep-stream.service',
           'free-sleep-archive-raw.service', 'free-sleep-health.service',
           'free-sleep-network-watchdog.service', 'free-sleep-recover-update.service')
OPERATIONS = ('free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service', 'free-sleep-migrate.service')
SERVICES = WRITERS + ('free-sleep-archive-raw.timer', 'free-sleep-health.timer',
                     'free-sleep-network-watchdog.timer')
TERMINAL = ('committed', 'cleaned', 'recovered')


def controller(*arguments):
    return subprocess.run(['systemctl'] + list(arguments), check=True,
                          capture_output=True, text=True, timeout=20).stdout.strip()


def journals(store):
    if not store.root.exists() and not store.root.is_symlink():
        return []
    if store.root.is_symlink() or not store.root.is_dir():
        raise ValueError('Invalid transaction root')
    result = []
    for entry in sorted(store.root.iterdir()):
        if not is_published(entry):
            continue
        result.append(store.load(entry.name))
    if sum(journal['phase'] not in TERMINAL for journal in result) > 1:
        raise ValueError('Multiple unfinished switches require manual recovery')
    return result


def recovery_record(journal):
    record = journal['metadata'].get('recovery')
    if not isinstance(record, dict) or not isinstance(record.get('paths'), list) or not record['paths']:
        raise ValueError('Missing switch recovery paths')
    seen = set()
    trees = 0
    for mapping in record['paths']:
        if not isinstance(mapping, dict) or mapping.get('kind') not in ('tree', 'environment'):
            raise ValueError('Invalid recovery mapping')
        for key in ('live', 'saved', 'failed'):
            path = absolute_path(mapping.get(key))
            if str(path) in seen:
                raise ValueError('Overlapping recovery paths')
            seen.add(str(path))
            parents = mapping.get('realParents')
            if (not isinstance(parents, dict) or not path.parent.is_dir()
                    or str(path.parent.resolve()) != str(absolute_path(parents.get(key)))):
                raise ValueError('Recovery mapping parent changed')
        if 'absent' in mapping and (mapping['kind'] != 'environment' or mapping['absent'] is not True):
            raise ValueError('Invalid absent environment mapping')
        if not mapping.get('absent'):
            for key in ('device', 'inode'):
                if type(mapping.get(key)) is not int or mapping[key] < 0:
                    raise ValueError('Missing source filesystem identity')
        if mapping['kind'] == 'tree':
            trees += 1
            if mapping['live'] != journal['source']['treePath']:
                raise ValueError('Source tree does not match recovery mapping')
    if trees != 1:
        raise ValueError('Recovery requires one source tree')
    paths = [Path(path) for path in seen]
    if any(first in second.parents for first in paths for second in paths if first != second):
        raise ValueError('Nested recovery paths')
    services = record.get('services')
    if not isinstance(services, dict) or not {'free-sleep.service', 'free-sleep-stream.service'} <= services.keys():
        raise ValueError('Missing writer service state')
    for unit, state in services.items():
        if unit not in SERVICES or not isinstance(state, dict) or any(type(state.get(key)) is not bool for key in ('active', 'enabled')):
            raise ValueError('Invalid recorded service state')
    operation = record.get('operation')
    if operation is not None:
        if (not isinstance(operation, dict) or operation.get('unit') not in OPERATIONS
                or not isinstance(operation.get('invocationId'), str)
                or re.fullmatch(r'[0-9a-f]{32}', operation['invocationId']) is None):
            raise ValueError('Invalid operation invocation identity')
    return record


def check_startup(store, unit, lock_path):
    """Permit pending switches only for explicitly requested target validation."""
    if unit not in WRITERS + OPERATIONS:
        raise ValueError('Unknown startup unit')
    pending = [journal for journal in journals(store) if journal['phase'] not in TERMINAL]
    if not pending:
        return
    journal = pending[0]
    record = recovery_record(journal)
    permissions = [item['details'] for item in journal['intents'] if item['name'] == 'validation-startup']
    if (journal['phase'] != 'validating' or len(permissions) != 1
            or unit not in ('free-sleep.service', 'free-sleep-stream.service')
            or not isinstance(permissions[0].get('units'), list) or unit not in permissions[0]['units']):
        raise ValueError('An unfinished switch blocks writer startup')
    operation = record.get('operation')
    if (operation is None
            or controller('show', '--property=InvocationID', '--value', operation['unit']) != operation['invocationId']
            or controller('show', '--property=ActiveState', '--value', operation['unit']) not in ('active', 'activating')):
        raise ValueError('Validation operation is no longer running')
    with Path(lock_path).open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        fcntl.flock(lock, fcntl.LOCK_UN)
    raise ValueError('Validation operation no longer holds the maintenance lock')



def operation_active(store, lock_path):
    """Defer boot recovery while a recorded maintenance owner still holds the lock."""
    pending = [journal for journal in journals(store) if journal['phase'] not in TERMINAL]
    if not pending:
        return False
    operation = recovery_record(pending[0]).get('operation')
    if (operation is None
            or controller('show', '--property=InvocationID', '--value', operation['unit']) != operation['invocationId']
            or controller('show', '--property=ActiveState', '--value', operation['unit']) not in ('active', 'activating')):
        return False
    with Path(lock_path).open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock, fcntl.LOCK_UN)
    return False


def matching(path, mapping):
    try:
        status = path.lstat()
    except FileNotFoundError:
        return False
    return (status.st_dev, status.st_ino) == (mapping['device'], mapping['inode'])


def restore_paths(journal, record):
    # Check every source before moving any path. Never overwrite retained evidence.
    for mapping in record['paths']:
        live, saved, failed = (Path(mapping[key]) for key in ('live', 'saved', 'failed'))
        if mapping.get('absent'):
            if os.path.lexists(str(saved)) or (os.path.lexists(str(live)) and os.path.lexists(str(failed))):
                raise ValueError('Absent environment recovery paths are occupied')
            continue
        source = live if matching(live, mapping) else saved
        if not matching(source, mapping):
            raise ValueError('Original installation is missing: ' + str(live))
        if source != live and os.path.lexists(str(live)) and os.path.lexists(str(failed)):
            raise ValueError('Failed installation path is already occupied: ' + str(failed))
        if mapping['kind'] == 'tree':
            import json
            if source.is_symlink() or not source.is_dir():
                raise ValueError('Original tree is not a directory')
            if json.loads(read_regular(source / 'server/src/serverInfo.json'))['version'] != journal['source']['version']:
                raise ValueError('Original tree version mismatch')
    for mapping in record['paths']:
        live, saved, failed = (Path(mapping[key]) for key in ('live', 'saved', 'failed'))
        if mapping.get('absent'):
            if os.path.lexists(str(live)):
                os.rename(str(live), str(failed))
                fsync_directory(live.parent)
            continue
        if matching(live, mapping):
            continue
        if os.path.lexists(str(live)):
            os.rename(str(live), str(failed))
            fsync_directory(live.parent)
            fsync_directory(failed.parent)
        os.rename(str(saved), str(live))
        fsync_directory(saved.parent)
        fsync_directory(live.parent)


def stop_operations(store):
    for journal in journals(store):
        if journal['phase'] in TERMINAL:
            continue
        record = recovery_record(journal)
        operation = record.get('operation')
        if operation:
            invocation = controller('show', '--property=InvocationID', '--value', operation['unit'])
            if invocation == operation['invocationId']:
                controller('kill', '--kill-who=all', '--signal=SIGKILL', operation['unit'])
                group = controller('show', '--property=ControlGroup', '--value', operation['unit'])
                if group:
                    if not group.startswith('/') or '..' in Path(group).parts:
                        raise ValueError('Invalid operation control group')
                    roots = [Path('/sys/fs/cgroup' + group), Path('/sys/fs/cgroup/systemd' + group)]
                    root = next((path for path in roots if path.is_dir()), None)
                    if root is None:
                        continue
                    for attempt in range(20):
                        members = list(root.rglob('cgroup.procs'))
                        if members and all(not path.read_text().strip() for path in members):
                            break
                        if not root.exists():
                            break
                        time.sleep(0.1)
                    else:
                        raise ValueError('Operation descendants did not stop')




def migration_artifacts(store, journal, mode):
    records = [item['details'] for item in journal['intents'] if item['name'] == 'migration-artifacts']
    if not records:
        return
    script = store.directory(journal['id']) / 'migration-artifacts.sh'
    if (len(records) != 1 or records[0].get('path') != str(script) or script.is_symlink()
            or digest(script.read_bytes()) != records[0].get('sha256')):
        raise ValueError('Invalid migration artifact recovery helper')
    subprocess.run(['bash', str(script), mode], check=True, timeout=60)


def restore_target_slot(journal, record):
    slot = journal['metadata'].get('targetSlot')
    if slot is None:
        return
    tree = next(item for item in record['paths'] if item['kind'] == 'tree')
    path = absolute_path(slot['path'])
    if path != Path(tree['live']).parent / 'free-sleep-prev':
        raise ValueError('Invalid target rollback slot')
    if matching(path, slot):
        return
    failed = Path(tree['failed'])
    if not matching(failed, slot) or os.path.lexists(str(path)):
        raise ValueError('Target rollback slot cannot be restored')
    os.rename(str(failed), str(path))
    fsync_directory(path.parent)


DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_directory(path):
    """Open an absolute directory without following a link in any component."""
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
    except OSError:
        os.close(descriptor)
        raise
    return descriptor


def open_trash(home):
    """Open a private folder of root's beside the server user's home, on its filesystem."""
    parent = open_directory(home.parent)
    try:
        try:
            os.mkdir('.nightstand-trash', 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        trash = os.open('.nightstand-trash', DIRECTORY, dir_fd=parent)
    finally:
        os.close(parent)
    status = os.fstat(trash)
    if status.st_uid != os.geteuid() or stat.S_IMODE(status.st_mode) & 0o077:
        os.close(trash)
        raise ValueError('Unsafe trash folder: ' + str(home.parent / '.nightstand-trash'))
    return trash


def before_removal(path):
    """Test hook between a path's checks and its removal."""


def discard_failed(journal, record):
    """Remove the trees and environments a recovered switch left behind.

    Only paths named for this transaction, or its failed paths, go; a
    companion environment from another transaction stays for a later return.
    Each one is first moved, through folders opened without following links,
    into root's trash folder, so a folder the server user swaps for a link
    cannot redirect the removal. Safe to repeat: the next recovery pass
    finishes a removal cut short.
    """
    kept = {Path(mapping[key]).name for mapping in record['paths'] for key in ('live', 'saved')}
    homes = {Path(mapping['live']).parent for mapping in record['paths']}
    folders = homes | {home / name for home in homes for name in ('free-sleep-envs', 'free-sleep-probes')}
    names = [mapping['failed'] for mapping in record['paths']]
    names += [path for path in journal['backups'] if path.endswith(journal['id'])]
    for name in names:
        path = Path(name)
        if path.name in kept or not os.path.lexists(name):
            continue
        if path.parent not in folders:
            print('Warning: not removing ' + name + ' outside its expected folder', flush=True)
            continue
        home = next(home for home in homes if path.parent in (home, home / path.parent.name))
        moved = path.name + '-' + uuid.uuid4().hex
        try:
            trash = open_trash(home)
            try:
                parent = open_directory(path.parent)
                try:
                    before_removal(path)
                    os.rename(path.name, moved, src_dir_fd=parent, dst_dir_fd=trash)
                finally:
                    os.close(parent)
            finally:
                os.close(trash)
        except (OSError, ValueError) as error:
            print('Warning: could not remove ' + name + ': ' + str(error), flush=True)
    for home in homes:
        # Finish anything a crash left in the trash after its move.
        trash = home.parent / '.nightstand-trash'
        if (trash.is_symlink() or not trash.is_dir() or trash.stat().st_uid != os.geteuid()
                or stat.S_IMODE(trash.stat().st_mode) & 0o077):
            continue
        for entry in trash.iterdir():
            try:
                if entry.is_symlink() or not entry.is_dir():
                    entry.unlink()
                else:
                    shutil.rmtree(str(entry))
            except OSError as error:
                print('Warning: could not remove ' + str(entry) + ': ' + str(error), flush=True)


def finish_committed(store, journal, run_controller=None):
    """Resume idempotent cleanup without reverting a committed installation."""
    run_controller = controller if run_controller is None else run_controller
    if journal['phase'] != 'committed' or 'retainedSlot' not in journal['metadata']:
        return
    record = recovery_record(journal)
    tree = next(item for item in record['paths'] if item['kind'] == 'tree')
    slot = journal['metadata'].get('retainedSlot')
    if slot:
        live, saved = Path(tree['live']), Path(tree['saved'])
        copies = [item['details'] for item in journal['intents'] if item['name'] == 'retained-slot-ready']
        slot_identity = tree
        if copies:
            if len(copies) != 1 or copies[0]['path'] != str(live.parent / ('free-sleep-slot-' + journal['id'])):
                raise ValueError('Invalid retained rollback copy')
            saved = absolute_path(copies[0]['path'])
            slot_identity = copies[0]
        path, retired = absolute_path(slot['path']), absolute_path(slot['retired'])
        if (path != live.parent / 'free-sleep-prev'
                or retired != live.parent / ('free-sleep-prev-retained-' + journal['id'])):
            raise ValueError('Invalid retained rollback slot')
        if not matching(path, slot_identity):
            if not matching(saved, slot_identity):
                raise ValueError('Committed source tree is missing')
            previous = slot.get('previous')
            if os.path.lexists(str(path)):
                if previous is None or not matching(path, previous) or os.path.lexists(str(retired)):
                    raise ValueError('Rollback slot changed before cleanup')
                os.rename(str(path), str(retired))
                fsync_directory(path.parent)
            elif previous is not None and not matching(retired, previous):
                raise ValueError('Previous rollback slot is missing')
            os.rename(str(saved), str(path))
            fsync_directory(path.parent)
    probes = [item['details'] for item in journal['intents'] if item['name'] == 'validation-probe']
    if probes:
        snapshot = journal['snapshots'].get('validation-stream-unit', {})
        expected = Path(journal['metadata']['systemRoot']) / 'etc/systemd/system/free-sleep-stream.service.d/nightstand-validation.conf'
        if (len(probes) != 1 or probes[0].get('path') != str(expected)
                or snapshot.get('path') != str(expected) or snapshot.get('kind') != 'absent'):
            raise ValueError('Invalid validation cleanup path')
        from switch_transaction import validate_snapshot_parent
        validate_snapshot_parent(expected, snapshot)
        if os.path.lexists(str(expected)):
            expected.unlink()
            fsync_directory(expected.parent)
        run_controller('daemon-reload')
    releases = [item['details'] for item in journal['intents'] if item['name'] == 'release-services']
    if releases:
        if len(releases) != 1 or not isinstance(releases[0].get('states'), dict):
            raise ValueError('Invalid committed service states')
        for unit, state in releases[0]['states'].items():
            if (unit not in SERVICES + FORK_CONFIG_UNITS or unit in OPERATIONS
                    or any(type(state.get(key)) is not bool for key in ('active', 'enabled'))):
                raise ValueError('Invalid committed service state')
            if state.get('present') is False:
                continue
            restore_enablement(unit, state, runner=lambda command: run_controller(*command[1:]))
            if state['active'] and unit not in ('free-sleep.service', 'free-sleep-stream.service',
                                              'free-sleep-recover-switch.service'):
                run_controller('start', '--no-block', unit)
    migration_artifacts(store, journal, 'finish')
    store.advance(journal['id'], 'cleaned')


def restore(store, helper):
    pending = [journal for journal in journals(store) if journal['phase'] not in TERMINAL]
    for journal in pending:
        record = recovery_record(journal)
        units = list(WRITERS) + [unit for unit in record['services'] if unit not in WRITERS]
        subprocess.run(['bash', '-c', 'source "$1"; shift; for unit in "$@"; do '
                        'restore_stop_writer "$unit" || exit 1; done',
                        'stop-writers', str(helper)] + units, check=True, timeout=40)
        if journal['phase'] != 'recovering':
            store.intent(journal['id'], 'recovery-start', dict(phase=journal['phase']))
        store.advance(journal['id'], 'recovering')
        restore_paths(journal, record)
        tree = next(mapping for mapping in record['paths'] if mapping['kind'] == 'tree')
        subprocess.run(['bash', '-c', 'set -e; source "$1"; LIVE="$2"; restore_dependencies "$3"',
                        'restore-dependencies', str(helper), tree['live'], tree['failed']], check=True, timeout=40)
        live = Path(tree['live'])
        if (live / 'server/package-lock.json').is_file() and not (live / 'server/node_modules').is_dir():
            raise ValueError('Restored installation has no matching Node dependencies')
        restore_target_slot(journal, record)
        configurations = [item['details'] for item in journal['intents'] if item['name'] == 'system-configuration']
        restored_states = {}
        if configurations:
            if len(configurations) != 1 or configurations[0]['live'] != str(live):
                raise ValueError('Invalid recovery system configuration')
            config = Configuration(absolute_path(configurations[0]['root']), live)
            restored_states = restore_configuration(store, journal['id'], config, release_services=False)
        elif not (journal['phase'] in ('armed', 'writers-stopped') or any(
                item['name'] == 'recovery-start' and item['details'].get('phase') in ('armed', 'writers-stopped')
                for item in journal['intents'])):
            raise ValueError('Missing saved system configuration for switch recovery')
        else:
            store.restore_snapshots(journal['id'])
        migration_artifacts(store, journal, 'restore')
        controller('daemon-reload')
        for unit, state in record['services'].items():
            restored_states.setdefault(unit, {}).update(state)
        starts = []
        for unit, state in restored_states.items():
            if state.get('present') is False:
                continue
            restore_enablement(unit, state, runner=lambda command: controller(*command[1:]))
            if state['active'] and unit not in OPERATIONS + ('free-sleep-recover-switch.service',):
                starts.append(unit)
        store.advance(journal['id'], 'recovered')
        for unit in starts:
            controller('start', '--no-block', unit)
        # Nonblocking starts wait for this oneshot to exit. Stopping writers
        # may have cancelled their initial boot jobs, so explicitly queue them.
        print('Restored the source installation offline: ' + journal['id'])
    for journal in journals(store):
        if journal['phase'] == 'recovered':
            discard_failed(journal, recovery_record(journal))
        finish_committed(store, journal)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('command', choices=('check', 'startup-check', 'stop-operations', 'restore', 'pending', 'operation-active',
                                            'cleanup'))
    parser.add_argument('--helper', type=Path)
    parser.add_argument('--unit')
    parser.add_argument('--operation-lock', type=Path)
    args = parser.parse_args()
    try:
        store = TransactionStore(args.root)
        if args.command == 'operation-active':
            if not operation_active(store, args.operation_lock):
                parser.exit(1)
        elif args.command == 'startup-check':
            check_startup(store, args.unit, args.operation_lock)
        elif args.command in ('check', 'pending'):
            pending = [journal for journal in journals(store) if journal['phase'] not in TERMINAL]
            if args.command == 'pending':
                for journal in pending:
                    print(journal['id'])
            elif pending or any(journal['phase'] == 'committed' and 'retainedSlot' in journal['metadata'] for journal in journals(store)):
                raise ValueError('An unfinished switch blocks writer startup')
        elif args.command == 'stop-operations':
            stop_operations(store)
        elif args.command == 'cleanup':
            for journal in journals(store):
                if journal['phase'] == 'recovered':
                    discard_failed(journal, recovery_record(journal))
        else:
            if args.helper is None:
                raise ValueError('Missing restore helper')
            restore(store, args.helper)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Switch recovery stopped: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
