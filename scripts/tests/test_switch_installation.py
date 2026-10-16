"""Run cross-fork transactions against disposable installations, without devices."""
import fcntl
import importlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
LOWDB = json.loads((Path(__file__).parent / 'fixtures/switch_lowdb.json').read_text())
UPSTREAM_TARGET = dict(version='3.0.3', commit='a' * 40, treeSha256='b' * 64, date='2026-01-01')
import recover_switch
import switch_services
from switch_transaction import TransactionStore


def runner():
    return importlib.import_module('switch_installation')


class FixtureSystem:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.live = self.root / 'home/dac/free-sleep'
        self.data = self.root / 'persistent/free-sleep-data/lowdb'
        self.venv = self.root / 'home/dac/venv'
        self.store = TransactionStore(self.root / 'transactions')
        self.config = switch_services.Configuration(self.root, self.live)
        self.calls = []
        self.fail_readiness = False
        self.rules = '*filter\n:CUSTOM - [0:0]\n-A OUTPUT -j CUSTOM\nCOMMIT\n'

    def command(self, command, **kwargs):
        self.calls.append(command)
        if command[0].endswith('tables-save'):
            return self.rules
        if command[:2] == ['systemctl', 'show']:
            if '--property=ExecStart' in command:
                return '{ path=/bin/bash ; argv[]=/bin/bash ' + str(self.config.guard) + ' ; }'
            if '--property=ExecStopPost' in command:
                return ''
            if '--property=LoadState' in command:
                return 'loaded'
            return 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n'
        return ''

    def arm_recovery(self, stage):
        self.calls.append(['arm-recovery'])

    def operation(self, unit):
        return dict(unit=unit, invocationId='c' * 32)

    def services(self):
        return {unit: dict(active=unit == 'free-sleep.service', enabled=unit == 'free-sleep.service')
                for unit in recover_switch.SERVICES}

    def biometrics(self):
        return json.loads((self.data / 'servicesDB.json').read_text())['biometrics']['enabled']

    def stop(self):
        self.calls.append(['stop-writers'])

    def handoff(self, reason):
        self.calls.append(['handoff', reason])

    def prepare_environment(self, stage, transaction, direction):
        destination = self.root / 'home/dac/free-sleep-envs' / ('upstream-' + transaction)
        (destination / 'bin').mkdir(parents=True)
        (destination / 'bin/python').write_text('upstream packages')
        return destination

    def validate(self, version, enabled, token, probe):
        self.calls.append(['validate', version, enabled])
        if self.fail_readiness:
            raise ValueError('readiness failed')

    def migrate_database(self):
        self.calls.append(['additive-migrations'])

    def controller(self, *arguments):
        self.calls.append(list(arguments))
        return ''


def create_tree(path, fork, version):
    for folder in ('server/src', 'server/dist', 'server/public', 'server/node_modules', 'scripts'):
        (path / folder).mkdir(parents=True)
    (path / 'server/src/serverInfo.json').write_text(json.dumps(dict(version=version, fork=fork)))
    (path / 'server/dist/server.js').write_text('code ' + fork)
    (path / 'server/public/index.html').write_text('app ' + fork)
    (path / 'server/package-lock.json').write_text('lock')
    (path / 'server/node_modules/marker').write_text('dependencies')
    (path / 'server/.env.pod').write_text('original environment ' + fork)
    if fork == 'LTimothy/nightstand':
        (path / 'scripts/systemd').mkdir()
        for unit in ('free-sleep-archive-raw.service', 'free-sleep-archive-raw.timer'):
            (path / 'scripts/systemd' / unit).write_text('[Unit]\nDescription=Archive\n')
    for name in ('update_service.sh', 'sqlite_maintenance.py', 'block_internet_access.sh'):
        (path / 'scripts' / name).write_text('original ' + fork)


def populate(system):
    create_tree(system.live, 'LTimothy/nightstand', '3.6.1')
    stage = system.live.parent / 'stage'
    create_tree(stage, 'throwaway31265/free-sleep', '3.0.3')
    system.data.mkdir(parents=True)
    for name, value in LOWDB.items():
        (system.data / name).write_text(json.dumps(value))
    (system.data / 'left_cap_baseline.json').write_text('nightstand baseline')
    (system.data / 'left_cap_baseline.json').chmod(0o640)
    (system.venv / 'bin').mkdir(parents=True)
    (system.venv / 'bin/python').write_text('nightstand packages')
    for path in system.config.files():
        path.parent.mkdir(parents=True, exist_ok=True)
    (system.config.systemd / 'free-sleep-update.service').write_text('nightstand updater')
    (system.config.systemd / 'free-sleep-update.service').chmod(0o640)
    return stage


def offline_recover(system):
    def shell(command, **kwargs):
        if command[0] == 'bash' and command[3] == 'restore-dependencies':
            live, failed = Path(command[5]), Path(command[6])
            if not (live / 'server/node_modules').exists() and (failed / 'server/node_modules').exists():
                shutil.move(str(failed / 'server/node_modules'), str(live / 'server/node_modules'))
        return subprocess.CompletedProcess(command, 0)
    with patch.object(recover_switch.subprocess, 'run', side_effect=shell), \
            patch.object(recover_switch, 'controller', side_effect=system.controller), \
            patch.object(switch_services, 'execute', side_effect=system.command):
        recover_switch.restore(system.store, SCRIPTS / 'restore_helpers.sh')


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.system = FixtureSystem(self.temporary.name)
        self.stage = populate(self.system)
        self.runner = runner()
        self.command_patch = patch.object(switch_services, 'execute', side_effect=self.system.command)
        self.command_patch.start()
        self.addCleanup(self.command_patch.stop)

    def forward(self):
        return self.runner.install(self.system, self.stage, target=UPSTREAM_TARGET,
                                   operation='free-sleep-revert.service')

    def test_installer_without_companion_uses_legacy_migration_regardless_of_source_metadata(self):
        source = (SCRIPTS / 'migrate/pod-installer.sh').read_text()
        start = source.index('# A transactional return')
        end = source.index('# ==============================================================================\n# Dead-man sentinel', start)
        block = source[start:end]
        for helper in SCRIPTS.glob('*.py'):
            shutil.copy2(helper, self.stage / 'scripts' / helper.name)
        metadata = self.system.live / 'server/src/serverInfo.json'
        for info in ('{"version":"2.1.5","branch":"main"}',
                     '{"version":"3.0.3","fork":"throwaway31265/free-sleep"}',
                     '{"version":"3.6.1","fork":"LTimothy/nightstand"}'):
            with self.subTest(metadata=info):
                metadata.write_text(info)
                result = subprocess.run(['bash', '-c', '''
set -uo pipefail
write_status() { echo "$*"; }
fail() { echo "$*" >&2; exit 1; }
python3() {
  if [ "$3" = return-companion ]; then command python3 "$@"
  else echo 'unexpected transaction return' >&2; return 99; fi
}
''' + block + '\necho legacy-migration'],
                    env=dict(os.environ, STAGE=str(self.stage), COPY=str(self.stage), LIVE=str(self.system.live),
                             REMOVE_FOREIGN='no', NIGHTSTAND_TRANSACTION_ROOT=str(self.system.store.root)),
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(result.stdout.strip(), 'legacy-migration')
                self.assertFalse(self.system.store.root.exists())

    def test_return_companion_ignores_forward_record_for_another_installation(self):
        other = FixtureSystem(self.system.root / 'other')
        stage = populate(other)
        other.store = self.system.store
        with patch.object(switch_services, 'execute', side_effect=other.command):
            self.runner.install(other, stage, target=UPSTREAM_TARGET, operation='free-sleep-revert.service')
        with patch.object(self.runner, 'System', return_value=self.system), \
                patch.object(sys, 'argv', ['switch_installation.py', 'return-companion']), \
                redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit) as stopped:
            self.runner.main()
        self.assertEqual(stopped.exception.code, 2)
        self.assertEqual(output.getvalue(), '')

    def test_return_companion_requires_a_confirmed_forward_switch(self):
        self.runner.install(self.system, self.stage, operation='free-sleep-revert.service')
        with patch.object(self.runner, 'System', return_value=self.system), \
                patch.object(sys, 'argv', ['switch_installation.py', 'return-companion']), \
                redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit) as stopped:
            self.runner.main()
        self.assertEqual(stopped.exception.code, 2)
        self.assertEqual(output.getvalue(), '')

    def test_forward_arms_before_stop_and_commits_after_readiness_and_configuration(self):
        transaction = self.forward()
        self.assertEqual(self.system.store.load(transaction)['phase'], 'cleaned')
        self.assertLess(self.system.calls.index(['arm-recovery']), self.system.calls.index(['stop-writers']))
        self.assertIn(['validate', '3.0.3', False], self.system.calls)
        self.assertFalse((self.system.data / 'left_cap_baseline.json').exists())
        self.assertTrue(self.system.venv.is_symlink())
        self.assertEqual(json.loads((self.system.data / 'settingsDB.json').read_text())['temperatureFormat'], 'fahrenheit')
        self.assertEqual((self.system.live.parent / 'free-sleep-prev/server/.env.pod').read_text(), 'original environment LTimothy/nightstand')

    def test_return_killed_before_journal_publication_allows_startup_with_retained_journal(self):
        retained = self.forward()
        create_tree(self.system.live.parent / 'return-stage', 'LTimothy/nightstand', '3.7.0')
        result = subprocess.run([sys.executable, '-B', __file__, '--kill-fixture',
                                 str(self.system.root), 'armed:before', 'return', retained],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr)
        offline_recover(self.system)
        check = subprocess.run(['bash', str(SCRIPTS / 'recover_switch.sh'), '--startup-check',
                                'free-sleep.service'],
                               env=dict(os.environ, NIGHTSTAND_TRANSACTION_ROOT=str(self.system.store.root)),
                               capture_output=True, text=True, timeout=5)
        self.assertEqual(check.returncode, 0, check.stderr)
        self.assertEqual(self.runner.fork(self.system.live), 'upstream')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'upstream packages')

    def rollback_admission(self, previous, helper=True):
        if helper:
            for source in SCRIPTS.glob('*.py'):
                shutil.copy2(source, self.system.live / 'scripts' / source.name)
        script = (SCRIPTS / 'rollback_pod.sh').read_text()
        start = script.index('# Cross-fork rollback requires companion state')
        end = script.index('# Other forks cannot run', start)
        body = script[start:end]
        setup = '''
fail() { echo "$*" >&2; exit 1; }
say() { :; }
recheck_in_use() { :; }
restore_cross_fork_rollback() {
  python3 -B "$LIVE/scripts/switch_installation.py" companion --stage "$PREV" || return 1
  echo companion
}
'''
        return subprocess.run(['bash', '-c', 'source ' + shlex.quote(str(SCRIPTS / 'restore_helpers.sh')) + '\n' + setup + body + '\necho ordinary'],
                              env=dict(os.environ, LIVE=str(self.system.live), PREV=str(previous),
                                       NIGHTSTAND_TRANSACTION_ROOT=str(self.system.store.root)),
                              capture_output=True, text=True, timeout=10)

    def test_historical_nightstand_rollbacks_follow_ordinary_path_without_companion(self):
        previous = self.system.live.parent / 'free-sleep-prev'
        create_tree(previous, 'LTimothy/nightstand', '3.0.0')
        # The old admission fallback treated the missing archive helper as upstream.
        (self.system.live / 'scripts/archive-raw.sh').write_text('archive')
        for version in ('3.0.0', '3.5.0'):
            historical = Path(__file__).parent / ('fixtures/serverInfo-v' + version + '.json')
            shutil.copy2(historical, previous / 'server/src/serverInfo.json')
            for helper in (False, True):
                with self.subTest(version=version, helper=helper):
                    if not helper:
                        (self.system.live / 'scripts/switch_installation.py').unlink(missing_ok=True)
                    result = self.rollback_admission(previous, helper=helper)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), 'ordinary')

    def test_recorded_upstream_without_fork_field_requires_companion_rollback(self):
        metadata = self.stage / 'server/src/serverInfo.json'
        metadata.write_text('{"version":"3.0.3","branch":"main"}')
        target = dict(version='3.0.3', commit='a' * 40, treeSha256='b' * 64, date='2026-01-01')
        forward = self.runner.install(self.system, self.stage, target=target)
        create_tree(self.stage, 'LTimothy/nightstand', '3.7.0')
        returned = self.runner.install(self.system, self.stage, retained=forward,
                                       operation='free-sleep-migrate.service')
        previous = self.system.live.parent / 'free-sleep-prev'
        result = self.rollback_admission(previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines(), [returned, 'companion'])

    def test_legacy_migration_from_another_repository_keeps_instant_rollback(self):
        shutil.rmtree(self.system.live)
        create_tree(self.system.live, 'throwaway31265/free-sleep', '3.0.3')
        shutil.rmtree(self.stage)
        create_tree(self.stage, 'LTimothy/nightstand', '3.7.0')
        for source in SCRIPTS.glob('*.py'):
            shutil.copy2(source, self.stage / 'scripts' / source.name)
        shutil.copy2(SCRIPTS / 'restore_helpers.sh', self.stage / 'scripts/restore_helpers.sh')
        installer = (SCRIPTS / 'migrate/pod-installer.sh').read_text()
        swap = installer[installer.index('# Preserve the pod\'s own rollback slot'):
                         installer.index('say "Installing the RAW-archive timer units..."')]
        previous = self.system.live.parent / 'free-sleep-prev'
        environment = dict(os.environ, LIVE=str(self.system.live), PREV=str(previous), STAGE=str(self.stage),
                           PREEXISTING_PREV=str(previous) + '-preexisting',
                           SWAP_MARKER=str(self.system.root / 'swap-marker'))
        migrated = subprocess.run(['bash', '-c', 'set -uo pipefail\nsay() { :; }\nchown() { :; }\n'
                                   'restore_and_report() { exit 91; }\n' + swap],
                                  env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(migrated.returncode, 0, migrated.stderr)
        self.assertEqual(self.runner.fork(previous), 'upstream')
        self.assertEqual(recover_switch.journals(self.system.store), [])

        script = (SCRIPTS / 'rollback_pod.sh').read_text()
        # One pass, so a root under /tmp is not rewritten again.
        script = re.sub(r'/(?:home/dac|persistent|etc|tmp)/', lambda match: str(self.system.root) + match.group(0), script)
        rollback = self.system.live / 'scripts/rollback_pod.sh'
        rollback.write_text(script)
        (self.system.root / 'tmp').mkdir()
        wrappers = '''
systemctl() {
  case "$1" in
    stop) rm -f "$TEST_RUNNING" ;;
    start) touch "$TEST_RUNNING" ;;
    is-active)
      if [ "$2" = free-sleep ] && [ -f "$TEST_RUNNING" ]; then echo active; return 0; fi
      echo inactive; return 3 ;;
  esac
}
curl() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then
      printf '%s' '{"freeSleep":{"version":"3.0.3"},"left":{"currentTemperatureF":80}}' > "$2"
      printf 200
      return 0
    fi
    shift
  done
}
sleep() { :; }
chown() { :; }
export -f systemctl curl sleep chown
bash "$TEST_ROLLBACK"
'''
        result = subprocess.run(['bash', '-c', wrappers], capture_output=True, text=True, timeout=15,
                                env=dict(environment, TEST_ROLLBACK=str(rollback),
                                         TEST_RUNNING=str(self.system.root / 'running'),
                                         NIGHTSTAND_OPERATION_LOCK=str(self.system.root / 'operation.lock'),
                                         NIGHTSTAND_TRANSACTION_ROOT=str(self.system.store.root)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('SUCCESS: pod is serving v3.0.3', result.stdout)
        self.assertEqual(self.runner.fork(self.system.live), 'upstream')
        self.assertEqual(self.runner.fork(previous), 'nightstand')
        self.assertEqual(recover_switch.journals(self.system.store), [])

    def test_unrecorded_fork_labels_do_not_require_companion_state(self):
        previous = self.system.live.parent / 'free-sleep-prev'
        create_tree(previous, 'throwaway31265/free-sleep', '3.0.3')
        for repository in ('throwaway31265/free-sleep', None):
            for tree in (self.system.live, previous):
                info = {'version': '3.0.3'}
                if repository is not None:
                    info['fork'] = repository if tree == previous else 'LTimothy/nightstand'
                (tree / 'server/src/serverInfo.json').write_text(json.dumps(info))
            with self.subTest(repository=repository):
                result = self.rollback_admission(previous)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'ordinary')

    def test_recorded_rollback_rejects_damaged_companion_before_ordinary_path(self):
        self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        (previous / 'server/dist/server.js').write_text('tampered')
        result = self.rollback_admission(previous)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('ordinary', result.stdout)

    def test_recorded_tree_requires_companion_when_fork_labels_agree(self):
        transaction = self.forward()
        metadata = self.system.live / 'server/src/serverInfo.json'
        metadata.write_text('{"version":"3.0.3","fork":"LTimothy/nightstand"}')
        result = self.rollback_admission(self.system.live.parent / 'free-sleep-prev')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines(), [transaction, 'companion'])

    def test_unrelated_published_record_keeps_ordinary_rollback(self):
        self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        previous.rename(self.system.live.parent / 'older-retained-tree')
        create_tree(previous, 'LTimothy/nightstand', '3.6.1')
        result = self.rollback_admission(previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'ordinary')

    def test_disabled_biometrics_forward_and_return_restore_absent_environment(self):
        shutil.rmtree(self.system.venv)
        original = self.forward()
        record = recover_switch.recovery_record(self.system.store.load(original))
        environment = next(item for item in record['paths'] if item['kind'] == 'environment')
        self.assertIs(environment['absent'], True)
        create_tree(self.stage, 'LTimothy/nightstand', '3.7.0')
        returned = self.runner.install(self.system, self.stage, retained=original,
                                       operation='free-sleep-migrate.service')
        self.assertFalse(os.path.lexists(str(self.system.venv)))
        self.assertEqual(self.system.store.load(returned)['phase'], 'cleaned')

    def test_failed_forward_restores_absent_environment(self):
        shutil.rmtree(self.system.venv)
        self.system.fail_readiness = True
        with self.assertRaisesRegex(ValueError, 'readiness failed'):
            self.forward()
        offline_recover(self.system)
        self.assertFalse(os.path.lexists(str(self.system.venv)))
        self.assertEqual(self.runner.fork(self.system.live), 'nightstand')

    def test_failed_return_restores_absent_environment(self):
        shutil.rmtree(self.system.venv)
        original = self.forward()
        self.system.venv.unlink()
        create_tree(self.stage, 'LTimothy/nightstand', '3.7.0')
        self.system.fail_readiness = True
        with self.assertRaisesRegex(ValueError, 'readiness failed'):
            self.runner.install(self.system, self.stage, retained=original,
                                operation='free-sleep-migrate.service')
        offline_recover(self.system)
        self.assertFalse(os.path.lexists(str(self.system.venv)))
        self.assertEqual(self.runner.fork(self.system.live), 'upstream')

    def test_return_without_companion_accepts_disabled_biometrics_and_no_environment(self):
        shutil.rmtree(self.system.venv)
        shutil.rmtree(self.system.live)
        shutil.move(str(self.stage), str(self.system.live))
        create_tree(self.stage, 'LTimothy/nightstand', '3.7.0')
        transaction = self.runner.install(self.system, self.stage, operation='free-sleep-migrate.service')
        self.assertEqual(self.system.store.load(transaction)['phase'], 'cleaned')
        self.assertEqual(self.runner.fork(self.system.live), 'nightstand')

    def test_settings_conversion_flushes_each_published_directory_before_validation(self):
        with patch.object(self.runner.calibration, 'fsync_directory', wraps=self.runner.calibration.fsync_directory) as flush:
            self.forward()
        # One baseline removal and both converted settings files must be durable.
        self.assertEqual(flush.call_count, 3)
        self.assertTrue(all(call.args == (self.system.data,) for call in flush.call_args_list))

    def test_recovery_is_armed_from_the_runners_own_scripts_never_a_tree(self):
        for tree in (self.system.live, self.stage):
            (tree / 'scripts').mkdir(parents=True, exist_ok=True)
            for name in ('recover_switch.sh', 'close_update_window.sh', 'setup_services.sh'):
                (tree / 'scripts' / name).write_text('echo edited by the server user\n')
        calls = []
        with patch.object(subprocess, 'run', side_effect=lambda command, **kwargs: calls.append(command)):
            self.runner.System.arm_recovery(self.system, self.stage)
        self.assertEqual(calls, [['bash', str(SCRIPTS / 'close_update_window.sh')],
                                 ['bash', str(SCRIPTS / 'setup_services.sh'), str(SCRIPTS.parent), '--recovery-only']])

    def test_return_retains_the_artifact_helper_before_cleanup_and_finishes_it_after_commit(self):
        retained = self.forward()
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        (next_stage / 'scripts/migrate').mkdir()
        # Root runs the helper from the copy this runner started from, never the stage.
        payload = (SCRIPTS / 'migrate/fork-artifacts.sh').read_bytes()
        (next_stage / 'scripts/migrate/fork-artifacts.sh').write_bytes(b'#!/bin/bash\necho edited by the server user\n')
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            script = Path(command[1])
            journal = max(recover_switch.journals(self.system.store), key=lambda item: item['metadata']['generation'])
            self.assertEqual(script.read_bytes(), payload)
            intent = next(item for item in journal['intents'] if item['name'] == 'migration-artifacts')
            self.assertEqual(intent['details']['path'], str(script))
            self.assertEqual(intent['details']['sha256'], self.runner.digest(payload))
            self.assertEqual(journal['phase'], 'armed' if command[2] == 'clean' else 'committed')
            return subprocess.CompletedProcess(command, 0)
        with patch.object(self.system, 'clean_foreign', create=True,
                          side_effect=lambda transaction, stage: self.runner.System.clean_foreign(self.system, transaction, stage)), \
                patch.object(subprocess, 'run', side_effect=run):
            transaction = self.runner.install(self.system, next_stage, retained=retained, operation='free-sleep-migrate.service')
        self.assertEqual([call[2] for call in calls], ['clean', 'finish'])
        self.assertEqual(calls[0][1], calls[1][1])
        self.assertEqual(self.system.store.load(transaction)['phase'], 'cleaned')

    def test_enabled_validation_keeps_probe_writes_outside_retained_python_environments(self):
        (self.system.data / 'servicesDB.json').write_text('{"biometrics":{"enabled":true}}')
        probes = []
        with patch.object(self.system, 'validate', side_effect=lambda version, enabled, token, path: probes.append(path)):
            original = self.forward()
            next_stage = self.system.live.parent / 'return-stage'
            create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
            self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        for probe in probes:
            self.assertIn('free-sleep-probes', probe.parts)
            self.assertFalse((probe.parent / 'bin/python').exists())
            self.assertTrue((probe.parent / 'nightstand_stream_probe.py').is_file())
        self.assertFalse((self.system.venv / 'nightstand_stream_probe.py').exists())
        self.assertFalse((self.system.config.systemd / 'free-sleep-stream.service.d/nightstand-validation.conf').exists())

    def test_failed_readiness_restores_exact_source_bytes_modes_absence_and_environment(self):
        self.system.fail_readiness = True
        with self.assertRaises(ValueError):
            self.forward()
        offline_recover(self.system)
        self.assertEqual(json.loads((self.system.live / 'server/src/serverInfo.json').read_text())['version'], '3.6.1')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'nightstand packages')
        self.assertFalse(self.system.venv.is_symlink())
        baseline = self.system.data / 'left_cap_baseline.json'
        self.assertEqual(baseline.read_text(), 'nightstand baseline')
        self.assertEqual(baseline.stat().st_mode & 0o777, 0o640)
        self.assertFalse((self.system.data / 'right_cap_baseline.json').exists())
        self.assertEqual((self.system.config.systemd / 'free-sleep-update.service').read_text(), 'nightstand updater')
        self.assertEqual(json.loads((self.system.data / 'settingsDB.json').read_text())['temperatureFormat'], 'level')
        offline_recover(self.system)

    def test_return_without_previous_nightstand_state_quarantines_unknown_baselines(self):
        shutil.rmtree(self.system.live)
        shutil.move(str(self.stage), str(self.system.live))
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        # The installer copies the stage's scripts for root before the return.
        subprocess.run([sys.executable, '-B', str(SCRIPTS / 'system_scripts.py'), 'publish', str(next_stage)], check=True,
                       capture_output=True, env=dict(os.environ, NIGHTSTAND_SYSTEM_DIR=str(self.system.config.system)))
        schedules = (self.system.data / 'schedulesDB.json').read_bytes()
        transaction = self.runner.install(self.system, next_stage, operation='free-sleep-migrate.service')
        self.assertFalse((self.system.data / 'left_cap_baseline.json').exists())
        self.assertEqual((self.system.data / 'schedulesDB.json').read_bytes(), schedules)
        self.assertEqual(self.system.store.load(transaction)['source']['fork'], 'upstream')
        self.assertTrue((self.system.config.systemd / 'free-sleep-archive-raw.timer').is_file())

    def test_return_preserves_new_history_schedule_edits_plan_data_and_both_calibration_sets(self):
        original = self.forward()
        (self.system.data / 'left_cap_baseline.json').write_text('new upstream calibration')
        (self.system.data / 'right_cap_baseline.json').write_text('new right calibration')
        schedules = '{"left":{"newWeeklyEdit":true},"right":{}}'
        (self.system.data / 'schedulesDB.json').write_text(schedules)
        history = self.system.data.parent / 'free-sleep.db'
        history.write_bytes(b'new sleep history')
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        transaction = self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        self.assertEqual((self.system.data / 'schedulesDB.json').read_text(), schedules)
        self.assertEqual(history.read_bytes(), b'new sleep history')
        for name, value in LOWDB.items():
            if name not in ('settingsDB.json', 'schedulesDB.json', 'servicesDB.json'):
                self.assertEqual((self.system.data / name).read_text(), json.dumps(value))
        self.assertEqual((self.system.data / 'left_cap_baseline.json').read_text(), 'nightstand baseline')
        self.assertFalse((self.system.data / 'right_cap_baseline.json').exists())
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'nightstand packages')
        journal = self.system.store.load(transaction)
        backup = journal['snapshots']['baseline-left']['backup']
        self.assertEqual((self.system.store.directory(transaction) / backup).read_text(), 'new upstream calibration')
        self.assertFalse((self.system.config.systemd / 'free-sleep-update.service.d/sqlite-maintenance.conf').exists())

    def test_upstream_update_can_replace_its_rollback_slot_without_losing_nightstand(self):
        original = self.forward()
        shutil.rmtree(self.system.live.parent / 'free-sleep-prev')
        (self.system.data / 'left_cap_baseline.json').write_text('recalibrated after upstream update')
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'nightstand packages')
        self.assertEqual((self.system.data / 'left_cap_baseline.json').read_text(), 'nightstand baseline')

    def test_successful_return_restores_archive_state_and_saved_custom_firewall(self):
        states = self.system.services()
        states['free-sleep-archive-raw.timer'] = dict(active=True, enabled=True)
        with patch.object(self.system, 'services', return_value=states):
            original = self.forward()
        self.system.calls.clear()
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        self.assertIn(['enable', 'free-sleep-archive-raw.timer'], self.system.calls)
        self.assertIn(['start', '--no-block', 'free-sleep-archive-raw.timer'], self.system.calls)
        self.assertIn(['iptables-restore'], self.system.calls)
        self.assertIn(['ip6tables-restore'], self.system.calls)
        policy = ['sh', str(self.system.config.system / 'live/scripts/block_internet_access.sh')]
        self.assertLess(self.system.calls.index(policy), self.system.calls.index(['iptables-restore']))

    def test_failed_return_restores_new_upstream_calibration_updater_and_environment(self):
        original = self.forward()
        (self.system.data / 'left_cap_baseline.json').write_text('latest upstream calibration')
        (self.system.config.guard).write_text('latest upstream updater')
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        self.system.fail_readiness = True
        with self.assertRaises(ValueError):
            self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        offline_recover(self.system)
        self.assertEqual((self.system.data / 'left_cap_baseline.json').read_text(), 'latest upstream calibration')
        self.assertEqual(self.system.config.guard.read_text(), 'latest upstream updater')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'upstream packages')
        self.assertEqual(json.loads((self.system.live / 'server/src/serverInfo.json').read_text())['version'], '3.0.3')

    def test_cross_fork_rollback_requires_complete_matching_companion_state_before_stopping(self):
        previous = self.system.live.parent / 'free-sleep-prev'
        create_tree(previous, 'throwaway31265/free-sleep', '3.0.3')
        with self.assertRaises(ValueError):
            self.runner.find_companion(self.system.store, previous)
        self.assertNotIn(['stop-writers'], self.system.calls)
        transaction = self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        self.assertEqual(self.runner.find_companion(self.system.store, previous), transaction)
        (previous / 'server/dist/server.js').write_text('tampered')
        with self.assertRaises(ValueError):
            self.runner.find_companion(self.system.store, previous)

    def test_rollback_and_failed_rollback_restore_coherent_installations_and_slot(self):
        self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        retained = self.runner.find_companion(self.system.store, previous)
        self.system.fail_readiness = True
        with self.assertRaises(ValueError):
            self.runner.install(self.system, previous, retained=retained, operation='free-sleep-rollback.service')
        offline_recover(self.system)
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'upstream packages')
        self.assertEqual(self.runner.find_companion(self.system.store, previous), retained)
        self.system.fail_readiness = False
        self.runner.install(self.system, previous, retained=retained, operation='free-sleep-rollback.service')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'nightstand packages')
        upstream = self.runner.find_companion(self.system.store, previous)
        self.runner.install(self.system, previous, retained=upstream, operation='free-sleep-rollback.service')
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'upstream packages')

    def test_cross_fork_rollback_after_upstream_dependency_update_uses_retained_dependencies(self):
        self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        (self.system.live / 'server/package-lock.json').write_text('updated upstream lock')
        (self.system.live / 'server/node_modules/marker').write_text('updated upstream dependencies')
        retained = self.runner.find_companion(self.system.store, previous)
        self.runner.install(self.system, previous, retained=retained, operation='free-sleep-rollback.service')
        self.assertEqual((self.system.live / 'server/node_modules/marker').read_text(), 'dependencies')

    def test_rollback_to_upstream_converts_intervening_nightstand_settings(self):
        original = self.forward()
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        (self.system.data / 'settingsDB.json').write_text('{"temperatureFormat":"level"}')
        previous = self.system.live.parent / 'free-sleep-prev'
        upstream = self.runner.find_companion(self.system.store, previous)
        self.runner.install(self.system, previous, retained=upstream, operation='free-sleep-rollback.service')
        self.assertEqual(json.loads((self.system.data / 'settingsDB.json').read_text())['temperatureFormat'], 'fahrenheit')

    def test_return_companion_follows_transaction_order_instead_of_uuid_order(self):
        with patch.object(self.runner, 'transaction_id', return_value='switch-' + 'f' * 32):
            original = self.forward()
        next_stage = self.system.live.parent / 'return-stage'
        create_tree(next_stage, 'LTimothy/nightstand', '3.7.0')
        self.runner.install(self.system, next_stage, retained=original, operation='free-sleep-migrate.service')
        (self.system.data / 'left_cap_baseline.json').write_text('latest Nightstand calibration')
        next_upstream = self.system.live.parent / 'next-upstream'
        create_tree(next_upstream, 'throwaway31265/free-sleep', '3.0.3')
        with patch.object(self.runner, 'transaction_id', return_value='switch-' + '1' * 32):
            latest = self.runner.install(self.system, next_upstream, target=UPSTREAM_TARGET,
                                         operation='free-sleep-revert.service')
        self.assertEqual(self.runner.return_companion(self.system.store, self.system.live), latest)

    def test_subprocess_kills_before_commit_restore_all_companion_state(self):
        for boundary in ('armed', 'writers-stopped', 'snapshots-ready', 'installing', 'quarantine-baselines',
                         'convert-settings', 'save-tree', 'publish-tree', 'save-environment',
                         'publish-environment', 'reconcile-system', 'validating', 'validation-startup',
                         'armed:before', 'writers-stopped:before', 'snapshots-ready:before',
                         'installing:before', 'validating:before', 'committed:before',
                         'stop-writers:after', 'quarantine-baselines:after', 'convert-settings:after',
                         'save-tree:after', 'publish-tree:after', 'save-environment:after',
                         'publish-environment:after', 'reconcile-system:after', 'readiness:after',
                         'copy-retained-slot', 'retained-slot-ready'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as folder:
                system = FixtureSystem(folder)
                populate(system)
                result = subprocess.run([sys.executable, '-B', __file__, '--kill-fixture', folder, boundary],
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr + result.stdout)
                if boundary == 'armed:before':
                    check = subprocess.run(['bash', str(SCRIPTS / 'recover_switch.sh'), '--check'],
                        env=dict(os.environ, NIGHTSTAND_TRANSACTION_ROOT=str(system.store.root)),
                        capture_output=True, text=True, timeout=5)
                    self.assertEqual(check.returncode, 0, check.stderr)
                else:
                    offline_recover(system)
                self.assertEqual((system.venv / 'bin/python').read_text(), 'nightstand packages')
                self.assertEqual((system.data / 'left_cap_baseline.json').read_text(), 'nightstand baseline')
                self.assertFalse((system.data / 'right_cap_baseline.json').exists())
                self.assertEqual(json.loads((system.data / 'settingsDB.json').read_text())['temperatureFormat'], 'level')
                self.assertEqual((system.config.systemd / 'free-sleep-update.service').read_text(), 'nightstand updater')
                self.assertEqual(json.loads((system.live / 'server/src/serverInfo.json').read_text())['version'], '3.6.1')

    def test_return_and_rollback_kills_restore_the_current_upstream_installation(self):
        boundaries = ('armed', 'writers-stopped', 'snapshots-ready', 'activate-companion:after',
                      'save-tree:after', 'publish-tree:after', 'save-environment:after',
                      'publish-environment:after', 'reconcile-system:after', 'validating',
                      'readiness:after', 'committed:before')
        for mode in ('return', 'rollback'):
            for boundary in boundaries:
                with self.subTest(mode=mode, boundary=boundary), tempfile.TemporaryDirectory() as folder:
                    system = FixtureSystem(folder)
                    stage = populate(system)
                    with patch.object(switch_services, 'execute', side_effect=system.command):
                        retained = self.runner.install(system, stage)
                    (system.data / 'left_cap_baseline.json').write_text('latest upstream calibration')
                    system.config.guard.write_text('latest upstream updater')
                    schedules = b'{"left":{"interveningEdit":true},"right":{}}'
                    (system.data / 'schedulesDB.json').write_bytes(schedules)
                    history = system.data.parent / 'free-sleep.db'
                    history.write_bytes(b'intervening sleep history')
                    if mode == 'return':
                        create_tree(system.live.parent / 'return-stage', 'LTimothy/nightstand', '3.7.0')
                    result = subprocess.run([sys.executable, '-B', __file__, '--kill-fixture', folder,
                                             boundary, mode, retained], capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr + result.stdout)
                    offline_recover(system)
                    self.assertEqual((system.venv / 'bin/python').read_text(), 'upstream packages')
                    self.assertEqual((system.data / 'left_cap_baseline.json').read_text(), 'latest upstream calibration')
                    self.assertEqual(system.config.guard.read_text(), 'latest upstream updater')
                    self.assertEqual((system.data / 'schedulesDB.json').read_bytes(), schedules)
                    self.assertEqual(history.read_bytes(), b'intervening sleep history')
                    self.assertEqual(self.runner.fork(system.live), 'upstream')
                    if mode == 'rollback':
                        self.assertEqual(self.runner.find_companion(system.store, system.live.parent / 'free-sleep-prev'), retained)

    def test_cleanup_failure_after_commit_reports_the_validated_target(self):
        self.forward()
        previous = self.system.live.parent / 'free-sleep-prev'
        finish = recover_switch.finish_committed
        calls = []
        def interrupted(store, journal, run_controller=None):
            calls.append(journal['id'])
            if len(calls) == 1:
                raise OSError('interrupted cleanup')
            return finish(store, journal, run_controller)
        output = io.StringIO()
        lock = str(self.system.root / 'operation.lock')
        with patch.object(self.runner, 'System', return_value=self.system), \
                patch.object(sys, 'argv', ['switch_installation.py', 'rollback', '--stage', str(previous)]), \
                patch.dict(os.environ, NIGHTSTAND_OPERATION_LOCK=lock), \
                patch.object(recover_switch, 'finish_committed', side_effect=interrupted), \
                patch.object(recover_switch, 'controller', side_effect=self.system.controller), \
                redirect_stdout(output):
            self.runner.main()
        self.assertEqual(self.runner.fork(self.system.live), 'nightstand')
        self.assertEqual(self.system.store.load(output.getvalue().strip())['phase'], 'cleaned')

    def test_post_commit_kill_only_resumes_cleanup(self):
        result = subprocess.run([sys.executable, '-B', __file__, '--kill-fixture', str(self.system.root), 'committed'],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, -signal.SIGKILL, result.stderr + result.stdout)
        offline_recover(self.system)
        self.assertEqual(json.loads((self.system.live / 'server/src/serverInfo.json').read_text())['version'], '3.0.3')
        self.assertFalse((self.system.data / 'left_cap_baseline.json').exists())
        self.assertEqual((self.system.venv / 'bin/python').read_text(), 'upstream packages')
        self.assertTrue((self.system.live.parent / 'free-sleep-prev').is_dir())
        self.assertTrue(all(j['phase'] == 'cleaned' for j in recover_switch.journals(self.system.store)))
        offline_recover(self.system)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--kill-fixture':
        system = FixtureSystem(sys.argv[2])
        boundary = sys.argv[3]
        mode = sys.argv[4] if len(sys.argv) > 4 else 'forward'
        retained = sys.argv[5] if len(sys.argv) > 5 else None
        original_write = TransactionStore._write
        def kill(point):
            if point == boundary:
                os.kill(os.getpid(), signal.SIGKILL)
        def interrupt(store, journal):
            kill(journal['phase'] + ':before')
            original_write(store, journal)
            kill(journal['phase'])
            if journal['intents']:
                kill(journal['intents'][-1]['name'])
        module = runner()
        original_move = module.move
        def moved(source, destination):
            original_move(source, destination)
            journal = max(recover_switch.journals(system.store), key=lambda item: item['metadata'].get('generation', 0))
            kill(journal['intents'][-1]['name'] + ':after')
        original_symlink = Path.symlink_to
        def symlinked(path, destination, **kwargs):
            original_symlink(path, destination, **kwargs)
            if path == system.venv:
                kill('publish-environment:after')
        def wrapped(function, point):
            def apply(*args, **kwargs):
                result = function(*args, **kwargs)
                kill(point)
                return result
            return apply
        with patch.object(TransactionStore, '_write', interrupt), \
                patch.object(switch_services, 'execute', side_effect=system.command), \
                patch.object(module, 'move', side_effect=moved), \
                patch.object(Path, 'symlink_to', symlinked), \
                patch.object(module.calibration, 'quarantine_baselines', wrapped(module.calibration.quarantine_baselines, 'quarantine-baselines:after')), \
                patch.object(module.calibration, 'prepare', wrapped(module.calibration.prepare, 'convert-settings:after')), \
                patch.object(switch_services, 'apply', wrapped(switch_services.apply, 'reconcile-system:after')), \
                patch.object(module, 'activate_companion', wrapped(module.activate_companion, 'activate-companion:after')), \
                patch.object(system, 'stop', wrapped(system.stop, 'stop-writers:after')), \
                patch.object(system, 'validate', wrapped(system.validate, 'readiness:after')):
            stage = system.live.parent / {'forward': 'stage', 'return': 'return-stage', 'rollback': 'free-sleep-prev'}[mode]
            unit = {'forward': 'free-sleep-revert.service', 'return': 'free-sleep-migrate.service', 'rollback': 'free-sleep-rollback.service'}[mode]
            module.install(system, stage, retained=retained, operation=unit)
        sys.exit(2)
    unittest.main()
