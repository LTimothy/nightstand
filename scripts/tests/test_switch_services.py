"""Cross-fork configuration changes retain recoverable system state."""
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from switch_transaction import TransactionStore


class SwitchServicesTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('switch_services', SCRIPTS / 'switch_services.py')
        self.assertTrue(Path(spec.origin).exists(), 'Configuration reconciler is missing')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.live = self.root / 'live'
        (self.live / 'scripts').mkdir(parents=True)
        # A later update removes the checkout copy. The installed guard must survive.
        (self.live / 'scripts/update_service.sh').write_text(
            '#!/bin/sh\nset -e\npython3 "$(dirname "$0")/sqlite_maintenance.py"\n'
            'rm -f "' + str(self.live / 'scripts/update_service.sh') + '"\n'
            "printf 'updated\\n'\n")
        (self.live / 'scripts/sqlite_maintenance.py').write_text('print("backup")\n')
        (self.live / 'scripts/block_internet_access.sh').write_text('#!/bin/sh\nexit 0\n')
        self.config = self.module.Configuration(self.root, self.live)
        self.store = TransactionStore(self.root / 'transactions')
        identity = dict(fork='nightstand', commit='a' * 40, treeSha256='b' * 64,
                        version='3.6.1', treePath=str(self.live))
        self.store.create('switch', identity, dict(identity, version='3.0.3'))
        self.store.advance('switch', 'writers-stopped')
        self.calls = []
        self.rules = '*filter\n:CUSTOM - [0:0]\n-A OUTPUT -j CUSTOM\nCOMMIT\n'
        self.originals = {}
        for path in self.config.files():
            path.parent.mkdir(parents=True, exist_ok=True)
        for path in [self.config.systemd / 'free-sleep-update.service', self.config.sudoers,
                     self.config.watchdog, self.config.firewall_files[0]]:
            path.write_text('prior configuration\n')
            path.chmod(0o640)
            self.originals[path] = (path.read_bytes(), path.stat().st_mode)

    def execute(self, command, **kwargs):
        self.calls.append(command)
        if command[0].endswith('tables-save'):
            return self.rules
        if command[:2] == ['systemctl', 'show']:
            if '--property=ExecStart' in command:
                return '{ path=/bin/bash ; argv[]=/bin/bash ' + str(self.config.guard) + ' ; }'
            if '--property=ExecStopPost' in command:
                return ''
            return 'ActiveState=inactive\nUnitFileState=enabled\n'
        return ''

    def pin(self):
        # The switch pins the checked upstream scripts before it snapshots.
        self.module.pin_scripts(self.store, 'switch', {
            'scripts/' + name: hashlib.sha256((self.live / 'scripts' / name).read_bytes()).hexdigest()
            for name in self.module.PINNED})

    def snapshot(self):
        self.pin()
        with patch.object(self.module, 'execute', side_effect=self.execute):
            self.module.snapshot(self.store, 'switch', self.config)
        self.store.advance('switch', 'snapshots-ready')
        self.store.advance('switch', 'installing')

    def apply(self):
        with patch.object(self.module, 'execute', side_effect=self.execute):
            self.module.apply(self.store, 'switch', self.config, 'upstream')

    def test_installs_persistent_guard_and_effective_unit_with_existing_executables(self):
        self.snapshot()
        self.apply()
        self.assertTrue(os.access(self.config.guard, os.X_OK))
        dropin = self.config.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf'
        self.assertIn('ExecStart=\nExecStart=/bin/bash ' + str(self.config.guard), dropin.read_text())
        self.assertNotIn('close_update_window', (self.config.systemd / 'free-sleep-update.service').read_text())
        self.assertFalse(self.config.watchdog.exists())
        self.assertTrue((self.config.systemd / 'free-sleep-update.service.d/nightstand-switch-recovery.conf').exists() is False)
        self.assertTrue(any(item['name'] == 'reconcile-system' for item in self.store.load('switch')['intents']))

    def test_reject_failure_reaches_drop_fallback_in_both_families(self):
        bindir = self.root / 'bin'
        bindir.mkdir()
        firewall = """#!/bin/sh
family=${0##*/}
if [ "$1" = -A ] && [ "$4" = REJECT ]; then exit 1; fi
if [ "$1" = -A ] && [ "$4" = DROP ]; then
  echo DROP > "$TEST_FIREWALL/$family"
  exit 0
fi
[ "$1" = -C ] && [ "$(cat "$TEST_FIREWALL/$family" 2>/dev/null)" = "$4" ]
"""
        for family in ('iptables', 'ip6tables'):
            command = bindir / family
            command.write_text(firewall)
            command.chmod(0o755)
        (self.live / 'scripts/block_internet_access.sh').write_text("""#!/bin/sh
iptables -A OUTPUT -j REJECT
iptables -C OUTPUT -j REJECT || iptables -A OUTPUT -j DROP
ip6tables -A OUTPUT -j REJECT
ip6tables -C OUTPUT -j REJECT || ip6tables -A OUTPUT -j DROP
iptables -C OUTPUT -j DROP && ip6tables -C OUTPUT -j DROP
""")
        self.snapshot()
        environment = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'],
                           TEST_FIREWALL=str(self.root))
        def apply_command(command, **kwargs):
            if command[0] in ('sh', 'iptables', 'ip6tables'):
                return self.module.subprocess.run(command, check=True, capture_output=True, text=True,
                                                  env=environment, input=kwargs.get('input')).stdout
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=apply_command):
            self.module.apply(self.store, 'switch', self.config, 'upstream')
        self.assertEqual((self.root / 'iptables').read_text(), 'DROP\n')
        self.assertEqual((self.root / 'ip6tables').read_text(), 'DROP\n')

    def test_successful_block_script_without_a_terminal_rule_is_refused(self):
        self.snapshot()
        for missing in ('iptables', 'ip6tables'):
            with self.subTest(missing=missing):
                def missing_tail(command, **kwargs):
                    if command[0] == missing and command[1:3] == ['-C', 'OUTPUT']:
                        raise subprocess.CalledProcessError(1, command)
                    return self.execute(command, **kwargs)
                with patch.object(self.module, 'execute', side_effect=missing_tail):
                    with self.assertRaisesRegex(ValueError, 'OUTPUT'):
                        self.module.apply(self.store, 'switch', self.config, 'upstream')

    def test_mocked_subsequent_update_uses_guard_after_checkout_copy_is_removed(self):
        self.snapshot()
        self.apply()
        for _ in range(2):
            result = subprocess.run(['bash', str(self.config.guard)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, 'backup\nupdated\n')

    def test_failed_reconciliation_restores_bytes_modes_absence_and_custom_firewall(self):
        self.snapshot()
        def fail(command, **kwargs):
            if command[:2] == ['systemctl', 'daemon-reload']:
                raise subprocess.CalledProcessError(1, command)
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=fail):
            with self.assertRaises(subprocess.SubprocessError):
                self.module.apply(self.store, 'switch', self.config, 'upstream')
        self.store.advance('switch', 'recovering')
        restored = []
        def restore_execute(command, **kwargs):
            if command[0].endswith('tables-restore'):
                restored.append(kwargs['input'])
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=restore_execute):
            for _ in range(2):
                self.module.restore(self.store, 'switch', self.config)
        for path, (content, mode) in self.originals.items():
            self.assertEqual(path.read_bytes(), content)
            self.assertEqual(path.stat().st_mode, mode)
        self.assertFalse(self.config.guard.exists())
        self.assertEqual(restored, [self.rules] * 4)

    def test_missing_snapshot_and_completed_transaction_refuse_mutation(self):
        with self.assertRaises(ValueError):
            self.apply()
        self.snapshot()
        self.store.advance('switch', 'validating')
        self.store.advance('switch', 'committed')
        with self.assertRaises(ValueError):
            self.apply()

    def test_invalid_effective_override_fails_validation(self):
        self.snapshot()
        def wrong(command, **kwargs):
            if '--property=ExecStart' in command:
                return '{ path=/missing/update.sh ; argv[]=/missing/update.sh ; }'
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=wrong):
            with self.assertRaises(ValueError):
                self.module.apply(self.store, 'switch', self.config, 'upstream')

    def test_a_socket_in_the_tree_falls_back_to_the_live_copy_instead_of_failing(self):
        cwd = os.getcwd()
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        try:
            os.chdir(str(self.live / 'scripts'))
            listener.bind('server.sock')
        finally:
            os.chdir(cwd)
        self.assertEqual(self.module.nightstand_scripts(self.config), self.config.system / 'live/scripts')

    def test_return_removes_upstream_override_before_nightstand_setup(self):
        override = self.config.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf'
        override.write_text('[Service]\nExecStart=/upstream-only\n')
        self.snapshot()
        with patch.object(self.module, 'execute', side_effect=self.execute):
            self.module.apply(self.store, 'switch', self.config, 'nightstand')
        self.assertFalse(override.exists())

    def test_foreign_dropins_and_sudoers_rules_survive(self):
        custom = self.config.systemd / 'free-sleep-update.service.d/custom.conf'
        custom.write_text('[Service]\nEnvironment=CUSTOM=yes\n')
        self.config.sudoers.write_text('dac ALL=(ALL) NOPASSWD: /usr/bin/custom\n'
                                      'dac ALL=(root) NOPASSWD: /bin/systemctl start free-sleep-revert.service --no-block\n')
        self.snapshot()
        self.apply()
        self.assertEqual(custom.read_text(), '[Service]\nEnvironment=CUSTOM=yes\n')
        self.assertIn('/usr/bin/custom', self.config.sudoers.read_text())
        self.assertNotIn('free-sleep-revert.service', self.config.sudoers.read_text())

    def test_absent_fork_units_do_not_prevent_reconciliation(self):
        def absent(command, **kwargs):
            if command[:2] == ['systemctl', 'show'] and '--property=ExecStart' not in command and '--property=ExecStopPost' not in command:
                return 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'
            if command[:2] == ['systemctl', 'disable']:
                raise subprocess.CalledProcessError(1, command)
            return self.execute(command, **kwargs)
        # The updater is present; the optional fork-only units have never existed.
        self.pin()
        with patch.object(self.module, 'execute', side_effect=absent):
            self.module.snapshot(self.store, 'switch', self.config)
            self.store.advance('switch', 'snapshots-ready')
            self.store.advance('switch', 'installing')
            self.module.apply(self.store, 'switch', self.config, 'upstream')

    def test_effective_guard_path_prefix_is_not_a_valid_guard(self):
        self.snapshot()
        def prefix(command, **kwargs):
            if '--property=ExecStart' in command:
                return '{ path=/bin/bash ; argv[]=/bin/bash ' + str(self.config.guard) + '.obsolete ; }'
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=prefix):
            with self.assertRaises(ValueError):
                self.module.apply(self.store, 'switch', self.config, 'upstream')

    def test_restoration_preserves_temporary_service_enablement(self):
        def temporary(command, **kwargs):
            if command[:2] == ['systemctl', 'show'] and '--property=LoadState,ActiveState,UnitFileState' in command:
                return 'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled-runtime\n'
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=temporary):
            self.module.snapshot(self.store, 'switch', self.config)
        self.store.advance('switch', 'recovering')
        self.calls.clear()
        with patch.object(self.module, 'execute', side_effect=self.execute):
            self.module.restore(self.store, 'switch', self.config)
        self.assertIn(['systemctl', 'enable', '--runtime', 'free-sleep-health.timer'], self.calls)
        self.assertNotIn(['systemctl', 'enable', 'free-sleep-health.timer'], self.calls)

    def test_failed_return_stops_timers_started_by_target_setup(self):
        self.snapshot()
        active = set()
        def runtime(command, **kwargs):
            if command[:2] == ['bash', str(self.live / 'scripts/setup_services.sh')]:
                active.add('free-sleep-health.timer')
            elif command[:2] == ['systemctl', 'stop']:
                active.discard(command[-1])
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=runtime):
            self.module.apply(self.store, 'switch', self.config, 'nightstand')
            self.store.advance('switch', 'recovering')
            self.module.restore(self.store, 'switch', self.config)
        self.assertEqual(active, set())

    def test_failed_return_restores_tmpfiles_rule_absence_and_recovery_enablement(self):
        tmpfiles = self.root / 'etc/tmpfiles.d/free-sleep-operation.conf'
        tmpfiles.parent.mkdir(parents=True, exist_ok=True)
        self.snapshot()
        tmpfiles.write_text('new operation lock rule\n')
        self.store.advance('switch', 'recovering')
        with patch.object(self.module, 'execute', side_effect=self.execute):
            self.module.restore(self.store, 'switch', self.config)
        self.assertFalse(tmpfiles.exists())
        configuration = next(item for item in self.store.load('switch')['intents']
                             if item['name'] == 'system-configuration')
        self.assertIn('free-sleep-recover-switch.service', configuration['details']['states'])

    def test_failed_return_disables_newly_created_timers_before_removing_units(self):
        enabled = set()
        timer = self.config.systemd / 'free-sleep-health.timer'
        def initially_absent(command, **kwargs):
            if command[:2] == ['systemctl', 'show']:
                return 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'
            return self.execute(command, **kwargs)
        with patch.object(self.module, 'execute', side_effect=initially_absent):
            self.module.snapshot(self.store, 'switch', self.config)
        timer.write_text('[Timer]\nOnBootSec=1\n')
        enabled.add(timer.name)
        def restoring(command, **kwargs):
            if command[:2] == ['systemctl', 'show'] and '--property=LoadState' in command:
                return 'loaded\n' if command[-1] == timer.name else 'not-found\n'
            if command[:2] == ['systemctl', 'disable']:
                self.assertTrue(timer.exists(), 'Disable must happen before removing the new unit')
                enabled.discard(command[-1])
            return self.execute(command, **kwargs)
        self.store.advance('switch', 'recovering')
        with patch.object(self.module, 'execute', side_effect=restoring):
            self.module.restore(self.store, 'switch', self.config)
        self.assertFalse(timer.exists())
        self.assertEqual(enabled, set())


if __name__ == '__main__':
    unittest.main()
