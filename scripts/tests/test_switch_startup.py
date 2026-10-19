"""Every writer start checks journals, including controlled target validation."""
import fcntl
import os
import shlex
import signal
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import recover_switch
from switch_transaction import TransactionStore


class SwitchStartupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = TransactionStore(self.root / 'transactions')
        self.live = self.root / 'live'
        self.live.mkdir()
        status = self.live.stat()
        identity = dict(fork='nightstand', commit='a' * 40, treeSha256='b' * 64,
                        version='3.6.1', treePath=str(self.live))
        self.store.create('switch', identity, dict(identity, fork='upstream', version='3.0.3'), dict(recovery=dict(
            paths=[dict(kind='tree', live=str(self.live), saved=str(self.root / 'saved'), failed=str(self.root / 'failed'),
                        device=status.st_dev, inode=status.st_ino, realParents={key: str(self.root) for key in ('live', 'saved', 'failed')})],
            services={'free-sleep.service': dict(active=True, enabled=True),
                      'free-sleep-stream.service': dict(active=True, enabled=True)},
            operation=dict(unit='free-sleep-revert.service', invocationId='c' * 32))))
        for phase in ('writers-stopped', 'snapshots-ready', 'installing', 'validating'):
            self.store.advance('switch', phase)
        self.store.intent('switch', 'validation-startup', dict(units=['free-sleep.service', 'free-sleep-stream.service']))
        self.lock_path = self.root / 'operation.lock'
        self.lock = self.lock_path.open('w')
        self.addCleanup(self.lock.close)
        fcntl.flock(self.lock, fcntl.LOCK_EX)

    def controller(self, *arguments):
        if '--property=InvocationID' in arguments:
            return 'c' * 32
        if '--property=ActiveState' in arguments:
            return 'active'
        raise AssertionError(arguments)

    def check(self, unit='free-sleep.service'):
        return recover_switch.check_startup(self.store, unit, self.lock_path)

    def test_boot_recovery_defers_to_the_active_locked_operation_during_validation(self):
        with patch.object(recover_switch, 'controller', side_effect=self.controller):
            self.assertTrue(recover_switch.operation_active(self.store, self.lock_path))
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.assertFalse(recover_switch.operation_active(self.store, self.lock_path))
        with patch.object(recover_switch, 'controller', return_value='different invocation'):
            self.assertFalse(recover_switch.operation_active(self.store, self.lock_path))

    def test_only_explicit_validation_writers_start_under_the_live_recorded_operation(self):
        with patch.object(recover_switch, 'controller', side_effect=self.controller):
            self.check()
            self.check('free-sleep-stream.service')
            for unit in ('free-sleep-health.service', 'free-sleep-update.service', 'free-sleep-revert.service'):
                with self.subTest(unit=unit), self.assertRaises(ValueError):
                    self.check(unit)

    def test_running_oneshot_validation_accepts_activating_and_keeps_invocation_and_lock_checks(self):
        def activating(*arguments):
            return 'activating' if '--property=ActiveState' in arguments else self.controller(*arguments)
        with patch.object(recover_switch, 'controller', side_effect=activating):
            self.check()
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            with self.assertRaises(ValueError):
                self.check()
        with patch.object(recover_switch, 'controller', return_value='d' * 32), self.assertRaises(ValueError):
            self.check()

    def test_validation_permission_expires_with_the_operation_lock_invocation_or_phase(self):
        with patch.object(recover_switch, 'controller', side_effect=self.controller):
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            with self.assertRaises(ValueError):
                self.check()
            fcntl.flock(self.lock, fcntl.LOCK_EX)
        for state in ('different invocation', 'inactive'):
            with patch.object(recover_switch, 'controller', return_value=state), self.assertRaises(ValueError):
                self.check()
        with patch.object(recover_switch, 'controller', side_effect=self.controller):
            self.store.advance('switch', 'recovering')
            with self.assertRaises(ValueError):
                self.check()

    def test_interrupted_recovery_before_configuration_changes_can_retry(self):
        (self.live / 'server/src').mkdir(parents=True)
        (self.live / 'server/src/serverInfo.json').write_text('{"version":"3.6.1"}')
        journal = self.store.load('switch')
        journal['phase'] = 'armed'
        journal['intents'] = []
        self.store._write(journal)
        with patch.object(recover_switch.subprocess, 'run'), \
                patch.object(recover_switch, 'controller', return_value=''), \
                patch.object(self.store, 'restore_snapshots', side_effect=[OSError('interrupted'), None]):
            with self.assertRaises(OSError):
                recover_switch.restore(self.store, Path('restore_helpers.sh'))
            self.assertEqual(self.store.load('switch')['phase'], 'recovering')
            recover_switch.restore(self.store, Path('restore_helpers.sh'))
        self.assertEqual(self.store.load('switch')['phase'], 'recovered')

    def test_unapproved_validation_and_corrupt_journals_block_even_after_boot(self):
        journal = self.store.load('switch')
        journal['intents'] = []
        self.store._write(journal)
        with patch.object(recover_switch, 'controller', side_effect=self.controller), self.assertRaises(ValueError):
            self.check()
        (self.store.directory('switch') / 'journal.json').write_text('corrupt')
        with self.assertRaises(ValueError):
            self.check()


class InstalledStartupGateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.recovery = self.root / 'recovery'
        self.transactions = self.root / 'transactions'
        self.systemd = self.root / 'systemd'
        self.systemd.mkdir()
        scripts = Path(__file__).resolve().parents[1]
        installer = (scripts / 'setup_services.sh').read_text().split("<<'PYSWITCHRECOVERY'\n", 1)[1].split('\nPYSWITCHRECOVERY', 1)[0]
        from switch_transaction import publish
        real_uid, real_gid = os.geteuid(), os.getegid()
        self.owners = {}
        def install_as_root(path, content, metadata):
            self.owners[str(path)] = (metadata['uid'], metadata['gid'])
            publish(path, content, dict(metadata, uid=real_uid, gid=real_gid))
        # Model a root installer and a dac service without requiring setuid.
        with patch.object(sys, 'argv', ['installer', str(scripts.parent), str(self.recovery),
                                      str(self.systemd), str(self.transactions)]), \
                patch('switch_transaction.publish', side_effect=install_as_root), \
                patch.object(os, 'geteuid', return_value=0), patch.object(os, 'getegid', return_value=0):
            exec(compile(installer, 'switch recovery installer', 'exec'), {})
        gate = self.systemd / 'free-sleep.service.d/nightstand-switch-recovery.conf'
        self.gate = gate.read_text()
        self.command = self.gate.split('ExecStartPre=', 1)[1].strip()
        self.commands = {
            path.parent.name[:-2]: path.read_text().split('ExecStartPre=', 1)[1].strip()
            for path in self.systemd.glob('*.service.d/nightstand-switch-recovery.conf')
        }
        self.environment = dict(os.environ, NIGHTSTAND_TRANSACTION_ROOT=str(self.transactions),
                                NIGHTSTAND_OPERATION_LOCK=str(self.root / 'lock'))

    def start(self, command=None, timeout=5):
        command = self.command if command is None else command
        privileged = command.startswith('+')
        arguments = shlex.split(command.lstrip('+').replace('$$', '$').replace('%%', '%'))
        # The shell and helpers are inside a root-owned 0700 directory. A dac
        # ExecStartPre cannot traverse it, even if the individual file is 0755.
        self.assertEqual(self.recovery.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.owners[str(self.recovery / 'recover_switch.sh')], (0, 0))
        if not privileged:
            return subprocess.CompletedProcess(arguments, 126, '', 'Permission denied (dac)')
        with subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, env=self.environment, start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
            return subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)

    def test_no_journal_never_invokes_a_hanging_helper_for_any_generated_precheck(self):
        self.assertEqual(set(self.commands), {
            'free-sleep.service', 'free-sleep-stream.service', 'free-sleep-archive-raw.service',
            'free-sleep-health.service', 'free-sleep-network-watchdog.service',
            'free-sleep-recover-update.service', 'free-sleep-update.service',
            'free-sleep-rollback.service', 'free-sleep-revert.service', 'free-sleep-migrate.service',
        })
        marker = self.root / 'helper-invoked'
        (self.recovery / 'recover_switch.sh').write_text(
            '#!/bin/bash\ntouch ' + shlex.quote(str(marker)) + '\nexec sleep 30\n')
        for state in ('absent root', 'empty root', 'unrelated file'):
            if state == 'empty root':
                self.transactions.mkdir()
            elif state == 'unrelated file':
                (self.transactions / 'unrelated').write_text('not a journal')
            for unit, command in self.commands.items():
                with self.subTest(state=state, unit=unit):
                    try:
                        result = self.start(command, timeout=0.5)
                    except subprocess.TimeoutExpired:
                        self.fail('No-journal startup invoked the hanging helper')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(marker.exists(), 'No-journal startup invoked the helper')

    def test_installed_recovery_unit_skips_without_a_journal_and_keeps_ordering(self):
        unit = (self.systemd / 'free-sleep-recover-switch.service').read_text()
        self.assertIn('ConditionPathExistsGlob=' + str(self.transactions) + '/*/journal.json\n', unit)
        self.assertIn('Before=free-sleep.service free-sleep-stream.service free-sleep-update.service '
                      'free-sleep-rollback.service free-sleep-revert.service free-sleep-migrate.service\n', unit)
        for name in self.commands:
            gate = (self.systemd / (name + '.d') / 'nightstand-switch-recovery.conf').read_text()
            self.assertNotIn('Wants=', gate)
            self.assertIn('After=free-sleep-recover-switch.service\n', gate)

    def test_journal_or_dangling_symlink_runs_helper_and_preserves_failure_for_every_precheck(self):
        directory = self.transactions / 'switch'
        directory.mkdir(parents=True)
        journal = directory / 'journal.json'
        marker = self.root / 'helper-arguments'
        (self.recovery / 'recover_switch.sh').write_text(
            '#!/bin/bash\nprintf "%s\\n" "$@" > ' + shlex.quote(str(marker)) + '\nexit 23\n')
        for kind in ('file', 'dangling symlink'):
            if kind == 'file':
                journal.write_text('corrupt')
            else:
                journal.unlink()
                journal.symlink_to(directory / 'missing')
            for unit, command in self.commands.items():
                with self.subTest(kind=kind, unit=unit):
                    result = self.start(command)
                    self.assertEqual(result.returncode, 23, result.stderr)
                    self.assertEqual(marker.read_text(), '--startup-check\n' + unit + '\n')
                    marker.unlink()

    def test_journal_gate_runs_the_helper_without_the_server_users_environment(self):
        directory = self.transactions / 'switch'
        directory.mkdir(parents=True)
        (directory / 'journal.json').write_text('corrupt')
        marker = self.root / 'helper-environment'
        (self.recovery / 'recover_switch.sh').write_text(
            '#!/bin/bash\nprintf "%s|%s|%s\\n" "$PATH" "${HOME-unset}" "${PYTHONPATH-unset}" > '
            + shlex.quote(str(marker)) + '\n')
        # The writer units run with dac's Volta folder first on PATH.
        self.environment.update(PATH='/home/dac/.volta/bin:' + os.environ['PATH'], HOME='/home/dac',
                                PYTHONPATH='/home/dac')
        for unit, command in self.commands.items():
            with self.subTest(unit=unit):
                self.assertEqual(self.start(command).returncode, 0)
                self.assertEqual(marker.read_text(), '/usr/sbin:/usr/bin:/sbin:/bin|unset|unset\n')

    def test_helper_ignores_the_callers_path_and_python_environment(self):
        directory = self.transactions / 'switch'
        directory.mkdir(parents=True)
        (directory / 'journal.json').write_text('corrupt')
        planted = self.root / 'planted'
        planted.mkdir()
        marker = self.root / 'planted-ran'
        (planted / 'python3').write_text('#!/bin/sh\ntouch ' + shlex.quote(str(marker)) + '\n')
        (planted / 'python3').chmod(0o755)
        (planted / 'argparse.py').write_text('open(' + repr(str(marker)) + ', "w").close()\n')
        script = Path(__file__).resolve().parents[1] / 'recover_switch.sh'
        environment = dict(os.environ, PATH=str(planted) + ':' + os.environ['PATH'], PYTHONPATH=str(planted),
                           NIGHTSTAND_TRANSACTION_ROOT=str(self.transactions))
        environment.pop('NIGHTSTAND_RECOVERY_PATH', None)
        result = subprocess.run(['/bin/bash', str(script), '--check'], env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Switch recovery stopped', result.stderr)
        self.assertFalse(marker.exists())

    def test_root_install_allows_dac_writer_start_and_keeps_recovery_private(self):
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Wants=', self.gate)
        self.assertNotIn('Requires=free-sleep-recover-switch.service', self.gate)

    def test_no_journal_returns_without_reading_other_state_or_running_python(self):
        self.transactions.mkdir()
        (self.transactions / 'unrelated').write_text('not a journal')
        (self.recovery / 'recover_switch.py').write_text('raise RuntimeError("must not be read")')
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')

    def test_unfinished_failed_and_corrupt_journals_block_startup(self):
        directory = self.transactions / 'switch'
        directory.mkdir(parents=True)
        for content in ('corrupt', '{"phase":"installing"}', '{"phase":"recovering"}'):
            with self.subTest(content=content):
                (directory / 'journal.json').write_text(content)
                self.assertNotEqual(self.start().returncode, 0)

    def test_no_journal_bypasses_broken_helpers_and_allows_startup(self):
        for failure in ('missing shell', 'missing python', 'python exception'):
            with self.subTest(failure=failure):
                shell = self.recovery / 'recover_switch.sh'
                if failure == 'missing shell':
                    original = shell.read_bytes()
                    shell.unlink()
                else:
                    # Inject an error before the helper's fast path.
                    shell.write_text('#!/bin/bash\npython3 -B "$(dirname "$0")/recover_switch.py"\n')
                    python = self.recovery / 'recover_switch.py'
                    if failure == 'missing python':
                        python.unlink()
                    else:
                        python.write_text('raise RuntimeError("startup failure")')
                result = self.start()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, '')
                if failure == 'missing shell':
                    shell.write_bytes(original)

    def test_no_journal_permission_error_allows_startup_without_helper(self):
        self.transactions.mkdir(mode=0o000)
        self.addCleanup(self.transactions.chmod, 0o700)
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')

    def test_helper_failure_with_a_journal_blocks_startup(self):
        directory = self.transactions / 'switch'
        directory.mkdir(parents=True)
        (directory / 'journal.json').write_text('corrupt')
        (self.recovery / 'recover_switch.sh').unlink()
        self.assertNotEqual(self.start().returncode, 0)


if __name__ == '__main__':
    unittest.main()
