"""Isolated environment preparation never writes the active Python installation."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('prepare_upstream_env', ROOT / 'scripts/prepare_upstream_env.py')


class UpstreamEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.original = self.root / 'venv'
        (self.original / 'bin').mkdir(parents=True)
        self.python = self.original / 'bin/python'
        self.python.write_text('#!/bin/sh\nprintf original-interpreter\n')
        self.python.chmod(0o755)
        (self.original / 'package').write_bytes(b'original package bytes')
        self.stage = self.root / 'stage'
        (self.stage / 'biometrics').mkdir(parents=True)
        (self.stage / 'biometrics/requirements.txt').write_text('numpy\nscipy\npandas\ncbor2\nwatchdog\nsentry-sdk\nnats-py\n')
        self.env_root = self.root / 'environments'
        self.calls = []

    def hashes(self):
        return {str(path.relative_to(self.original)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.original.rglob('*') if path.is_file()}

    def fake_execute(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command[-2:] == ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])']:
            return '3.9\n'
        if '-m' in command and 'venv' in command:
            destination = Path(command[-1])
            (destination / 'bin').mkdir(parents=True)
            (destination / 'bin/python').write_text('#!/bin/sh\nexec "' + sys.executable + '" "$@"\n')
            (destination / 'bin/python').chmod(0o755)
        if 'freeze' in command:
            return 'numpy==2.0.2\nsentry-sdk==2.71.0\n'
        return ''

    def prepare(self, execute=None):
        with patch.object(self.module, 'execute', side_effect=execute or self.fake_execute):
            return self.module.prepare(self.stage, self.env_root, 'switch', self.original,
                                       'python3', self.module.current_user(), 1)

    def test_nightstand_return_prepares_pinned_packages_without_touching_upstream(self):
        before = self.hashes()
        (self.stage / 'scripts/python').mkdir(parents=True)
        (self.stage / 'scripts/python/requirements.txt').write_bytes((ROOT / 'scripts/python/requirements.txt').read_bytes())
        with patch.object(self.module, 'execute', side_effect=self.fake_execute):
            destination = self.module.prepare(self.stage, self.env_root, 'return', self.original,
                                              'python3', self.module.current_user(), 1, direction='nightstand')
        self.assertEqual(self.hashes(), before)
        self.assertEqual(destination, self.env_root / 'nightstand-return')
        install = next(command for command, _ in self.calls if 'install' in command)
        self.assertIn(str(self.stage / 'scripts/python/requirements.txt'), install)
        validate = next(command for command, _ in self.calls if any('validate_upstream_imports' in value for value in command))
        self.assertEqual(validate[-1], 'nightstand')

    def test_success_keeps_permanent_executable_paths_and_records_resolution(self):
        before = self.hashes()
        destination = self.prepare()
        self.assertEqual(self.hashes(), before)
        self.assertEqual(destination, self.env_root / 'upstream-switch')
        self.assertEqual((destination / 'resolved-requirements.txt').read_text(), 'numpy==2.0.2\nsentry-sdk==2.71.0\n')
        self.assertTrue((destination / 'prepared.json').is_file())
        install = next(command for command, _ in self.calls if 'install' in command)
        self.assertEqual(install[0], str(destination / 'bin/python'))
        self.assertIn('--only-binary=:all:', install)
        self.assertIn('--constraint', install)
        self.assertEqual(subprocess.check_output([str(self.python)], text=True), 'original-interpreter')

    def test_install_failure_timeout_and_interruption_preserve_original_hashes(self):
        for failure in ('pip', 'timeout', 'interrupt'):
            with self.subTest(failure=failure):
                before = self.hashes()
                def failed(command, **kwargs):
                    if 'install' in command:
                        if failure == 'timeout':
                            raise subprocess.TimeoutExpired(command, 1)
                        raise subprocess.CalledProcessError(-9 if failure == 'interrupt' else 1, command)
                    return self.fake_execute(command, **kwargs)
                with self.assertRaises((subprocess.SubprocessError, ValueError)):
                    self.prepare(failed)
                self.assertEqual(self.hashes(), before)
                self.assertFalse((self.env_root / 'upstream-switch/prepared.json').exists())
                import shutil
                shutil.rmtree(self.env_root, ignore_errors=True)

    def test_missing_bootstrap_aborts_before_creating_an_environment(self):
        before = self.hashes()
        def missing(command, **kwargs):
            if 'import venv, ensurepip; print(ensurepip.version())' in command:
                raise subprocess.CalledProcessError(1, command)
            return self.fake_execute(command, **kwargs)
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare(missing)
        self.assertFalse(self.env_root.exists())
        self.assertEqual(self.hashes(), before)

    def test_existing_original_symlink_and_absent_original_are_untouched(self):
        before = self.hashes()
        retained = self.root / 'retained'
        self.original.rename(retained)
        self.original.symlink_to(retained, target_is_directory=True)
        self.prepare()
        self.assertTrue(self.original.is_symlink())
        self.assertEqual(self.hashes(), before)
        self.original.unlink()
        import shutil
        shutil.rmtree(self.env_root)
        self.prepare()
        self.assertFalse(self.original.exists())
        self.assertEqual(subprocess.check_output([str(retained / 'bin/python')], text=True), 'original-interpreter')

    def test_existing_destination_symlink_is_refused(self):
        self.env_root.mkdir()
        (self.env_root / 'upstream-switch').symlink_to(self.original)
        before = self.hashes()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.hashes(), before)
        self.assertTrue((self.env_root / 'upstream-switch').is_symlink())

    def test_insufficient_space_and_permission_failure_leave_original_unchanged(self):
        before = self.hashes()
        with patch.object(self.module.shutil, 'disk_usage', return_value=(100, 99, 1)):
            with self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.env_root.exists())
        with patch.object(self.module.Path, 'mkdir', side_effect=PermissionError('read only')):
            with self.assertRaises(PermissionError):
                self.prepare()
        self.assertEqual(self.hashes(), before)

    def test_disk_budget_retains_both_environments_cache_and_scratch(self):
        with patch.object(self.module, 'allocated_bytes', return_value=1024) as usage:
            budget = self.module.space_required(self.original, self.stage)
        self.assertEqual(usage.call_count, 2)
        self.assertGreaterEqual(budget, 2048 + self.module.ENVIRONMENT_BYTES + self.module.CACHE_BYTES + self.module.SCRATCH_BYTES)

    def test_commands_run_as_dac_with_bounded_process_groups(self):
        completed = subprocess.CompletedProcess([], 0, 'ok', '')
        with patch.object(self.module, 'current_user', return_value='root'), \
                patch.object(self.module.os, 'geteuid', return_value=0), \
                patch.object(self.module.shutil, 'which', return_value='/usr/sbin/runuser'), \
                patch.object(self.module.subprocess, 'Popen') as popen:
            process = popen.return_value
            process.communicate.return_value = ('ok', '')
            process.returncode = 0
            self.assertEqual(self.module.execute(['python', '-c', 'pass'], user='dac', timeout=1), completed.stdout)
            args, kwargs = popen.call_args
            self.assertEqual(args[0][:4], ['runuser', '-u', 'dac', '--'])
            self.assertTrue(kwargs['start_new_session'])

    def fake_python(self):
        executable = self.root / 'bootstrap-python'
        executable.write_text('#!' + sys.executable + '\n' + '''
import json, os, pathlib, signal, sys, time
args = sys.argv[1:]
if '-c' in args:
    if 'sys.version_info' in args[-1]: print('3.9')
    elif os.environ.get('INSTALL_CASE') == 'bootstrap': sys.exit(1)
elif 'venv' in args:
    root = pathlib.Path(args[-1])
    (root / 'bin').mkdir(exist_ok=True)
    target = root / 'bin/python'
    target.write_bytes(pathlib.Path(__file__).read_bytes())
    target.chmod(0o755)
elif 'install' in args:
    root = pathlib.Path(__file__).parent.parent
    (root / 'installer.json').write_text(json.dumps(dict(pid=os.getpid(), group=os.getpgrp())))
    (root / 'partial-package').write_text('partial new install')
    mode = os.environ.get('INSTALL_CASE')
    if mode == 'failure': sys.exit(1)
    if mode == 'interrupt': os.kill(os.getpid(), signal.SIGKILL)
    if mode in ('timeout', 'kill-parent'): time.sleep(20)
elif 'freeze' in args:
    print('numpy==2.0.2')
''')
        executable.chmod(0o755)
        return executable

    def test_subprocess_install_faults_preserve_original_package_hashes(self):
        executable = self.fake_python()
        before = self.hashes()
        for mode in ('failure', 'timeout', 'interrupt', 'bootstrap'):
            with self.subTest(mode=mode):
                result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/prepare_upstream_env.py'),
                    '--stage', str(self.stage), '--env-root', str(self.env_root), '--original', str(self.original),
                    '--transaction', mode, '--python', str(executable), '--user', self.module.current_user(),
                    '--timeout', '1'], env={**os.environ, 'INSTALL_CASE': mode},
                    capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(self.hashes(), before)
                self.assertFalse((self.env_root / ('upstream-' + mode) / 'prepared.json').exists())

    def test_sigkill_during_preparation_never_publishes_the_environment(self):
        import json
        import signal
        executable = self.fake_python()
        before = self.hashes()
        process = subprocess.Popen([sys.executable, '-B', str(ROOT / 'scripts/prepare_upstream_env.py'),
            '--stage', str(self.stage), '--env-root', str(self.env_root), '--original', str(self.original),
            '--transaction', 'kill', '--python', str(executable), '--user', self.module.current_user()],
            env={**os.environ, 'INSTALL_CASE': 'kill-parent'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        marker = self.env_root / 'upstream-kill/installer.json'
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            os.kill(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, -signal.SIGKILL)
            self.assertEqual(self.hashes(), before)
            self.assertFalse((self.env_root / 'upstream-kill/prepared.json').exists())
            self.assertEqual(subprocess.check_output([str(self.python)], text=True), 'original-interpreter')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            if marker.exists():
                try:
                    os.killpg(json.loads(marker.read_text())['group'], signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def import_fixture(self):
        base = self.stage / 'biometrics'
        for directory in ('stream', 'sleep_detection', 'nats/js'):
            (base / directory).mkdir(parents=True)
        for module in ('numpy', 'scipy', 'pandas', 'cbor2', 'watchdog', 'sentry_sdk', 'nats/__init__', 'nats/js/api'):
            (base / (module + '.py')).write_text('')
        (base / 'get_logger.py').write_text('''
import logging
def _build_logger(logger, name): raise RuntimeError('live logger initialization')
def _init_sentry(): raise RuntimeError('live telemetry')
def get_logger(name=None):
    logger = logging.getLogger(name or 'free-sleep-stream')
    if not logger.handlers:
        _build_logger(logger, name)
        _init_sentry()
    return logger
''')
        (base / 'db.py').write_text('''
import sqlite3
from get_logger import get_logger
connection = sqlite3.connect(get_logger().folder_path + 'never-created.db')
connection.execute('CREATE TABLE example (value TEXT)')
SOURCE = 'staged'
''')
        for module in ('stream/stream_processor', 'load_raw_files', 'sleep_detection/sleep_detector', 'service_health', 'nats_client'):
            (base / (module + '.py')).write_text("from db import SOURCE\nassert SOURCE == 'staged'\n")
        (base / 'stream/stream.py').write_text("from stream_processor import SOURCE\nassert SOURCE == 'staged'\nif __name__ == '__main__': raise RuntimeError('stream launched')\n")
        scratch = self.root / 'scratch'
        scratch.mkdir()
        return base, scratch

    def validate_imports(self, scratch):
        return subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'scripts/validate_upstream_imports.py'),
                               str(self.stage), str(scratch)], capture_output=True, text=True, timeout=10)

    def test_staged_imports_exercise_application_code_with_memory_database(self):
        _, scratch = self.import_fixture()
        result = self.validate_imports(scratch)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Staged upstream application imports passed', result.stdout)
        self.assertFalse(list(scratch.iterdir()))
        self.assertFalse(list(self.stage.rglob('__pycache__')))

    def test_staged_import_errors_and_external_side_effects_fail_validation(self):
        base, scratch = self.import_fixture()
        for source, message in [
            ("raise ImportError('delayed import failed')", 'delayed import failed'),
            ("import socket; socket.socket().connect(('127.0.0.1', 3000))", 'External side effect'),
            ("open('/persistent/free-sleep-data/settings.json').read()", 'Live data read'),
            ("open('/home/dac/free-sleep/biometrics/db.py').read()", 'Live data read'),
            ("open('changed.py', 'w').write('changed')", 'Write outside import scratch'),
            ("import threading; threading.Thread(target=lambda: None).start()", 'Background worker'),
        ]:
            with self.subTest(message=message):
                (base / 'stream/stream_processor.py').write_text(source)
                result = self.validate_imports(scratch)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
        self.assertFalse((base / 'changed.py').exists())


if __name__ == '__main__':
    unittest.main()
