#!/usr/bin/env python3
"""Journal system configuration before reconciling a stopped installation.

Call snapshot in writers-stopped, then apply in installing. Capture original
service states in metadata.recovery.services before stopping writers. On failure,
restore runs offline in recovering, before any service restart. The forward and
return callers must keep the maintenance operation lock throughout these steps.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

import system_scripts
from switch_transaction import TransactionStore, digest, durable_directory, fsync_directory, publish, read_regular

FORK_UNITS = tuple('free-sleep-' + name + suffix for name, suffixes in (
    ('rollback', ('.service',)), ('revert', ('.service',)),
    ('archive-raw', ('.service', '.timer')), ('health', ('.service', '.timer')),
    ('network-watchdog', ('.service', '.timer')), ('recover-update', ('.service', '.timer')))
    for suffix in suffixes)
CONFIG_UNITS = FORK_UNITS + ('free-sleep-recover-switch.service', 'free-sleep.service', 'free-sleep-stream.service')


def execute(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, text=True,
                          timeout=30, **kwargs).stdout


class Configuration:
    def __init__(self, root=Path('/'), live=Path('/home/dac/free-sleep')):
        self.root = Path(root).absolute()
        self.live = Path(live).absolute()
        self.system = self.root / 'usr/local/lib/nightstand'
        self.systemd = self.root / 'etc/systemd/system'
        self.maintenance = self.root / 'persistent/free-sleep-maintenance'
        self.guard = self.maintenance / 'update_service.sh'
        self.sudoers = self.root / 'etc/sudoers.d/dac'
        self.watchdog = self.root / 'etc/systemd/system.conf.d/10-nightstand-watchdog.conf'
        self.firewall_files = tuple(self.root / ('etc/iptables/' + name)
                                    for name in ('iptables.rules', 'ip6tables.rules'))

    def files(self):
        paths = [self.systemd / name for name in FORK_UNITS]
        paths += [self.systemd / 'free-sleep-update.service',
                  self.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf',
                  self.guard, self.maintenance / 'sqlite_maintenance.py', self.sudoers,
                  self.watchdog, self.root / 'run/systemd/system.conf.d/10-nightstand-watchdog.conf',
                  self.root / 'persistent/free-sleep-data/watchdog-trial',
                  self.root / 'etc/systemd/timesyncd.conf',
                  self.root / 'etc/tmpfiles.d/free-sleep-operation.conf'] + list(self.firewall_files)
        paths += [self.system / ('recovery/' + name)
                  for name in ('recover_update.sh', 'restore_helpers.sh')]
        paths += [self.systemd / 'free-sleep.service.d/10-nightstand-limits.conf',
                  self.systemd / 'free-sleep.service.d/20-nightstand-restart.conf',
                  self.systemd / 'free-sleep-stream.service.d/10-nightstand-limits.conf']
        paths += [self.systemd / 'free-sleep.service', self.systemd / 'free-sleep-stream.service']
        return paths


def snapshot(store, transaction, config):
    journal = store.load(transaction)
    if journal['phase'] != 'writers-stopped':
        raise ValueError('Configuration snapshots require stopped writers')
    if any(item['name'] == 'system-configuration' for item in journal['intents']):
        raise ValueError('Configuration already captured')
    states = {}
    original = journal['metadata'].get('recovery', {}).get('services', {})
    for unit in CONFIG_UNITS:
        output = execute(['systemctl', 'show', '--property=LoadState,ActiveState,UnitFileState', unit])
        values = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        state = dict(active=values.get('ActiveState') == 'active',
                     enabled=values.get('UnitFileState') in ('enabled', 'enabled-runtime'))
        state['enabledMode'] = values.get('UnitFileState') if state['enabled'] else 'disabled'
        restored = dict(state, **original.get(unit, {}))
        if (unit in original and 'enabledMode' not in original[unit]
                and original[unit]['enabled'] != state['enabled']):
            restored['enabledMode'] = 'enabled' if restored['enabled'] else 'disabled'
        states[unit] = dict(restored, present=values.get('LoadState') != 'not-found')
    for index, path in enumerate(config.files()):
        name = 'system-file-' + str(index)
        if name not in journal['snapshots']:
            store.snapshot(transaction, name, path)
        elif journal['snapshots'][name]['path'] != str(path):
            raise ValueError('Configuration snapshot path changed')
    firewall = []
    for command in ('iptables-save', 'ip6tables-save'):
        content = execute([command])
        path = store.directory(transaction) / (command + '.rules')
        publish(path, content.encode())
        firewall.append(dict(path=str(path), sha256=hashlib.sha256(content.encode()).hexdigest()))
    store.intent(transaction, 'system-configuration', dict(
        root=str(config.root), live=str(config.live), states=states, firewall=firewall))


def record(store, transaction, config):
    journal = store.load(transaction)
    matches = [item['details'] for item in journal['intents'] if item['name'] == 'system-configuration']
    if len(matches) != 1 or matches[0]['root'] != str(config.root) or matches[0]['live'] != str(config.live):
        raise ValueError('Missing or mismatched system configuration snapshot')
    for index, path in enumerate(config.files()):
        if journal['snapshots'].get('system-file-' + str(index), {}).get('path') != str(path):
            raise ValueError('Missing system file snapshot')
    return journal, matches[0]


def write(path, content, mode=0o644):
    durable_directory(path.parent)
    publish(path, content, dict(uid=os.geteuid(), gid=os.getegid(), mode=mode,
                              atimeNs=0, mtimeNs=0))


def remove(path):
    if path.is_dir() and not path.is_symlink():
        raise ValueError('Refusing to remove a configuration directory')
    if os.path.lexists(str(path)):
        path.unlink()
        fsync_directory(path.parent)


def verify_updater(config):
    start = execute(['systemctl', 'show', '--property=ExecStart', '--value', 'free-sleep-update.service'])
    hook = execute(['systemctl', 'show', '--property=ExecStopPost', '--value', 'free-sleep-update.service'])
    executables = re.findall(r'path=([^ ;}]+)', start)
    arguments = re.findall(r'argv\[\]=(.*?)\s*;', start)
    if (executables != ['/bin/bash'] or len(arguments) != 1
            or shlex.split(arguments[0]) != ['/bin/bash', str(config.guard)]
            or not os.access(config.guard, os.X_OK) or not (config.maintenance / 'sqlite_maintenance.py').is_file()
            or hook):
        raise ValueError('Effective upstream updater has an invalid executable or stop hook')


def nightstand_scripts(config):
    """Root-owned scripts for the Nightstand tree at config.live, never the tree."""
    try:
        copy = config.system / 'copies' / system_scripts.digest(str(config.live))
    except (SystemExit, OSError):
        copy = None
    return (copy if copy and copy.is_dir() else config.system / 'live') / 'scripts'


PINNED = ('update_service.sh', 'sqlite_maintenance.py', 'block_internet_access.sh')


def pin_scripts(store, transaction, checksums):
    """Record the checked content of the upstream files root later uses."""
    if any('scripts/' + name not in checksums for name in PINNED):
        raise ValueError('Staged upstream tree lacks a script root needs')
    store.intent(transaction, 'pinned-scripts', {name: checksums['scripts/' + name] for name in PINNED})


def pinned(journal, config, name):
    # The server user can replace the live tree after the check; use only the checked bytes.
    records = [item['details'] for item in journal['intents'] if item['name'] == 'pinned-scripts']
    if len(records) != 1 or not isinstance(records[0], dict) or name not in records[0]:
        raise ValueError('Upstream scripts were not pinned at the checksum check')
    data = read_regular(config.live / 'scripts' / name)
    if digest(data) != records[0][name]:
        raise ValueError('Upstream ' + name + ' changed after its checksum check')
    return data


def apply(store, transaction, config, direction):
    journal, captured = record(store, transaction, config)
    if journal['phase'] != 'installing' or direction not in ('upstream', 'nightstand'):
        raise ValueError('Reconciliation requires an installing transaction and known fork')
    store.intent(transaction, 'reconcile-system', dict(direction=direction))
    if direction == 'nightstand':
        scripts = nightstand_scripts(config)
        remove(config.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf')
        environment = dict(os.environ, NIGHTSTAND_SYSTEMD_DIR=str(config.systemd),
                           NIGHTSTAND_SYSTEM_DIR=str(config.system),
                           NIGHTSTAND_SUDOERS_FILE=str(config.sudoers),
                           NIGHTSTAND_TMPFILES_DIR=str(config.root / 'etc/tmpfiles.d'),
                           NIGHTSTAND_RECOVERY_DIR=str(config.system / 'recovery'),
                           NIGHTSTAND_SWITCH_RECOVERY_DIR=str(config.system / 'switch-recovery'),
                           NIGHTSTAND_TRANSACTION_ROOT=str(store.root))
        execute(['bash', str(scripts / 'setup_services.sh'), str(scripts.parent)], env=environment)
        for unit in ('free-sleep-archive-raw.service', 'free-sleep-archive-raw.timer'):
            source = scripts / 'systemd' / unit
            if source.is_file():
                write(config.systemd / unit, read_regular(source))
        limits = scripts / 'setup_resource_limits.sh'
        if limits.is_file():
            execute(['bash', str(limits)], env=environment)
    else:
        firewall = pinned(journal, config, 'block_internet_access.sh')
        for name, mode in (('update_service.sh', 0o755), ('sqlite_maintenance.py', 0o644)):
            write(config.maintenance / name, pinned(journal, config, name), mode)
        # Recovery startup gates remain installed independently of either fork.
        write(config.systemd / 'free-sleep-update.service', (
            '[Unit]\nDescription=Free Sleep updater\nAfter=free-sleep.service\n'
            '[Service]\nType=oneshot\nUser=root\nGroup=root\nKillMode=process\n'
            'ExecStart=/bin/bash ' + str(config.live / 'scripts/update_service.sh') + '\n').encode())
        write(config.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf', (
            '[Service]\nExecStart=\nExecStart=/bin/bash ' + str(config.guard) + '\n').encode())
        for unit in FORK_UNITS:
            # Never stop the operation unit running this transaction.
            arguments = ['systemctl', 'disable']
            if unit not in ('free-sleep-revert.service', 'free-sleep-rollback.service'):
                arguments.append('--now')
            if captured['states'][unit]['present']:
                execute(arguments + [unit])
            remove(config.systemd / unit)
        for path in config.files():
            if path.name in ('10-nightstand-limits.conf', '20-nightstand-restart.conf',
                             '10-nightstand-watchdog.conf'):
                remove(path)
        if config.sudoers.exists():
            lines = config.sudoers.read_text().splitlines(keepends=True)
            obsolete = {('dac ALL=(root) NOPASSWD: /bin/systemctl start ' + unit + ' --no-block')
                        for unit in ('free-sleep-rollback.service', 'free-sleep-revert.service')}
            content = ''.join(line for line in lines if line.strip() not in obsolete).encode()
            with tempfile.NamedTemporaryFile() as candidate:
                candidate.write(content)
                candidate.flush()
                execute(['visudo', '-cf', candidate.name])
            write(config.sudoers, content, 0o440)
    execute(['systemctl', 'daemon-reload'])
    if direction == 'upstream':
        verify_updater(config)
    if direction == 'nightstand':
        execute(['sh', str(nightstand_scripts(config) / 'block_internet_access.sh')])
    else:
        # Upstream gets its own firewall script back, as before Nightstand. It
        # runs from the checked bytes on stdin; the script never reads stdin or $0.
        execute(['sh', '-s'], input=firewall.decode())
    for family in ('iptables', 'ip6tables'):
        try:
            execute([family, '-C', 'OUTPUT', '-j', 'REJECT'])
        except subprocess.CalledProcessError:
            try:
                execute([family, '-C', 'OUTPUT', '-j', 'DROP'])
            except subprocess.CalledProcessError as error:
                raise ValueError(family + ' OUTPUT has no terminal REJECT or DROP') from error


def restore_enablement(unit, state, runner=None):
    runner = execute if runner is None else runner
    mode = state.get('enabledMode', 'enabled' if state['enabled'] else 'disabled')
    if mode not in ('enabled', 'enabled-runtime', 'disabled') or state['enabled'] != (mode != 'disabled'):
        raise ValueError('Invalid service enablement mode')
    if mode == 'enabled-runtime':
        runner(['systemctl', 'disable', unit])
        runner(['systemctl', 'enable', '--runtime', unit])
    else:
        runner(['systemctl', 'enable' if state['enabled'] else 'disable', unit])


def firewall_rules(content):
    # Save output includes timestamps and counters that change without rule changes.
    return [re.sub(r'\[\d+:\d+\]', '[0:0]', line.strip()) for line in content.splitlines()
            if line.strip() and not line.lstrip().startswith('#')]


def restore_firewall(store, transaction, captured):
    rules = []
    for index, item in enumerate(captured['firewall']):
        path = store.directory(transaction) / (('iptables-save', 'ip6tables-save')[index] + '.rules')
        if str(path) != item['path'] or path.is_symlink():
            raise ValueError('Invalid saved firewall path')
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != item['sha256']:
            raise ValueError('Saved firewall checksum mismatch')
        rules.append(content.decode())
    if len(rules) != 2:
        raise ValueError('Missing saved firewall families')
    for command, content in zip(('iptables-restore', 'ip6tables-restore'), rules):
        execute([command], input=content)
    for command, content in zip(('iptables-save', 'ip6tables-save'), rules):
        if firewall_rules(execute([command])) != firewall_rules(content):
            raise ValueError('Live firewall restoration did not match saved rules')


def restore(store, transaction, config, release_services=True):
    journal, captured = record(store, transaction, config)
    if journal['phase'] != 'recovering':
        raise ValueError('Configuration restoration requires offline recovery')
    for unit in FORK_UNITS:
        status = execute(['systemctl', 'show', '--property=LoadState', '--value', unit]).strip()
        if status != 'not-found':
            if unit not in ('free-sleep-revert.service', 'free-sleep-rollback.service'):
                execute(['systemctl', 'stop', unit])
            if not captured['states'][unit]['enabled']:
                execute(['systemctl', 'disable', unit])
    store.restore_snapshots(transaction)
    restore_firewall(store, transaction, captured)
    execute(['systemctl', 'daemon-reload'])
    execute(['systemctl', 'try-restart', 'systemd-timesyncd.service'])
    for unit, state in captured['states'].items():
        if not state['present']:
            continue
        restore_enablement(unit, state)
        if release_services and state['active'] and unit not in ('free-sleep-revert.service', 'free-sleep-rollback.service',
                                            'free-sleep-recover-switch.service'):
            execute(['systemctl', 'start', '--no-block', unit])
    return captured['states']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('snapshot', 'apply', 'restore'))
    parser.add_argument('--journal-root', type=Path, required=True)
    parser.add_argument('--transaction', required=True)
    parser.add_argument('--system-root', type=Path, default=Path('/'))
    parser.add_argument('--live', type=Path, default=Path('/home/dac/free-sleep'))
    parser.add_argument('--direction', choices=('upstream', 'nightstand'))
    args = parser.parse_args()
    try:
        config = Configuration(args.system_root, args.live)
        store = TransactionStore(args.journal_root)
        if args.command == 'apply':
            apply(store, args.transaction, config, args.direction)
        else:
            globals()[args.command](store, args.transaction, config)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, 'System reconciliation stopped: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
