"""Check the fork-switch ordering and execute cleanup with local fixtures."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class MigrationRecovery(unittest.TestCase):
    def test_migration_admission_refuses_the_shared_operation_lock(self):
        import fcntl
        source = (ROOT / 'scripts/migrate/pod-installer.sh').read_text()
        block = source[source.index('# Share admission'):source.index('# --- lock:')]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'operation.lock'
            with path.open('w') as holder:
                fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
                environment = dict(os.environ, NIGHTSTAND_OPERATION_LOCK=str(path))
                environment.pop('NIGHTSTAND_OPERATION_OWNER', None)
                result = subprocess.run(['bash', '-c', 'set -uo pipefail\nwrite_status() { echo "$*"; }\n' + block],
                    env=environment, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('another maintenance operation holds the lock', result.stdout)
            result = subprocess.run(['bash', '-c', 'set -uo pipefail\nwrite_status() { echo "$*"; }\n' + block],
                env=environment, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_interrupted_artifact_completion_keeps_migration_locked(self):
        self.check_interrupted_completion(legacy_lock_removed=False)

    def test_lockless_restore_state_refuses_migration_until_recovered(self):
        self.check_interrupted_completion(legacy_lock_removed=True)

    def check_interrupted_completion(self, legacy_lock_removed):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            systemd = base / 'systemd'
            systemd.mkdir()
            migrate = base / 'migrate'
            migrate.mkdir()
            (migrate / 'restore_helpers.sh').write_text((ROOT / 'scripts/restore_helpers.sh').read_text())
            local_bin = base / 'local-bin'
            local_bin.mkdir()
            replacements = {'/home/dac/': str(base) + '/', '/persistent/': str(base) + '/persistent/',
                            '/usr/local/lib/nightstand/': str(base) + '/',
                            '/etc/systemd/system': str(systemd), '/usr/local/bin/': str(local_bin) + '/',
                            '/etc/sysctl.conf': str(base / 'sysctl.conf'),
                            '/tmp/free-sleep-migrate-health': str(base / 'health')}

            def localize(source):
                for original, replacement in replacements.items():
                    source = source.replace(original, replacement)
                return source

            restore = base / 'restore-original-fork.sh'
            restore.write_text(localize((ROOT / 'scripts/migrate/restore-original-fork.sh').read_text()))
            (migrate / 'fork-artifacts.sh').write_text(localize((ROOT / 'scripts/migrate/fork-artifacts.sh').read_text()))
            installer = (ROOT / 'scripts/migrate/pod-installer.sh').read_text()
            # Run the real preflight and swap, skipping download and database preparation.
            prefix = installer[:installer.index('# Free-space helpers')]
            recovery = installer[installer.index('disarm_sentinel() {'):installer.index('# ==============================================================================\n# Swap')]
            swap_section = installer[installer.index('write_status "swap"'):installer.index('# A fork moving here has no update channel yet')]
            runner = migrate / 'pod-installer.sh'
            runner.write_text(localize(prefix + '\nDATABASE=""\nCOPY="%s"\n' % (base / 'copy') + recovery + swap_section))
            live = base / 'free-sleep'
            prev = base / 'free-sleep-prev'
            older = base / 'free-sleep-prev-preexisting'
            for tree, identity in ((live, 'failed-first-migration'), (prev, 'original-install'), (older, 'older-rollback')):
                tree.mkdir()
                (tree / 'identity').write_text(identity)
            state_dir = base / 'persistent/nightstand-migrate'
            state_dir.mkdir(parents=True)
            marker = state_dir / 'free-sleep-migrate-swapped'
            marker.touch()
            lock = state_dir / 'free-sleep-migrate.lock'
            lock.touch()
            state = state_dir / 'free-sleep-migrate-restore-state'
            snapshot = state_dir / 'free-sleep-migrate-iptables-snapshot.rules'
            snapshot.write_text('first firewall')
            artifacts = base / 'free-sleep-migrate-artifacts'
            backup = artifacts / 'backup.fixture'
            backup.mkdir(parents=True)
            (artifacts / 'pending').write_text(str(backup))
            original_cron = '0 * * * * /usr/local/bin/sync-time-with-internet.sh\n'
            (backup / 'root.crontab').write_text(original_cron)
            (backup / 'free-sleep-ambient-light.service').write_text('original unit\n')
            (backup / 'sync-time-with-internet.sh').write_text('original time sync\n')
            cron = base / 'crontab'
            cron.write_text('filtered cron\n')
            calls = base / 'calls'
            wrapper = r'''
systemctl() {
  echo "systemctl $*" >> "$TEST_LOG"
  case "$1" in
    is-active) echo inactive; return 3 ;;
    is-enabled) echo enabled ;;
    list-unit-files) echo 'free-sleep-ambient-light.service enabled' ;;
  esac
}
crontab() {
  if [ "$3" = -l ]; then cat "$TEST_CRON"
  elif [ "$3" = - ]; then cat > "$TEST_CRON"
  else cat "$3" > "$TEST_CRON"; fi
}
rm() {
  if [ "$TEST_INTERRUPT" = yes ]; then
    for target in "$@"; do
      [ "$target" != "$TEST_BASE/persistent/nightstand-migrate/free-sleep-migrate-restore-state" ] || exit 97
    done
  fi
  command rm "$@"
}
iptables-restore() { echo firewall >> "$TEST_LOG"; cat > "$TEST_BASE/restored-firewall"; }
sudo() { echo 'injected database migration failure' >&2; return 1; }
chown() { :; }
curl() { return 0; }
sleep() { :; }
sync() { :; }
export -f systemctl crontab rm iptables-restore sudo chown curl sleep sync
bash "$TEST_SCRIPT" yes
'''
            env = {**os.environ, 'TEST_BASE': folder, 'TEST_LOG': str(calls), 'TEST_CRON': str(cron)}

            def run(script, interrupt=False):
                return subprocess.run(['bash', '-c', wrapper], capture_output=True, text=True, timeout=10,
                    env={**env, 'TEST_SCRIPT': str(script), 'TEST_INTERRUPT': 'yes' if interrupt else 'no'})

            interrupted = run(restore, interrupt=True)
            self.assertEqual(interrupted.returncode, 97, interrupted.stdout + interrupted.stderr)
            self.assertEqual((live / 'identity').read_text(), 'original-install')
            self.assertEqual((prev / 'identity').read_text(), 'older-rollback')
            self.assertFalse((artifacts / 'pending').exists(), 'interrupt after artifact completion')
            self.assertEqual(cron.read_text(), original_cron)
            self.assertEqual((systemd / 'free-sleep-ambient-light.service').read_text(), 'original unit\n')
            self.assertTrue(state.exists())
            if legacy_lock_removed:
                lock.unlink(missing_ok=True)
            else:
                self.assertTrue(lock.exists(), 'restore state must be removed before releasing the migration lock')
            stage = base / 'free-sleep-migrate-staging'
            stage.mkdir()
            (stage / 'identity').write_text('failed-second-migration')
            calls.write_text('')
            refused = run(runner)
            self.assertEqual(refused.returncode, 1, refused.stdout + refused.stderr)
            status = base / 'persistent/free-sleep-data/migration-status.json'
            self.assertEqual(json.loads(status.read_text())['outcome'], 'refused')
            self.assertTrue(state.exists())
            self.assertTrue(stage.exists(), 'refusal must not clean another migration staging tree')
            self.assertNotIn('systemctl stop', calls.read_text())
            self.assertEqual((live / 'identity').read_text(), 'original-install')
            completed = run(restore)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertFalse(state.exists())
            self.assertFalse(lock.exists())
            stage.mkdir()
            (stage / 'identity').write_text('failed-second-migration')
            snapshot.write_text('second firewall')
            calls.write_text('')
            failed = run(runner)
            self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
            self.assertIn('injected database migration failure', failed.stdout + failed.stderr)
            self.assertEqual(json.loads(status.read_text())['outcome'], 'restored')
            self.assertEqual((live / 'identity').read_text(), 'original-install')
            self.assertEqual((prev / 'identity').read_text(), 'older-rollback')
            self.assertFalse(older.exists())
            self.assertEqual((base / 'restored-firewall').read_text(), 'second firewall')
            self.assertIn('systemctl start free-sleep\n', calls.read_text())
            self.assertIn('systemctl start free-sleep-stream\n', calls.read_text())
            self.assertEqual(cron.read_text(), original_cron)
            self.assertEqual((systemd / 'free-sleep-ambient-light.service').read_text(), 'original unit\n')
            self.assertEqual((local_bin / 'sync-time-with-internet.sh').read_text(), 'original time sync\n')
            for pending in (marker, state, lock, artifacts / 'pending'):
                self.assertFalse(pending.exists(), str(pending))

    def test_artifact_failure_recovers_services_and_retries_without_swapping_trees(self):
        self.check_artifact_failure_recovery(swapped=True)

    def test_pre_swap_artifact_failure_still_recovers_firewall_and_services(self):
        self.check_artifact_failure_recovery(swapped=False)

    def check_artifact_failure_recovery(self, swapped):
        for failure in ('cron', 'unit'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                base = Path(folder)
                live = base / 'free-sleep'
                prev = base / 'free-sleep-prev'
                older = base / 'free-sleep-prev-preexisting'
                quarantine = base / 'free-sleep-migrate-aborted'
                trees = ((live, 'failed-migration'), (prev, 'original-install'), (older, 'older-rollback')) if swapped else ((live, 'original-install'), (prev, 'older-rollback'))
                for tree, contents in trees:
                    tree.mkdir()
                    (tree / 'identity').write_text(contents)
                state_dir = base / 'persistent/nightstand-migrate'
                state_dir.mkdir(parents=True)
                swap = state_dir / 'free-sleep-migrate-swapped'
                if swapped:
                    swap.touch()
                (state_dir / 'free-sleep-migrate-iptables-snapshot.rules').write_text('saved firewall')
                artifacts = base / 'free-sleep-migrate-artifacts'
                backup = artifacts / 'backup.fixture'
                backup.mkdir(parents=True)
                (artifacts / 'pending').write_text(str(backup))
                (backup / 'root.crontab').write_text('original cron\n')
                (backup / 'free-sleep-ambient-light.service').write_text('original unit\n')
                cron = base / 'crontab'
                cron.write_text('filtered cron\n')
                systemd = base / 'systemd'
                systemd.mkdir()
                migrate = base / 'migrate'
                migrate.mkdir()
                (migrate / 'restore_helpers.sh').write_text((ROOT / 'scripts/restore_helpers.sh').read_text())
                replacements = {'/home/dac/': str(base) + '/', '/persistent/': str(base) + '/persistent/',
                                '/usr/local/lib/nightstand/': str(base) + '/',
                                '/etc/systemd/system': str(systemd), '/tmp/free-sleep-migrate-health': str(base / 'health')}
                for name, target in (('restore-original-fork.sh', base / 'restore.sh'), ('fork-artifacts.sh', migrate / 'fork-artifacts.sh')):
                    source = (ROOT / 'scripts/migrate' / name).read_text()
                    for original, replacement in replacements.items():
                        source = source.replace(original, replacement)
                    target.write_text(source)
                calls = base / 'calls'
                wrapper = r'''
systemctl() {
  echo "systemctl $*" >> "$TEST_LOG"
  case "$1" in
    is-active) return 3 ;;
    is-enabled) echo enabled ;;
  esac
}
crontab() {
  echo "crontab $*" >> "$TEST_LOG"
  [ "$TEST_FAILURE" != cron ] || return 1
  cat "$3" > "$TEST_CRON"
}
cp() {
  echo "cp $*" >> "$TEST_LOG"
  [ "$TEST_FAILURE" != unit ] || return 1
  command cp "$@"
}
iptables-restore() { echo firewall >> "$TEST_LOG"; cat > "$TEST_BASE/restored-firewall"; }
curl() { return 0; }
sleep() { :; }
sync() { :; }
export -f systemctl crontab cp iptables-restore curl sleep sync
bash "$TEST_BASE/restore.sh"
'''
                env = {**os.environ, 'TEST_BASE': folder, 'TEST_LOG': str(calls), 'TEST_CRON': str(cron), 'TEST_FAILURE': failure}
                first = subprocess.run(['bash', '-c', wrapper], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(first.returncode, 1, first.stdout + first.stderr)
                self.assertEqual((live / 'identity').read_text(), 'original-install')
                self.assertEqual((prev / 'identity').read_text(), 'older-rollback')
                if swapped:
                    self.assertEqual((quarantine / 'identity').read_text(), 'failed-migration')
                else:
                    self.assertFalse(quarantine.exists())
                self.assertFalse(swap.exists(), 'tree swap marker must be retired after essential recovery')
                self.assertTrue((artifacts / 'pending').exists())
                state = state_dir / 'free-sleep-migrate-restore-state'
                self.assertEqual(state.read_text(), 'artifacts-pending\n')
                self.assertEqual((base / 'restored-firewall').read_text(), 'saved firewall')
                self.assertIn('systemctl start free-sleep\n', calls.read_text())
                self.assertIn('systemctl start free-sleep-stream\n', calls.read_text())
                self.assertNotIn('disable --now free-sleep-migrate-sentinel.timer', calls.read_text())
                status = base / 'persistent/free-sleep-data/migration-status.json'
                self.assertEqual(json.loads(status.read_text())['outcome'], 'restore_failed')
                self.assertIn('artifact', first.stdout.lower())
                calls.write_text('')
                second = subprocess.run(['bash', '-c', wrapper], env={**env, 'TEST_FAILURE': ''}, capture_output=True, text=True, timeout=10)
                self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
                self.assertEqual((live / 'identity').read_text(), 'original-install')
                self.assertEqual((prev / 'identity').read_text(), 'older-rollback')
                self.assertFalse(swap.exists())
                self.assertFalse((artifacts / 'pending').exists())
                self.assertFalse(state.exists())
                self.assertEqual(cron.read_text(), 'original cron\n')
                self.assertEqual((systemd / 'free-sleep-ambient-light.service').read_text(), 'original unit\n')
                self.assertNotIn('systemctl stop', calls.read_text())
                self.assertNotIn('systemctl start', calls.read_text())
                self.assertNotIn('firewall', calls.read_text())
                self.assertIn('disable --now free-sleep-migrate-sentinel.timer', calls.read_text())
                self.assertEqual(json.loads(status.read_text())['outcome'], 'auto-restored')

    def test_database_is_checked_before_swap(self):
        script = (ROOT / 'scripts/migrate/pod-installer.sh').read_text()
        check = script.index('Database compatibility preflight')
        self.assertLess(check, script.index(': > "$SWAP_MARKER"'))
        preflight = script[check:script.index('# Dead-man sentinel')]
        self.assertIn('sqlite-safety.py', preflight)
        self.assertIn('DATABASE_URL=', preflight)
        self.assertIn('migrate deploy', preflight)
        self.assertNotIn('dotenv', preflight)

    def test_restore_cleans_only_owned_service_artifacts(self):
        source = (ROOT / 'scripts/migrate/restore-original-fork.sh').read_text()
        start = source.index('cleanup_nightstand_services() {')
        end = source.index('\n}\n', start) + 3
        with tempfile.TemporaryDirectory() as folder:
            systemd = Path(folder)
            names = ['free-sleep-archive-raw.service', 'free-sleep-archive-raw.timer', 'free-sleep-health.service', 'free-sleep-health.timer', 'free-sleep-network-watchdog.service', 'free-sleep-network-watchdog.timer', 'free-sleep.service.d/10-nightstand-limits.conf', 'free-sleep-stream.service.d/10-nightstand-limits.conf', 'free-sleep.service.d/user.conf']
            for name in names:
                file = systemd / name
                file.parent.mkdir(exist_ok=True)
                file.write_text('fixture')
            result = subprocess.run(['bash', '-c', 'SYSTEMD_DIR="$1"; systemctl() { :; };\n' + source[start:end] + '\ncleanup_nightstand_services', 'test', folder], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in names[:-1]:
                self.assertFalse((systemd / name).exists(), name)
            self.assertTrue((systemd / names[-1]).exists())

    def test_sentinel_terminates_installer_before_restoring(self):
        source = (ROOT / 'scripts/migrate/restore-original-fork.sh').read_text()
        self.assertLess(source.index('stop_active_installer'), source.index('if [ ! -f "$SWAP_MARKER" ]'))
        self.assertIn('"${1:-}" = "--sentinel"', source)
        self.assertIn('free-sleep-migrate.service', source)
        self.assertIn('free-sleep-migrate-sentinel.service', source)
        installer = (ROOT / 'scripts/migrate/pod-installer.sh').read_text()
        self.assertIn('ExecStart=/bin/bash $RESTORE_SCRIPT_DEST --sentinel', installer)
        self.assertIn('free-sleep-migrate.pid', installer)
        self.assertIn('rm -rf "$STAGE"\n  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi', installer)


    def run_artifacts(self, mode, consent="no", cron_error=False, stop_error=False, empty=False, driver=None, missing_helper=False, restore_after=False, still_active=False, restore_driver=False, cron_text=None, unit_text=None, ambient_unit=True, setup=None):
        helper = ROOT / 'scripts/migrate/fork-artifacts.sh'
        self.assertTrue(helper.exists(), 'fork artifact inspection and cleanup is missing')
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            cron = base / 'crontab'
            cron.write_text('' if empty else (ROOT / 'fixtures/migrate/root.crontab').read_text())
            if cron_text is not None:
                cron.write_text(cron_text)
            systemd = base / 'systemd'
            systemd.mkdir()
            ambient = systemd / 'free-sleep-ambient-light.service'
            if not empty and ambient_unit:
                ambient.write_text('[Service]\nUser=root\nRestart=always\n')
            log = base / 'calls'
            log.touch()
            units = base / 'units'
            units.write_text('free-sleep.service enabled\n' if empty else (ROOT / 'fixtures/migrate/units.txt').read_text())
            if unit_text is not None:
                units.write_text(unit_text)
            script = base / 'helper.sh'
            script.write_text(helper.read_text().replace('/etc/systemd/system', str(systemd))
                .replace('/home/dac/', str(base) + '/').replace('/usr/local/lib/nightstand/', str(base) + '/')
                .replace('/persistent/', str(base) + '/persistent/')
                .replace('/usr/local/bin/', str(base) + '/local-bin/')
                .replace('/etc/sysctl.conf', str(base / 'sysctl.conf')))
            restore_script = base / 'restore.sh'
            restore_script.write_text((ROOT / 'scripts/migrate/restore-original-fork.sh').read_text()
                .replace('/home/dac/', str(base) + '/').replace('/usr/local/lib/nightstand/', str(base) + '/')
                .replace('/persistent/', str(base) + '/persistent/')
                .replace('/etc/systemd/system', str(systemd)))
            migrate_dir = base / 'migrate'
            migrate_dir.mkdir()
            (migrate_dir / 'restore_helpers.sh').write_text((ROOT / 'scripts/restore_helpers.sh').read_text())
            (migrate_dir / 'fork-artifacts.sh').write_text(script.read_text())
            local_bin = base / 'local-bin'
            local_bin.mkdir()
            legacy_script = local_bin / 'sync-time-with-internet.sh'
            if not empty:
                legacy_script.write_text('legacy time sync fixture')
            (base / 'sysctl.conf').write_text('# net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.all.disable_ipv6 = 1\n')
            if setup:
                setup(base)
            wrapper = r'''
crontab() {
  echo "crontab $*" >> "$TEST_LOG"
  if [ "$3" = -l ]; then
    [ "$CRON_ERROR" = no ] || { echo 'permission denied' >&2; return 1; }
    cat "$TEST_CRON"
  else
    cat "$3" > "$TEST_CRON"
  fi
}
systemctl() {
  echo "systemctl $*" >> "$TEST_LOG"
  case "$1" in
    list-unit-files) cat "$TEST_UNITS" ;;
    list-units) [ "$EMPTY" = yes ] || echo 'free-sleep-loaded-writer.service loaded active running Writer' ;;
    stop) [ "$STOP_ERROR" = no ] ;;
    is-active) if [ "$STILL_ACTIVE" = yes ]; then echo active; else echo inactive; return 3; fi ;;
  esac
}
sync() { :; }
export -f crontab systemctl sync
bash "$TEST_SCRIPT" "$TEST_MODE" "$TEST_CONSENT" || exit $?
if [ "$RESTORE_AFTER" = yes ]; then
  if [ "$RESTORE_DRIVER" = yes ]; then
    bash "$TEST_RESTORE_SCRIPT" || exit $?
  else
    bash "$TEST_SCRIPT" restore || exit $?
  fi
  [ -f "$TEST_BASE/local-bin/sync-time-with-internet.sh" ] || exit 98
fi
'''
            if driver == 'installer':
                source = (ROOT / 'scripts/migrate/pod-installer.sh').read_text()
                start = source.index('write_status "swap"')
                end = source.index('# Preserve the pod', start)
                wrapper = wrapper[:wrapper.index('bash "$TEST_SCRIPT"')] + r'''
ARTIFACT_HELPER="$TEST_SCRIPT"
REMOVE_FOREIGN="$TEST_CONSENT"
DATABASE="$TEST_CRON"
STAGE=fixture
say() { :; }
write_status() { :; }
restore_and_report() { echo "restore $*" >> "$TEST_LOG"; }
python3() { echo "checkpoint $*" >> "$TEST_LOG"; }
''' + source[start:end]
            elif driver == 'laptop':
                source = (ROOT / 'scripts/migrate/switch-to-this-fork.sh').read_text()
                start = source.index('if printf', source.index("Type 'switch' to proceed"))
                end = source.index('# Clock correction', start)
                wrapper = wrapper[:wrapper.index('bash "$TEST_SCRIPT"')] + r'''
FOREIGN_REPORT=$(bash "$TEST_SCRIPT" inspect) || exit 1
fail() { echo "$*" >&2; exit 1; }
''' + source[start:end]
            elif driver in ('install', 'update'):
                source = (ROOT / f'scripts/{driver}.sh').read_text()
                start = source.index('# Report legacy firewall jobs')
                end = source.index('\n', source.index('warn-cron', start)) + 1 if driver == 'update' else source.index('\nfi', start) + 3
                helper_dir = base / 'scripts/migrate'
                helper_dir.mkdir(parents=True)
                if not missing_helper:
                    (helper_dir / 'fork-artifacts.sh').write_text(script.read_text())
                recovery_helper = base / 'recovery-source/scripts/migrate/fork-artifacts.sh'
                recovery_helper.parent.mkdir(parents=True)
                recovery_helper.write_text(script.read_text())
                wrapper = wrapper[:wrapper.index('bash "$TEST_SCRIPT"')] + r'''
NIGHTSTAND_SCRIPTS="$TEST_BASE/recovery-source/scripts"
SRC_DIR="$TEST_BASE"
LIVE="$TEST_BASE"
''' + source[start:end]
            result = subprocess.run(['bash', '-c', wrapper], capture_output=True, text=True, input='decline\n',
                env={**os.environ, 'TEST_SCRIPT': str(script), 'TEST_LOG': str(log),
                     'TEST_CRON': str(cron), 'TEST_UNITS': str(units), 'TEST_MODE': mode,
                     'TEST_CONSENT': consent, 'CRON_ERROR': 'yes' if cron_error else 'no',
                     'STOP_ERROR': 'yes' if stop_error else 'no',
                     'RESTORE_AFTER': 'yes' if restore_after else 'no',
                     'RESTORE_DRIVER': 'yes' if restore_driver else 'no',
                     'TEST_RESTORE_SCRIPT': str(restore_script),
                     'STILL_ACTIVE': 'yes' if still_active else 'no',
                     'EMPTY': 'yes' if empty else 'no', 'TEST_BASE': folder})
            return result, cron.read_text(), ambient.exists(), log.read_text()

    def test_switch_recovery_unit_is_owned_and_not_stopped_as_a_foreign_writer(self):
        result, cron, ambient, log = self.run_artifacts('clean', empty=True,
            unit_text='free-sleep.service enabled\nfree-sleep-recover-switch.service enabled\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('unit: free-sleep-recover-switch.service', result.stdout)
        self.assertNotIn('systemctl stop free-sleep-recover-switch.service', log)
        self.assertEqual(cron, '')
        self.assertFalse(ambient)

    def test_foreign_artifacts_are_reported_without_changes(self):
        result, cron, ambient, log = self.run_artifacts('inspect')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cron:', result.stdout)
        self.assertIn('unit: free-sleep-ambient-light.service', result.stdout)
        self.assertIn('unit: free-sleep-loaded-writer.service', result.stdout)
        self.assertIn('ipv6: net.ipv6.conf.all.disable_ipv6 = 1', result.stdout)
        self.assertNotIn('ipv6: #', result.stdout)
        self.assertNotIn('unit: free-sleep-stream.service', result.stdout)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl stop', log)

    def test_cleanup_requires_consent_and_preserves_unrelated_cron(self):
        result, cron, ambient, log = self.run_artifacts('clean')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('consent', result.stderr.lower())
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl stop', log)
        result, cron, ambient, log = self.run_artifacts('clean', 'yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cron, 'MAILTO=""\n# Keep this comment: /usr/local/bin/sync-time-with-internet.sh\n15 2 * * * /usr/local/bin/backup.sh\n')
        self.assertFalse(ambient)
        self.assertIn('systemctl stop free-sleep-extra-writer.service', log)
        self.assertIn('systemctl stop free-sleep-loaded-writer.service', log)
        self.assertLess(log.index('systemctl stop free-sleep-extra-writer.timer'),
                        log.index('systemctl stop free-sleep-extra-writer.service'))
        self.assertNotIn('systemctl start', log)
        self.assertNotIn('systemctl enable', log)
        self.assertNotIn('systemctl stop free-sleep-stream.service', log)

    def test_unreadable_cron_and_failed_stop_refuse_cleanup(self):
        for options in ({'cron_error': True}, {'stop_error': True}, {'still_active': True}):
            result, cron, ambient, _ = self.run_artifacts('clean', 'yes', **options)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
            self.assertTrue(ambient)

    def test_failed_switch_can_restore_removed_files_without_enabling_foreign_units(self):
        result, cron, ambient, log = self.run_artifacts('clean', 'yes', restore_after=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl enable', log)
        self.assertNotIn('systemctl start', log)

    def test_cleanup_never_backs_up_through_a_folder_the_server_user_planted(self):
        for planted in ('free-sleep-migrate-artifacts', 'persistent/nightstand-migrate-artifacts'):
            with self.subTest(planted=planted):
                def plant(base):
                    (base / 'victim').mkdir()
                    (base / planted).parent.mkdir(parents=True, exist_ok=True)
                    (base / planted).symlink_to(base / 'victim')
                    self.victim = base / 'victim'
                result, cron, ambient, _ = self.run_artifacts('clean', 'yes', setup=plant)
                self.assertFalse(self.victim.exists() and any(self.victim.iterdir()), 'backup written through the link')
                if planted.startswith('persistent/'):
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
                    self.assertTrue(ambient)
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)

    def legacy_backup(self, base, mode=0o700, link=False):
        folder = base / ('elsewhere' if link else 'free-sleep-migrate-artifacts')
        backup = folder / 'backup.legacy'
        backup.mkdir(parents=True)
        (backup / 'root.crontab').write_text('legacy cron\n')
        (folder / 'pending').write_text(str(base / 'free-sleep-migrate-artifacts/backup.legacy'))
        if link:
            (base / 'free-sleep-migrate-artifacts').symlink_to(folder)
        folder.chmod(mode)

    def test_restore_takes_an_older_release_backup_only_from_a_folder_only_root_writes(self):
        result, cron, _, _ = self.run_artifacts('restore', empty=True, setup=self.legacy_backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cron, 'legacy cron\n')
        for options in ({'mode': 0o777}, {'link': True}):
            with self.subTest(**options):
                result, cron, _, _ = self.run_artifacts('restore', empty=True,
                                                        setup=lambda base: self.legacy_backup(base, **options))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(cron, '', 'installed a crontab the server user could have written')
                self.assertIn('skipped', result.stderr)

    def test_pre_swap_restore_recovers_removed_artifacts(self):
        result, cron, ambient, log = self.run_artifacts('clean', 'yes', restore_after=True, restore_driver=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl enable', log)
        self.assertNotIn('systemctl start free-sleep-ambient', log)
        self.assertNotIn('systemctl start free-sleep-extra', log)

    def test_cron_warning_does_not_modify_services_or_cron(self):
        result, cron, ambient, log = self.run_artifacts('warn-cron')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('WARNING', result.stdout)
        self.assertIn('firewall', result.stdout)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl', log)


    def test_no_foreign_artifacts_need_no_consent(self):
        result, cron, ambient, log = self.run_artifacts('clean', empty=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cron, '')
        self.assertFalse(ambient)
        self.assertNotIn('systemctl stop', log)

    def test_installer_stops_foreign_writers_before_checkpoint(self):
        result, _, _, log = self.run_artifacts('clean', 'yes', driver='installer')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(log.index('systemctl stop free-sleep-ambient-light.service'), log.index('checkpoint '))
        self.assertLess(log.index('systemctl stop free-sleep-loaded-writer.service'), log.index('checkpoint '))
        result, cron, ambient, log = self.run_artifacts('clean', driver='installer')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('checkpoint ', log)
        self.assertNotIn('systemctl stop', log)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)

    def test_laptop_declined_cleanup_changes_nothing(self):
        result, cron, ambient, log = self.run_artifacts('inspect', driver='laptop')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cleanup consent not given', result.stderr)
        self.assertNotIn('systemctl stop', log)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)

    def test_each_legacy_artifact_requires_cleanup_consent(self):
        fixtures = (
            {'cron_text': '0 6,18 * * * /usr/local/bin/sync-time-with-internet.sh\n',
             'unit_text': 'free-sleep.service enabled\n', 'ambient_unit': False},
            {'cron_text': '0 6,18 * * * /home/dac/free-sleep/scripts/unblock_internet_access.sh; sleep 20; /home/dac/free-sleep/scripts/block_internet_access.sh\n',
             'unit_text': 'free-sleep.service enabled\n', 'ambient_unit': False},
            {'cron_text': '', 'unit_text': 'free-sleep-ambient-light.service enabled\n'},
        )
        for fixture in fixtures:
            for driver in (None, 'laptop', 'installer'):
                with self.subTest(fixture=fixture, driver=driver):
                    result, cron, ambient, log = self.run_artifacts('clean', driver=driver, **fixture)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('consent', result.stderr)
                    self.assertEqual(cron, fixture['cron_text'])
                    self.assertEqual(ambient, fixture.get('ambient_unit', True))
                    self.assertNotIn('systemctl stop', log)
                    self.assertNotIn('checkpoint ', log)

    def test_unknown_writers_stop_without_removal_consent(self):
        result, cron, ambient, log = self.run_artifacts('clean', driver='installer',
            cron_text='', unit_text='free-sleep-extra-writer.service enabled\nfree-sleep-extra-writer.timer enabled\n', ambient_unit=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cron, '')
        self.assertFalse(ambient)
        self.assertLess(log.index('systemctl stop free-sleep-extra-writer.timer'), log.index('checkpoint '))
        self.assertLess(log.index('systemctl stop free-sleep-extra-writer.service'), log.index('checkpoint '))
        self.assertNotIn('systemctl enable', log)
        self.assertNotIn('systemctl start free-sleep-extra', log)

    def test_failed_foreign_writer_stop_prevents_checkpoint(self):
        for options in ({'stop_error': True}, {'still_active': True}):
            with self.subTest(options=options):
                result, cron, ambient, log = self.run_artifacts('clean', 'yes', driver='installer', **options)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('checkpoint ', log)
                self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
                self.assertTrue(ambient)

    def test_install_and_update_warn_without_cleanup(self):
        for driver in ('install', 'update'):
            result, cron, ambient, log = self.run_artifacts('warn-cron', driver=driver)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('WARNING', result.stdout)
            self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
            self.assertTrue(ambient)
            self.assertNotIn('systemctl', log)

    def test_update_warns_using_its_own_helper_when_live_tree_is_older(self):
        result, cron, ambient, log = self.run_artifacts('warn-cron', driver='update', missing_helper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fork-switch tool', result.stdout)
        self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
        self.assertTrue(ambient)
        self.assertNotIn('systemctl', log)

    def test_install_and_update_warn_with_an_older_tree(self):
        for driver in ('install', 'update'):
            result, cron, ambient, log = self.run_artifacts('warn-cron', driver=driver, missing_helper=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('WARNING', result.stdout)
            self.assertIn('firewall', result.stdout)
            self.assertEqual(cron, (ROOT / 'fixtures/migrate/root.crontab').read_text())
            self.assertTrue(ambient)
            self.assertNotIn('systemctl', log)

if __name__ == '__main__':
    unittest.main()
