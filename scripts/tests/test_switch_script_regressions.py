"""Run switch and migration boundaries with local files and command doubles."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


def read(name):
    return (SCRIPTS / name).read_text()


class MigrationLauncherTests(unittest.TestCase):
    def launch(self, failures):
        source = read('migrate/switch-to-this-fork.sh')
        start = source.index('ssh_cmd "$SSH_PORT" "\n  rm -f /persistent/free-sleep-data/migration-status.json')
        end = source.index('\nsay "Installer started.', start)
        wrapper = r'''
SSH_PORT=fixture
REMOVE_FOREIGN=yes
fail() { echo "$*" >&2; exit 1; }
ssh_cmd() { bash -c "$2"; }
rm() { :; }
systemd-run() {
  printf '%s\n' 'CALL' "$@"
  count=$((count + 1))
  [ "$count" -gt "$FAILURES" ]
}
count=0
export -f rm systemd-run
export count
'''
        return subprocess.run(['bash', '-c', wrapper + source[start:end]],
                              env=dict(os.environ, FAILURES=str(failures)),
                              capture_output=True, text=True, timeout=5)

    def test_old_systemd_retries_the_legacy_command_once(self):
        result = self.launch(1)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [call.strip().splitlines() for call in result.stdout.split('CALL\n')[1:]]
        self.assertEqual(len(calls), 2, result.stdout)
        self.assertIn('--property=ExecStopPost=-/bin/systemctl restart --no-block free-sleep-recover-switch.service', calls[0])
        # A simple service has no start timeout; this bounds the whole installer.
        self.assertIn('--property=RuntimeMaxSec=2h', calls[0])
        self.assertEqual(calls[1], ['--unit=free-sleep-migrate', '--collect', 'bash',
                                   '/usr/local/lib/nightstand/migrate/pod-installer.sh', 'yes'])

    def test_supported_systemd_launches_once_and_failure_of_both_attempts_is_reported(self):
        result = self.launch(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('CALL\n'), 1)
        result = self.launch(2)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count('CALL\n'), 2)
        self.assertIn('could not start the installer', result.stderr)


class InstallerPreflightTests(unittest.TestCase):
    def test_artifact_refusal_is_logged_and_writes_preflight_status(self):
        source = read('migrate/pod-installer.sh')
        source = source[:source.index('# Share admission')]
        for helper_present in (False, True):
            with self.subTest(helper_present=helper_present), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                migrate = root / 'scripts/migrate'
                migrate.mkdir(parents=True)
                if helper_present:
                    (migrate / 'fork-artifacts.sh').write_text('echo "Refusing switch: consent is required"\nexit 1\n')
                script = migrate / 'pod-installer.sh'
                source_local = source.replace('/persistent/', str(root / 'persistent') + '/')
                # The sandbox denies process substitution through /dev/fd.
                source_local = source_local.replace('exec > >(tee -a "$LOG_FILE") 2>&1', 'exec >> "$LOG_FILE" 2>&1')
                script.write_text(source_local)
                result = subprocess.run(['bash', str(script)], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                status = json.loads((root / 'persistent/free-sleep-data/migration-status.json').read_text())
                self.assertEqual((status['stage'], status['outcome']), ('preflight', 'refused'))
                logs = list((root / 'persistent/nightstand-logs').glob('migration-*.log'))
                self.assertEqual(len(logs), 1)
                self.assertIn('Refusing switch:', logs[0].read_text())


class MigrationStateTests(unittest.TestCase):
    def test_status_is_replaced_not_written_through_a_link(self):
        source = read('migrate/pod-installer.sh')
        source = source[:source.index('# Share admission')]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            migrate = root / 'scripts/migrate'
            migrate.mkdir(parents=True)
            data = root / 'persistent/free-sleep-data'
            data.mkdir(parents=True)
            victim = root / 'victim'
            victim.write_text('keep')
            (data / 'migration-status.json').symlink_to(victim)
            script = migrate / 'pod-installer.sh'
            script.write_text(source.replace('/persistent/', str(root / 'persistent') + '/')
                              .replace('/home/dac/', str(root) + '/')
                              .replace('exec > >(tee -a "$LOG_FILE") 2>&1', 'exec >> "$LOG_FILE" 2>&1'))
            result = subprocess.run(['bash', str(script)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertEqual(victim.read_text(), 'keep')
            self.assertEqual(json.loads((data / 'migration-status.json').read_text())['outcome'], 'refused')

    def test_status_writers_leave_no_temporary_file_when_the_rename_fails(self):
        for script in ('pod-installer.sh', 'agent-bootstrap-installer.sh', 'restore-original-fork.sh'):
            source = read('migrate/' + script)
            start = source.index('write_status() {')
            function = source[start:source.index('\n}\n', start) + 3]
            with self.subTest(script=script), tempfile.TemporaryDirectory() as folder:
                data = Path(folder) / 'persistent/free-sleep-data'
                (data / 'migration-status.json').mkdir(parents=True)
                shell = function.replace('/persistent/', folder + '/persistent/') \
                    + 'STATUS_FILE="$FIXTURE/persistent/free-sleep-data/migration-status.json"\nwrite_status a b c\n'
                result = subprocess.run(['bash', '-c', shell], capture_output=True, text=True, timeout=5,
                                        env=dict(os.environ, FIXTURE=folder))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(path.name for path in data.iterdir()), ['migration-status.json'])

    def test_preflight_refuses_a_migration_an_older_tool_left_unfinished(self):
        names = ('free-sleep-migrate.lock', 'free-sleep-migrate-restore-state', 'free-sleep-migrate-swapped',
                 'free-sleep-agent-bootstrap.lock', None)
        for script in ('pod-installer.sh', 'agent-bootstrap-installer.sh'):
            source = read('migrate/' + script)
            start = source.index('# An older migration tool')
            block = source[start:source.index(': > "$LOCK_FILE"', start)]
            for name in names + ('sentinel',):
                with self.subTest(script=script, name=name), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder)
                    if name not in (None, 'sentinel'):
                        (root / name).symlink_to(root / 'missing')
                    shell = 'say() { echo "$*"; }\nwrite_status() { echo "status $*"; }\n' \
                        'systemctl() { [ "$1 $3" = "is-active free-sleep-migrate-sentinel.timer" ] && [ "$SENTINEL" = yes ]; }\n' \
                        'LOCK_FILE="$FIXTURE/new.lock"; SENTINEL_TIMER=free-sleep-migrate-sentinel.timer\n' \
                        + block.replace('/home/dac/', folder + '/') + 'echo passed\n'
                    result = subprocess.run(['bash', '-c', shell], capture_output=True, text=True, timeout=5,
                                            env=dict(os.environ, FIXTURE=folder, SENTINEL='yes' if name == 'sentinel' else 'no'))
                    if name is None:
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertIn('passed', result.stdout)
                    else:
                        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                        self.assertIn('/usr/local/lib/nightstand/restore-original-fork.sh', result.stdout)
                        self.assertIn('/home/dac', result.stdout)
                        self.assertIn('status preflight refused', result.stdout)

    def test_root_keeps_migration_state_out_of_the_server_users_home(self):
        names = ('SWAP_MARKER', 'RESTORE_STATE', 'LOCK_FILE', 'PID_FILE', 'IPTABLES_SNAPSHOT', 'BASELINE_FILE')
        for name in ('pod-installer.sh', 'restore-original-fork.sh', 'agent-bootstrap-installer.sh', 'switch-to-this-fork.sh'):
            source = read('migrate/' + name)
            if '# An older migration tool' in source:
                # Only reads, to refuse while an older tool's migration is unfinished.
                start = source.index('# An older migration tool')
                source = source[:start] + source[source.index('\ndone\n', start):]
            for line in source.splitlines():
                if line.split('=')[0] in names:
                    self.assertTrue(line.split('=', 1)[1].startswith('$MIGRATE_STATE/'), f'{name}: {line}')
            self.assertNotRegex(source, r'/home/dac/free-sleep-(migrate-(swapped|restore-state|baseline|iptables)|migrate\.(lock|pid)|agent-bootstrap\.lock)')
            self.assertNotRegex(source, r'free-sleep-data/logs/(migration|agent-bootstrap)-')


class InstallerCompletionTests(unittest.TestCase):
    def test_interruption_at_swap_marker_removal_keeps_artifact_recovery_armed(self):
        source = read('migrate/pod-installer.sh')
        start = source.index('say "Health check passed on')
        block = source[start:source.index('write_status "install" "success"', start)]
        for remove_first in (False, True):
            with self.subTest(remove_first=remove_first), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                migrate = root / 'migrate'
                migrate.mkdir()
                systemd = root / 'systemd'
                systemd.mkdir()
                replacements = {'/home/dac/': str(root) + '/', '/persistent/': str(root / 'persistent') + '/',
                                '/usr/local/lib/nightstand/': str(root) + '/',
                                '/etc/systemd/system': str(systemd), '/usr/local/bin/': str(root / 'local-bin') + '/',
                                '/tmp/free-sleep-migrate-health': str(root / 'health')}
                def localize(text):
                    for original, replacement in replacements.items():
                        text = text.replace(original, replacement)
                    return text
                for name in ('fork-artifacts.sh', 'restore-original-fork.sh'):
                    (migrate / name).write_text(localize(read('migrate/' + name)))
                (migrate / 'restore_helpers.sh').write_text(read('restore_helpers.sh'))
                restore = root / 'restore-original-fork.sh'
                restore.write_text(localize(read('migrate/restore-original-fork.sh')))
                live = root / 'free-sleep'
                previous = root / 'free-sleep-prev'
                for tree, identity in ((live, 'nightstand'), (previous, 'original')):
                    (tree / 'scripts').mkdir(parents=True)
                    (tree / 'identity').write_text(identity)
                marker = root / 'persistent/nightstand-migrate/free-sleep-migrate-swapped'
                marker.parent.mkdir(parents=True)
                marker.touch()
                artifacts = root / 'free-sleep-migrate-artifacts'
                backup = artifacts / 'backup.fixture'
                backup.mkdir(parents=True)
                original_cron = '0 * * * * /usr/local/bin/sync-time-with-internet.sh\n'
                (backup / 'root.crontab').write_text(original_cron)
                pending = artifacts / 'pending'
                pending.write_text(str(backup))
                cron = root / 'cron'
                cron.write_text('filtered cron\n')
                shell = r"""
LIVE="$FIXTURE/free-sleep"; PREV="$FIXTURE/free-sleep-prev"; STAGED_VERSION=3.7.0
ARTIFACT_HELPER="$FIXTURE/migrate/fork-artifacts.sh"
IPTABLES_SNAPSHOT="$FIXTURE/snapshot"; BASELINE_FILE="$FIXTURE/baseline"
RESTORE_SCRIPT_DEST="$FIXTURE/restore-original-fork.sh"
PREEXISTING_PREV="$FIXTURE/older"; SWAP_MARKER="$FIXTURE/persistent/nightstand-migrate/free-sleep-migrate-swapped"
say() { :; }
sh() { :; }
restore_and_report() { echo "unexpected restore: $*" >&2; exit 98; }
disarm_sentinel() { :; }
rm() {
  for target in "$@"; do
    if [ "$target" = "$SWAP_MARKER" ]; then
      [ "$REMOVE_FIRST" != yes ] || command rm "$@"
      exit 97
    fi
  done
  command rm "$@"
}
""" + localize(block)
                environment = dict(os.environ, FIXTURE=str(root), REMOVE_FIRST='yes' if remove_first else 'no',
                                   NIGHTSTAND_TRANSACTION_ROOT=str(root / 'transactions'))
                result = subprocess.run(['bash', '-c', shell], env=environment, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 97, result.stdout + result.stderr)
                self.assertTrue(pending.exists(), 'Artifact recovery must survive until the swap marker is retired')
                wrapper = r"""
systemctl() { case "$1" in is-enabled) echo enabled ;; is-active) echo inactive; return 3 ;; esac; }
crontab() { cat "$3" > "$TEST_CRON"; }
sleep() { :; }
curl() { :; }
sync() { :; }
export -f systemctl crontab sleep curl sync
bash "$FIXTURE/restore-original-fork.sh"
"""
                result = subprocess.run(['bash', '-c', wrapper],
                                        env=dict(environment, TEST_CRON=str(cron)), capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(cron.read_text(), original_cron)
                self.assertFalse(pending.exists())
                self.assertEqual((live / 'identity').read_text(), 'nightstand' if remove_first else 'original')


class LegacySwitchCleanupTests(unittest.TestCase):
    def test_success_removes_switch_recovery_only_without_a_published_journal(self):
        source = read('switch-to-upstream.sh')
        start = source.index('if [ "$HEALTHY" = yes ]; then', source.index('rm -f "$HBODY"'))
        block = source[start:source.index('# --- automatic rollback', start)]
        for published in (False, True):
            with self.subTest(published=published), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                systemd = root / 'etc/systemd/system'
                units = ['free-sleep', 'free-sleep-stream', 'free-sleep-archive-raw', 'free-sleep-health',
                         'free-sleep-network-watchdog', 'free-sleep-recover-update', 'free-sleep-update',
                         'free-sleep-rollback', 'free-sleep-revert', 'free-sleep-migrate']
                gates = []
                for unit in units:
                    gate = systemd / (unit + '.service.d/nightstand-switch-recovery.conf')
                    gate.parent.mkdir(parents=True, exist_ok=True)
                    gate.write_text('switch recovery gate\n')
                    gates.append(gate)
                    (gate.parent / 'custom.conf').write_text('custom setting\n')
                recovery_unit = systemd / 'free-sleep-recover-switch.service'
                recovery_unit.write_text('recovery unit\n')
                recovery = root / 'usr/local/lib/nightstand/switch-recovery'
                recovery.mkdir(parents=True)
                (recovery / 'recover_switch.sh').write_text('retained recovery\n')
                transactions = root / 'transactions'
                if published:
                    (transactions / 'switch').mkdir(parents=True)
                    (transactions / 'switch/journal.json').symlink_to(transactions / 'missing')
                localized = block.replace('/etc/systemd/system', str(systemd)).replace('/home/dac/', str(root / 'home/dac') + '/')
                localized = localized.replace('/usr/local/lib/nightstand/', str(root / 'usr/local/lib/nightstand') + '/')
                localized = localized.replace('/persistent/', str(root / 'persistent') + '/')
                shell = 'set -uo pipefail\nsource ' + shlex.quote(str(SCRIPTS / 'restore_helpers.sh')) + '\n' + r'''
HEALTHY=yes; STAGED_VERSION=2.0.0; PREV=/missing-fixture; BK=fixture
say() { :; }
systemctl() { echo "$*" >> "$CALLS"; }
sync() { :; }
''' + localized
                result = subprocess.run(['bash', '-c', shell], capture_output=True, text=True, timeout=5,
                                        env=dict(os.environ, CALLS=str(root / "calls"), NIGHTSTAND_TRANSACTION_ROOT=str(transactions)))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(recovery_unit.exists(), published)
                self.assertEqual(recovery.exists(), published)
                for gate in gates:
                    self.assertEqual(gate.exists(), published, str(gate))
                    self.assertTrue((gate.parent / 'custom.conf').exists())
                if not published:
                    self.assertIn('disable --now free-sleep-recover-switch.service', (root / 'calls').read_text())


class JournalDetectionTests(unittest.TestCase):
    def test_shared_helper_counts_a_dangling_journal_but_not_unpublished_directories(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            command = 'source ' + shlex.quote(str(SCRIPTS / 'restore_helpers.sh')) + '\nhas_switch_journal "$1"'
            for state in ('absent', 'empty', 'unpublished', 'dangling', 'file'):
                with self.subTest(state=state):
                    if state == 'empty':
                        root.mkdir(exist_ok=True)
                    if state == 'unpublished':
                        (root / 'switch').mkdir()
                        (root / 'switch/unpublished.json').write_text('{}')
                    if state == 'dangling':
                        (root / 'switch/journal.json').symlink_to(root / 'missing')
                    if state == 'file':
                        (root / 'switch/journal.json').unlink()
                        (root / 'switch/journal.json').write_text('corrupt')
                    target = root / 'absent' if state == 'absent' else root
                    result = subprocess.run(['bash', '-c', command, 'fixture', str(target)], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0 if state in ('dangling', 'file') else 1, result.stderr)

    def test_rollback_consults_companion_records_for_a_dangling_journal(self):
        source = read('rollback_pod.sh')
        block = source[source.index('# Cross-fork rollback'):source.index('# Other forks')]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'live/scripts').mkdir(parents=True)
            (root / 'live/scripts/switch_installation.py').touch()
            (root / 'transactions/switch').mkdir(parents=True)
            (root / 'transactions/switch/journal.json').symlink_to(root / 'missing')
            shell = 'source ' + shlex.quote(str(SCRIPTS / 'restore_helpers.sh')) + '\n' + r'''
LIVE="$FIXTURE/live"; PREV="$FIXTURE/prev"
fail() { echo "$*" >&2; exit 1; }
python3() { echo companion-consulted >&2; return 23; }
''' + block
            result = subprocess.run(['bash', '-c', shell], capture_output=True, text=True, timeout=5,
                                    env=dict(os.environ, FIXTURE=str(root), NIGHTSTAND_TRANSACTION_ROOT=str(root / 'transactions')))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('companion-consulted', result.stderr)
            self.assertIn('cannot read the retained tree', result.stderr)


if __name__ == '__main__':
    unittest.main()
