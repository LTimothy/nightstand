#!/usr/bin/env python3
"""Compose offline cross-fork installation steps under the maintenance lock.

Only confirmed V2 switches enter the forward path. Return and cross-fork
rollback require a retained source journal with intact companion state. The
SQLite database and weekly schedule are never replaced on a successful return.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

import recover_switch
import switch_services
from prepare_upstream_env import prepare, flush_environment, allocated_bytes, HEADROOM_BYTES, owned_directory, current_user
from switch_transaction import (TransactionStore, DEFAULT_ROOT, absolute_path, digest,
                                fsync_directory, publish, read_regular, validate_snapshot_parent)
from tree_digest import _dir_entries, tree_digest
from upstream_target import validate_target
import upstream_readiness

HERE = Path(__file__).resolve().parent
PROBE_SOURCE = (HERE / 'upstream_stream_probe.py').read_bytes()
spec = importlib.util.spec_from_file_location('prepare_upstream', HERE / 'prepare-upstream.py')
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)


def fork(path, store=None):
    path = absolute_path(str(path))
    info = json.loads(read_regular(path / 'server/src/serverInfo.json'))
    repository = info.get('fork')
    if repository == 'LTimothy/nightstand':
        return 'nightstand'
    if isinstance(repository, str) and repository:
        return 'upstream'
    if repository is not None:
        raise ValueError('Unrecognized cross-fork installation')
    # Early Nightstand releases omitted fork. Only recorded trees prove otherwise.
    if store is not None:
        for journal in recover_switch.journals(store):
            if journal['phase'] not in ('committed', 'cleaned'):
                continue
            tree = next(item for item in recover_switch.recovery_record(journal)['paths'] if item['kind'] == 'tree')
            copies = [item['details'] for item in journal['intents'] if item['name'] == 'retained-slot-ready']
            if (recover_switch.matching(path, tree) or any(recover_switch.matching(path, item) for item in copies)):
                if code_digest(path) != journal['source']['treeSha256']:
                    raise ValueError('Recorded source tree checksum mismatch')
                return journal['source']['fork']
            if str(path) == tree['live'] and code_digest(path) == journal['target']['treeSha256']:
                return journal['target']['fork']
    return 'nightstand'


def code_digest(path):
    # Installed dependencies and mutable local data are not release code.
    entries = ((name, checksum) for name, checksum in _dir_entries(path)
               if not any(part in (b'node_modules', b'.git', b'free-sleep-data', b'__pycache__')
                          for part in name.split(b'/')))
    return tree_digest(entries)


def artifact_digest(path):
    # The shell checked the download before npm ci added server/node_modules.
    return tree_digest(entry for entry in _dir_entries(path) if not entry[0].startswith(b'server/node_modules/'))


def identity(path, commit=None, store=None, known_fork=None):
    path = absolute_path(str(path))
    checksum = code_digest(path)
    info = json.loads(read_regular(path / 'server/src/serverInfo.json'))
    # Installed archives do not carry git objects. Zero means no commit was
    # recorded; the observed tree checksum and inode identify that source.
    return dict(fork=known_fork or fork(path, store), version=info['version'], commit=commit or '0' * 40,
                treeSha256=checksum, treePath=str(path))


def mapping(kind, live, saved, failed):
    record = dict(kind=kind, live=str(live), saved=str(saved), failed=str(failed),
                  realParents={key: str(path.parent.resolve())
                               for key, path in [('live', live), ('saved', saved), ('failed', failed)]})
    if kind == 'environment' and not os.path.lexists(str(live)):
        record['absent'] = True
    else:
        status = live.lstat()
        record.update(device=status.st_dev, inode=status.st_ino)
    return record


def move(source, destination):
    if os.path.lexists(str(destination)):
        raise ValueError('Refusing to replace retained path: ' + str(destination))
    os.rename(str(source), str(destination))
    fsync_directory(source.parent)
    fsync_directory(destination.parent)


def retained_tree(journal):
    record = recover_switch.recovery_record(journal)
    tree = next(item for item in record['paths'] if item['kind'] == 'tree')
    choices = [Path(tree['saved'])]
    slot = journal['metadata'].get('retainedSlot')
    if slot:
        choices.append(absolute_path(slot['path']))
        choices.append(absolute_path(slot['retired']))
    # A subsequent committed operation can retire this slot under another name.
    choices.extend(Path(tree['live']).parent.glob('free-sleep-prev-retained-*'))
    found = [path for path in choices if recover_switch.matching(path, tree)]
    if not found:
        raise ValueError('Retained source tree is missing')
    path = found[0]
    if path.is_symlink() or code_digest(path) != journal['source']['treeSha256']:
        raise ValueError('Retained source code checksum mismatch')
    return path


def companion_environment(journal):
    mappings = [item for item in recover_switch.recovery_record(journal)['paths'] if item['kind'] == 'environment']
    if len(mappings) != 1:
        raise ValueError('Retained Python environment is missing')
    item = mappings[0]
    saved = absolute_path(item['saved'])
    if item.get('absent'):
        if os.path.lexists(str(saved)):
            raise ValueError('Absent retained Python environment has been replaced')
        return None
    if not recover_switch.matching(saved, item) or not (saved / 'bin/python').is_file():
        raise ValueError('Retained Python environment is missing or changed')
    return saved.resolve()


def companion(store, transaction):
    journal = store.load(transaction)
    if journal['phase'] not in ('committed', 'cleaned'):
        raise ValueError('Companion state requires a committed source installation')
    retained_tree(journal)
    environment = companion_environment(journal)
    config = switch_services.Configuration(
        journal['metadata']['systemRoot'], journal['source']['treePath'])
    switch_services.record(store, transaction, config)
    selected = {name: item for name, item in journal['snapshots'].items()
                if name.startswith('system-file-') or name.startswith('baseline-')}
    if not {'baseline-left', 'baseline-right'} <= selected.keys():
        raise ValueError('Companion calibration records are incomplete')
    for item in selected.values():
        path = absolute_path(item['path'])
        validate_snapshot_parent(path, item)
        if item['kind'] == 'file':
            backup = store.directory(transaction) / item['backup']
            if backup.is_symlink() or digest(backup.read_bytes()) != item['sha256']:
                raise ValueError('Companion snapshot checksum mismatch')
        elif item['kind'] == 'symlink':
            raise ValueError('Companion configuration symlinks require manual restoration')
    return journal, environment, selected



def transaction_id():
    return 'switch-' + uuid.uuid4().hex


def return_companion(store, live):
    live = absolute_path(str(live))
    candidates = [journal for journal in recover_switch.journals(store)
                  if journal['phase'] in ('committed', 'cleaned')
                  and journal['source']['fork'] == 'nightstand' and journal['target']['fork'] == 'upstream'
                  and journal['source']['treePath'] == str(live)
                  and 'confirmedTarget' in journal['metadata']]
    if not candidates:
        return None
    for journal in candidates:
        if type(journal['metadata'].get('generation')) is not int or journal['metadata']['generation'] < 1:
            raise ValueError('Retained transaction has no durable ordering')
    newest = max(journal['metadata']['generation'] for journal in candidates)
    selected = [journal for journal in candidates if journal['metadata']['generation'] == newest]
    if len(selected) != 1:
        raise ValueError('Retained transactions have ambiguous ordering')
    try:
        companion(store, selected[0]['id'])
    except ValueError as error:
        # Without the retained tree the ordinary migration installs the release fresh.
        print('Warning: ' + str(error) + '; returning with a fresh install instead', file=sys.stderr, flush=True)
        return None
    return selected[0]['id']


def companion_records(store, path):
    """Find published records identifying this retained tree, regardless of its fork label."""
    path = absolute_path(str(path))
    matches = []
    for journal in recover_switch.journals(store):
        if journal['phase'] not in ('committed', 'cleaned'):
            continue
        record = recover_switch.recovery_record(journal)
        tree = next(item for item in record['paths'] if item['kind'] == 'tree')
        slots = [item['details'] for item in journal['intents'] if item['name'] == 'retained-slot-ready']
        if recover_switch.matching(path, tree) or any(recover_switch.matching(path, slot) for slot in slots):
            matches.append(journal)
    return matches


def find_companion(store, path):
    path = absolute_path(str(path))
    matches = companion_records(store, path)
    if len(matches) != 1:
        raise ValueError('Cross-fork rollback has no complete matching companion state')
    journal = matches[0]
    if code_digest(path) != journal['source']['treeSha256']:
        raise ValueError('Retained rollback code checksum mismatch')
    companion(store, journal['id'])
    return journal['id']


def activate_companion(store, transaction, retained, config):
    journal, environment, selected = companion(store, retained)
    if journal['metadata']['systemRoot'] != str(config.root) or journal['source']['treePath'] != str(config.live):
        raise ValueError('Companion configuration belongs to another installation')
    store.intent(transaction, 'activate-companion', dict(retained=retained))
    for item in selected.values():
        path = Path(item['path'])
        validate_snapshot_parent(path, item)
        if item['kind'] == 'absent':
            switch_services.remove(path)
        else:
            publish(path, (store.directory(retained) / item['backup']).read_bytes(), item)
    return environment


class System:
    def __init__(self):
        self.live = Path('/home/dac/free-sleep')
        self.data = Path('/persistent/free-sleep-data/lowdb')
        self.venv = Path('/home/dac/venv')
        self.store = TransactionStore(os.environ.get('NIGHTSTAND_TRANSACTION_ROOT', str(DEFAULT_ROOT)))
        self.config = switch_services.Configuration(Path('/'), self.live)
        self.probe_user = 'dac'

    def controller(self, *arguments):
        return recover_switch.controller(*arguments)

    def arm_recovery(self, stage):
        # Root runs only the root-owned copy this runner started from.
        subprocess.run(['bash', str(HERE / 'close_update_window.sh')], check=True, timeout=60)
        subprocess.run(['bash', str(HERE / 'setup_services.sh'), str(HERE.parent), '--recovery-only'],
                       check=True, timeout=60)

    def operation(self, unit):
        invocation = self.controller('show', '--property=InvocationID', '--value', unit)
        if (unit not in recover_switch.OPERATIONS or re.fullmatch(r'[0-9a-f]{32}', invocation) is None
                or self.controller('show', '--property=ActiveState', '--value', unit) not in ('active', 'activating')
                or invocation != os.environ.get('INVOCATION_ID')):
            raise ValueError('Cross-fork transactions require a dedicated running systemd operation')
        return dict(unit=unit, invocationId=invocation)

    def services(self):
        result = {}
        for unit in recover_switch.SERVICES:
            text = self.controller('show', '--property=LoadState,ActiveState,UnitFileState', unit)
            values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
            mode = values.get('UnitFileState', 'disabled')
            enabled = mode in ('enabled', 'enabled-runtime')
            result[unit] = dict(active=values.get('ActiveState') in ('active', 'activating', 'reloading'),
                                enabled=enabled, enabledMode=mode if enabled else 'disabled',
                                present=values.get('LoadState') != 'not-found')
        return result

    def biometrics(self):
        enabled = json.loads(read_regular(self.data / 'servicesDB.json'))['biometrics']['enabled']
        if type(enabled) is not bool:
            raise ValueError('Stored biometrics choice is not a boolean')
        return enabled

    def stop(self):
        units = [unit for unit in recover_switch.SERVICES if unit.endswith('.timer')]
        units += [unit for unit in recover_switch.SERVICES if not unit.endswith('.timer')]
        subprocess.run(['bash', '-c', 'set -e; source "$1"; shift; '
                        'for unit in "$@"; do restore_stop_writer "$unit"; done',
                        'stop-writers', str(HERE / 'restore_helpers.sh')] + units, check=True, timeout=60)
        # The server can start the stream until its own stop completes.
        subprocess.run(['bash', '-c', 'source "$1"; restore_stop_writer free-sleep-stream.service',
                        'stop-late-stream', str(HERE / 'restore_helpers.sh')], check=True, timeout=30)
        state = subprocess.run(['systemctl', 'is-active', 'free-sleep-stream.service'],
                               capture_output=True, text=True, timeout=20).stdout.strip()
        if state not in ('inactive', 'failed', 'unknown'):
            raise ValueError('Stream did not stop')

    def recheck(self):
        if getattr(self, 'recheck_in_use', False):
            reasons = upstream_readiness.http_json('update/in-use')['reasons']
            if not isinstance(reasons, list) or reasons:
                raise ValueError('The bed may be in use; transaction cancelled before stopping writers')

    def handoff(self, reason):
        try:
            subprocess.run(['curl', '-fsS', '--max-time', '60', '-X', 'POST', '-H',
                            'content-type: application/json', '-d', json.dumps(dict(reason=reason)),
                            'http://127.0.0.1:3000/api/update/prepare-to-stop'], check=True, timeout=65,
                           stdout=subprocess.DEVNULL)
        except subprocess.SubprocessError:
            print('Warning: the server could not prepare to stop; firmware timers remain the backstop', flush=True)

    def prepare_environment(self, stage, transaction, direction):
        return prepare(stage, Path('/home/dac/free-sleep-envs'), transaction, self.venv, 'python3', 'dac', 600, direction=direction)

    def clean_foreign(self, transaction, stage):
        source = HERE / 'migrate/fork-artifacts.sh'
        if not source.is_file():
            raise ValueError('Migration artifact helper is missing')
        script = self.store.directory(transaction) / 'migration-artifacts.sh'
        data = source.read_bytes()
        publish(script, data)
        self.store.intent(transaction, 'migration-artifacts', dict(path=str(script), sha256=digest(data)))
        subprocess.run(['bash', str(script), 'clean', os.environ.get('NIGHTSTAND_MIGRATION_CLEANUP', 'no')],
                       check=True, timeout=60)

    def migrate_database(self):
        subprocess.run(['sudo', '-u', 'dac', 'bash', '-c',
                        'cd "$1/server" && /home/dac/.volta/bin/npx dotenv -e .env.pod -- npx prisma migrate deploy '
                        '&& /home/dac/.volta/bin/npx dotenv -e .env.pod -- npx prisma generate',
                        'migrate', str(self.live)], check=True, timeout=300)

    def validate(self, version, enabled, token, probe):
        upstream_readiness.wait_ready(upstream_readiness.Readiness(version, enabled, token),
                                     lambda: upstream_readiness.sample_system(probe, enabled))


def install(system, stage, target=None, retained=None, operation='free-sleep-revert.service'):
    """Arm before stopping writers, commit after sustained target validation."""
    store, live, stage = system.store, system.live, absolute_path(str(stage))
    if any(journal['phase'] not in recover_switch.TERMINAL for journal in recover_switch.journals(store)):
        raise ValueError('An unfinished transaction requires recovery first')
    if (live.is_symlink() or stage.is_symlink() or not live.is_dir() or not stage.is_dir()
            or live in stage.parents or stage in live.parents):
        raise ValueError('Invalid or overlapping installation trees')
    if target is not None:
        target = validate_target(target)
    source = identity(live, store=store)
    destination = identity(stage, store=store, known_fork='upstream' if target is not None else None)
    if source['fork'] == destination['fork']:
        raise ValueError('Same-fork operations use the ordinary updater and rollback')
    transaction = transaction_id()
    if retained:
        prior, prepared, _ = companion(store, retained)
        if prior['source']['fork'] != destination['fork']:
            raise ValueError('Retained companion belongs to another fork')
    else:
        if target is not None:
            target = validate_target(target)
            if destination['version'] != target['version']:
                raise ValueError('Staged version differs from confirmed target')
            destination['commit'] = target['commit']
        prepared = system.prepare_environment(stage, transaction, destination['fork'])
    required = allocated_bytes(live) + allocated_bytes(stage) + HEADROOM_BYTES
    if shutil.disk_usage(live.parent).free < required:
        raise ValueError('Insufficient space for retained code, dependencies and rollback copy')
    if retained and not (stage / 'server/node_modules').is_dir():
        original = retained_tree(prior)
        modules = original / 'server/node_modules'
        if (not modules.is_dir() or read_regular(original / 'server/package-lock.json')
                != read_regular(stage / 'server/package-lock.json')):
            raise ValueError('Retained Node dependencies do not match the target')
        shutil.copytree(modules, stage / 'server/node_modules', symlinks=True)
    enabled = system.biometrics()
    if type(enabled) is not bool:
        raise ValueError('Biometrics choice must be explicit')
    state = system.services()
    invocation = system.operation(operation)
    system.arm_recovery(stage)
    if hasattr(system, 'recheck'):
        system.recheck()
    saved = live.parent / ('free-sleep-retained-' + transaction)
    failed = live.parent / ('free-sleep-failed-' + transaction)
    paths = [mapping('tree', live, saved, failed)]
    if enabled and (not os.path.lexists(str(system.venv)) or prepared is None):
        raise ValueError('Enabled biometrics requires a Python environment')
    paths.append(mapping('environment', system.venv,
                         system.venv.parent / ('venv-retained-' + transaction),
                         system.venv.parent / ('venv-failed-' + transaction)))
    previous = live.parent / 'free-sleep-prev'
    slot = dict(path=str(previous), retired=str(live.parent / ('free-sleep-prev-retained-' + transaction)))
    if os.path.lexists(str(previous)) and stage != previous:
        if previous.is_symlink() or not previous.is_dir():
            raise ValueError('Invalid existing rollback slot')
        slot['previous'] = dict(device=previous.stat().st_dev, inode=previous.stat().st_ino)
    metadata = dict(recovery=dict(paths=paths, services=state, operation=invocation),
                    systemRoot=str(system.config.root), retainedSlot=slot, biometrics=enabled,
                    generation=1 + max([journal['metadata'].get('generation', 0)
                                        for journal in recover_switch.journals(store)] or [0]))
    if target is not None:
        metadata['confirmedTarget'] = target
    if stage == previous:
        metadata['targetSlot'] = dict(path=str(stage), device=stage.stat().st_dev, inode=stage.stat().st_ino)
    store.create(transaction, source, destination, metadata)
    for path in (saved, paths[1]['saved'], prepared):
        if path is not None:
            store.add_backup(transaction, path)
    if operation == 'free-sleep-migrate.service' and hasattr(system, 'clean_foreign'):
        system.clean_foreign(transaction, stage)
    system.handoff('revert' if destination['fork'] == 'upstream' else 'rollback')
    system.stop()
    store.advance(transaction, 'writers-stopped')
    # The server user could write the stage until its writers stopped.
    if target is not None and artifact_digest(stage) != target['treeSha256']:
        raise ValueError('Staged tree differs from the confirmed artifact')
    # Record absence for known watched files, plus any other stopped settings.
    names = {'settingsDB.json', 'schedulesDB.json', 'servicesDB.json'}
    names.update(path.name for path in system.data.iterdir() if path.is_file() or path.is_symlink())
    for index, name in enumerate(sorted(names - {'left_cap_baseline.json', 'right_cap_baseline.json'})):
        store.snapshot(transaction, 'settings-' + str(index), system.data / name)
    calibration.snapshot_baselines(store, transaction, system.data)
    switch_services.snapshot(store, transaction, system.config)
    override = system.config.systemd / 'free-sleep-stream.service.d/nightstand-validation.conf'
    if os.path.lexists(str(override)):
        raise ValueError('A previous stream validation override requires recovery')
    store.snapshot(transaction, 'validation-stream-unit', override)
    store.advance(transaction, 'snapshots-ready')
    store.advance(transaction, 'installing')
    if retained:
        activate_companion(store, transaction, retained, system.config)
    else:
        calibration.quarantine_baselines(store, transaction, system.data)
    if destination['fork'] == 'upstream':
        store.intent(transaction, 'convert-settings', {})
        calibration.prepare(system.data)
    store.intent(transaction, 'save-tree', {})
    move(live, saved)
    store.intent(transaction, 'publish-tree', {})
    move(stage, live)
    if not (live / 'server/node_modules').is_dir():
        if ((saved / 'server/node_modules').is_dir()
                and read_regular(saved / 'server/package-lock.json') == read_regular(live / 'server/package-lock.json')):
            store.intent(transaction, 'copy-dependencies', {})
            shutil.copytree(saved / 'server/node_modules', live / 'server/node_modules', symlinks=True)
        else:
            raise ValueError('Target has no matching installed Node dependencies')
    store.intent(transaction, 'save-environment', {})
    if not paths[1].get('absent'):
        move(system.venv, Path(paths[1]['saved']))
    store.intent(transaction, 'publish-environment', dict(path=str(prepared) if prepared is not None else None))
    if prepared is not None:
        system.venv.symlink_to(prepared)
        fsync_directory(system.venv.parent)
    switch_services.apply(store, transaction, system.config, destination['fork'])
    if retained:
        _, captured = switch_services.record(store, retained, system.config)
        switch_services.restore_firewall(store, retained, captured)
        # The policy script also saves its rules. Restore the retained files so
        # disk and runtime describe the same custom firewall after a reboot.
        for item in prior['snapshots'].values():
            if item['path'] in {str(path) for path in system.config.firewall_files}:
                path = Path(item['path'])
                if item['kind'] == 'absent':
                    switch_services.remove(path)
                else:
                    publish(path, (store.directory(retained) / item['backup']).read_bytes(), item)
        operational = {unit: state for unit, state in captured['states'].items()
                       if unit not in recover_switch.OPERATIONS + ('free-sleep-recover-switch.service',)}
        if destination['fork'] == 'upstream':
            operational = {unit: state for unit, state in operational.items() if unit not in switch_services.FORK_UNITS}
        operational.pop('free-sleep.service', None)
        operational['free-sleep-stream.service'] = dict(active=enabled, enabled=enabled, present=enabled)
        store.intent(transaction, 'release-services', dict(states=operational))
    elif destination['fork'] == 'nightstand':
        store.intent(transaction, 'release-services', dict(states={
            'free-sleep-archive-raw.timer': dict(active=True, enabled=True, present=True)}))

    if destination['fork'] == 'nightstand':
        store.intent(transaction, 'additive-migrations', {})
        system.migrate_database()
    token = uuid.uuid4().hex
    probe_directory = live.parent / 'free-sleep-probes' / transaction
    probe = probe_directory / ('nightstand-probe-' + token + '.json')
    if enabled:
        store.add_backup(transaction, probe_directory)
        store.intent(transaction, 'prepare-probe', dict(path=str(probe_directory)))
        owned_directory(probe_directory, getattr(system, 'probe_user', current_user()), exclusive=True)
        wrapper = probe_directory / 'nightstand_stream_probe.py'
        switch_services.write(wrapper, PROBE_SOURCE)
        # The stream writes validation evidence in its own directory.
        content = ('[Service]\nExecStart=\nExecStart=' + str(system.venv / 'bin/python')
                   + ' -B ' + str(wrapper) + ' --tree ' + str(live)
                   + ' --output ' + str(probe) + ' --launch-token ' + token + '\n')
        store.intent(transaction, 'validation-probe', dict(path=str(override)))
        switch_services.write(override, content.encode())
        system.controller('daemon-reload')
    # Flush the target code and any generated client before committing it.
    flush_environment(live)
    store.advance(transaction, 'validating')
    store.intent(transaction, 'validation-startup', dict(units=['free-sleep.service']
                 + (['free-sleep-stream.service'] if enabled else [])))
    system.controller('start', 'free-sleep.service')
    if enabled:
        system.controller('start', 'free-sleep-stream.service')
    system.validate(destination['version'], enabled, token, probe)
    if destination['fork'] == 'upstream':
        switch_services.verify_updater(system.config)
    # Snapshot the observed retained code after dependencies have moved away.
    if code_digest(saved) != source['treeSha256']:
        raise ValueError('Retained source code changed during the transaction')
    # Upstream updates may delete their rollback slot. Keep the authoritative
    # source separately and publish a dependency-free rollback copy.
    clone = live.parent / ('free-sleep-slot-' + transaction)
    store.add_backup(transaction, clone)
    store.intent(transaction, 'copy-retained-slot', dict(path=str(clone)))
    shutil.copytree(saved, clone, symlinks=True,
                    ignore=shutil.ignore_patterns('node_modules', '__pycache__', '.git', 'free-sleep-data'))
    flush_environment(clone)
    if code_digest(clone) != source['treeSha256']:
        raise ValueError('Retained rollback copy checksum mismatch')
    status = clone.stat()
    store.intent(transaction, 'retained-slot-ready', dict(path=str(clone), device=status.st_dev, inode=status.st_ino))
    store.advance(transaction, 'committed')
    recover_switch.finish_committed(store, store.load(transaction), system.controller)
    return transaction


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('forward', 'return', 'rollback', 'companion', 'return-companion',
                                           'companion-recorded', 'fork'))
    parser.add_argument('--stage', type=Path)
    parser.add_argument('--target-json')
    parser.add_argument('--retained')
    parser.add_argument('--artifact-digest')
    parser.add_argument('--recheck-in-use', choices=('yes', 'no'), default='no')
    args = parser.parse_args()
    try:
        system = System()
        system.recheck_in_use = args.recheck_in_use == 'yes'
        if args.command == 'fork':
            print(fork(args.stage, system.store))
            return
        if args.command == 'companion':
            print(find_companion(system.store, args.stage))
            return
        if args.command == 'companion-recorded':
            print('yes' if companion_records(system.store, args.stage) else 'no')
            return
        if args.command == 'return-companion':
            selected = return_companion(system.store, system.live)
            if selected is None:
                parser.exit(2, 'No retained Nightstand companion state\n')
            print(selected)
            return
        lock_path = os.environ.get('NIGHTSTAND_OPERATION_LOCK', '/run/lock/free-sleep-operation.lock')
        if not Path('/run/lock').is_dir() and 'NIGHTSTAND_OPERATION_LOCK' not in os.environ:
            lock_path = '/tmp/free-sleep-operation.lock'
        # The shell hands off descriptor 9 without releasing its held inode.
        inherited = False
        try:
            inherited = os.fstat(9).st_ino == os.stat(lock_path).st_ino and os.fstat(9).st_dev == os.stat(lock_path).st_dev
        except OSError:
            pass
        descriptor = 9 if inherited else os.open(lock_path, os.O_RDONLY if Path(lock_path).exists() else os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = json.loads(args.target_json) if args.target_json else None
        if args.command == 'forward':
            if target is None or args.artifact_digest != validate_target(target)['treeSha256']:
                raise ValueError('Forward transaction requires a verified confirmed V2 artifact')
        unit = {'forward': 'free-sleep-revert.service', 'return': 'free-sleep-migrate.service',
                'rollback': 'free-sleep-rollback.service'}[args.command]
        retained = args.retained or (find_companion(system.store, args.stage) if args.command == 'rollback' else None)
        prior_ids = {journal['id'] for journal in recover_switch.journals(system.store)}
        try:
            print(install(system, args.stage, target=target, retained=retained, operation=unit))
        except Exception as error:
            # Any failure, not only expected ones, restores the source in process.
            pending = any(journal['phase'] not in recover_switch.TERMINAL for journal in recover_switch.journals(system.store))
            committed = [journal['id'] for journal in recover_switch.journals(system.store)
                         if journal['id'] not in prior_ids and journal['phase'] in ('committed', 'cleaned')]
            recover_switch.restore(system.store, Path('/usr/local/lib/nightstand/switch-recovery/restore_helpers.sh'))
            if len(committed) == 1 and system.store.load(committed[0])['phase'] == 'cleaned':
                print(committed[0])
                return
            if pending:
                parser.exit(3, 'Cross-fork installation failed; source restored: ' + str(error) + '\n')
            raise
    except Exception as error:
        parser.exit(1, 'Cross-fork installation stopped: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
