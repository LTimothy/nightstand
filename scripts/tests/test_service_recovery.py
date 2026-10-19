"""Exercise recovery shell fragments only, with all services and mutations stubbed."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def read(name):
    return (ROOT / 'scripts' / name).read_text()


def section(text, start, end):
    return text[text.index(start):text.index(end)]


class RecoveryTests(unittest.TestCase):
    def run_shell(self, body, setup=''):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['bash', '-c', '''
set -euo pipefail
systemctl() { echo "$*" >> "$FIXTURE/services"; }
fail() { echo "$*" >&2; exit 1; }
say() { :; }
record_result() { :; }
''' + setup + '\n' + body], env={**os.environ, 'FIXTURE': directory},
                text=True, capture_output=True)
            log = Path(directory, 'services')
            return result, log.read_text() if log.exists() else ''

    def test_every_revert_restore_failure_restarts_server(self):
        script = read('switch-to-upstream.sh')
        helper = ''
        if 'restore_switch_data_or_fail()' in script:
            helper = section(script, 'restore_switch_data_or_fail()', '\nWAN_OPEN=')
        calls = re.findall(r'^\s*(?:restore_switch_data \|\| fail|restore_switch_data_or_fail) "[^"\n]+"$', script, re.M)
        self.assertEqual(len(calls), 6)
        for call in calls:
            with self.subTest(call=call.strip()):
                result, log = self.run_shell(helper + '\n' + call, '''
restore_switch_data() { return 1; }
STREAM_WAS_ACTIVE=active
ARCHIVE_WAS_ACTIVE=active
BK=fixture-backup
''')
                self.assertEqual(result.returncode, 1)
                self.assertIn('start free-sleep\n', log)
                self.assertIn('restart free-sleep-stream\n', log)
                self.assertIn('start free-sleep-archive-raw.timer\n', log)

    def test_failed_restore_is_not_repeated_by_cleanup(self):
        script = read('switch-to-upstream.sh')
        functions = section(script, 'DATA_CHANGED=no', '# Keep the descriptor')
        functions = functions.replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh',
                                      str(ROOT / 'scripts/restore_helpers.sh'))
        result, log = self.run_shell(functions + '\n' + """
DATA_CHANGED=yes
ARCHIVE_WAS_ACTIVE=active
STREAM_WAS_ACTIVE=active
BK=fixture-backup
STAGE=stage
ZIP=zip
mktemp() { echo "$FIXTURE/copy"; }
cp() { echo restore-attempt >> "$FIXTURE/services"; return 1; }
rm() { :; }
trap cleanup EXIT
restore_switch_data_or_fail "restore failed"
""", '''
iptables() { return 0; }
ip6tables() { return 0; }
systemctl() { [ "$1" != is-active ] || { echo inactive; return 3; }; echo "$*" >> "$FIXTURE/services"; }
''')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(log.count('restore-attempt'), 1)
        self.assertIn('start free-sleep-archive-raw.timer', log)

    def test_install_backup_refusals_restart_stopped_services(self):
        script = read('install.sh')
        block = section(script, '# Stop both database writers', '# The previous install is kept')
        for failure in ('checkpoint', 'backup', 'sqlite_module'):
            with self.subTest(failure=failure):
                setup = '''
SRC_DIR="$FIXTURE/stage"
COPY="$FIXTURE/copy"
mkdir -p "$FIXTURE/data"
touch "$FIXTURE/data/free-sleep.db"
python3() {
  if [ "$FAILURE" = sqlite_module ] || [ "$2" = "$FAILURE" ]; then return 1; fi
}
'''
                body = block.replace('/persistent/free-sleep-data', '$FIXTURE/data').replace('/persistent/free-sleep-database-backups', '$FIXTURE/backups')
                result, log = self.run_shell(body, setup + '\nFAILURE=' + failure)
                self.assertEqual(result.returncode, 1)
                self.assertIn('start free-sleep\n', log)
                self.assertIn('start free-sleep-stream\n', log)

    def test_install_failure_preserves_disabled_streamer_and_missing_units(self):
        block = section(read('install.sh'), '# Stop both database writers', 'SRC="/persistent')
        for existing in (True, False):
            with self.subTest(existing=existing):
                result, log = self.run_shell(block + '\nfalse', """
systemctl() {
  case "$1" in
    is-active) return 1;;
    cat) return "$MISSING_UNITS";;
    *) echo "$*" >> "$FIXTURE/services";;
  esac
}
MISSING_UNITS=""" + ('0' if existing else '1'))
                self.assertEqual(result.returncode, 1)
                self.assertNotIn('start free-sleep-stream', log)
                if existing:
                    self.assertIn('start free-sleep\n', log)
                else:
                    self.assertEqual(log, '')

    RESET_STUBS = '''
mkdir -p "$FIXTURE/data"
echo damaged > "$FIXTURE/data/free-sleep.db"
python3() {
  if [ "$2" = -c ]; then [ "$BIOMETRICS" = on ]; return "$?"; fi
  [ "$FAILURE" != sqlite_module ] && [ "$2" != "$FAILURE" ]
}
su() { echo su >> "$FIXTURE/services"; [ "$FAILURE" != migration ]; }
cp() { [ "$FAILURE" != copy ] && command cp "$@"; }
'''

    def reset_script(self):
        script = read('reset_db.sh').replace('/persistent/free-sleep-database-backups', '$FIXTURE/backups').replace('/persistent/free-sleep-data', '$FIXTURE/data')
        return script.replace('read -p "Are you sure you want to continue? (y/N): " confirm', 'confirm=y')

    def test_reset_refusals_restart_stopped_services(self):
        # "copy": the checked copy failed and so did copying the file aside.
        for failure in ('migration', 'copy'):
            for biometrics in ('on', 'off'):
                with self.subTest(failure=failure, biometrics=biometrics):
                    setup = self.RESET_STUBS + '\nFAILURE=' + failure + '\nBIOMETRICS=' + biometrics
                    if failure == 'copy':
                        setup += '\npython3() { [ "$2" = -c ] && [ "$BIOMETRICS" = on ]; }'
                    result, log = self.run_shell(self.reset_script(), setup)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('start free-sleep\n', log)
                    # The stream follows the app's Biometrics switch.
                    self.assertEqual('start free-sleep-stream\n' in log, biometrics == 'on')
                    if failure == 'copy':
                        self.assertIn('nothing was deleted', result.stdout)
                        self.assertNotIn('su\n', log)

    def test_reset_keeps_a_damaged_database_aside_and_continues(self):
        for failure in ('checkpoint', 'backup', 'sqlite_module'):
            with self.subTest(failure=failure):
                result, log = self.run_shell(self.reset_script() + '''
test ! -e "$FIXTURE/data/free-sleep.db"
cat "$FIXTURE"/backups/*-reset-raw.db
''', self.RESET_STUBS + '\nFAILURE=' + failure + '\nBIOMETRICS=off')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('copying the file as it is instead', result.stdout)
                self.assertTrue(result.stdout.endswith('damaged\n'), result.stdout)
                self.assertIn('start free-sleep\n', log)

    def test_sentry_install_is_pinned_and_runs_only_as_dac(self):
        script = read('switch-to-upstream.sh')
        block = section(script, '# Upstream imports', '\nclose_wan\n')
        for owner, writable, ok in (('dac', True, True), ('dac', False, False), ('root', True, False)):
            with self.subTest(owner=owner, writable=writable):
                setup = """
mkdir -p "$FIXTURE/venv/bin"
cat > "$FIXTURE/venv/bin/python" <<'STUB'
#!/bin/bash
if [ "$2" = -c ]; then exit "$WRITABLE_STATUS"; fi
printf '%s%s %s\\n' "${HOME_SET:+H:}" "${RUN_AS:-root}" "$*"
STUB
chmod +x "$FIXTURE/venv/bin/python"
stat() { [ "$1" = -L ] && echo "$OWNER"; }
chown() { echo "chown $*"; }
sudo() ( [ "$1" != -H ] || { export HOME_SET=1; shift; }; export RUN_AS="$2"; shift 2; "$@"; )
run_limited() { shift; "$@"; }
export OWNER=""" + owner + ' WRITABLE_STATUS=' + ('0' if writable else '1')
                result, _ = self.run_shell(block.replace('/home/dac/venv', '$FIXTURE/venv'), setup)
                self.assertEqual(result.returncode == 0, ok, result.stderr)
                self.assertIn('chown -hR dac:dac ', result.stdout)
                self.assertNotIn('root -I -m pip', result.stdout)
                self.assertEqual('H:dac -I -m pip install sentry-sdk==2.71.0' in result.stdout, ok, result.stdout)

    def test_finished_migration_is_read_after_failed_liveness_probe(self):
        script = read('migrate/switch-to-this-fork.sh')
        block = section(script, '  if [ -z "$STATUS_JSON" ]', '  [ -n "$STATUS_JSON" ] || continue')
        for outcome in ('success', 'restored', 'failed', 'refused', 'restore_failed', 'in_progress', ''):
            with self.subTest(outcome=outcome):
                result, _ = self.run_shell(block + '\nprintf "%s" "$STATUS_JSON"', '''
STATUS_JSON='{"outcome":"in_progress"}'
STATUS_FILE_REMOTE=status.json
SSH_PORT=1
ssh_cmd() {
  case "$2" in
    *is-active*) return 1;;
    *) printf '{"outcome":"%s"}' "$FINAL_OUTCOME";;
  esac
}
''' + '\nFINAL_OUTCOME=' + outcome)
                terminal = outcome in ('success', 'restored', 'failed', 'refused', 'restore_failed')
                self.assertEqual(result.returncode, 0 if terminal else 1, result.stderr)
                if terminal:
                    self.assertIn('"' + outcome + '"', result.stdout)


class TransactionDispatchTests(unittest.TestCase):
    def test_confirmed_v2_dispatches_before_shared_venv_or_legacy_mutations(self):
        script = read('switch-to-upstream.sh')
        self.assertIn('TRANSACTIONAL_SWITCH=yes', script)
        start = script.index('# Confirmed V2 targets use the durable transaction')
        end = script.index('# Upstream imports', start)
        block = script[start:end]
        self.assertIn('switch_installation.py', block)
        self.assertIn('recheck_in_use', block)
        self.assertIn('forward', block)
        self.assertIn('"$CONFIRMED_TARGET"', block)
        self.assertIn('"$SWITCH_ACTUAL"', block)
        self.assertNotIn('pip install', block)

    def test_return_and_restore_share_the_operation_lock_and_durable_recovery(self):
        installer = read('migrate/pod-installer.sh')
        restore = read('migrate/restore-original-fork.sh')
        self.assertIn('NIGHTSTAND_OPERATION_LOCK', installer)
        self.assertIn('switch_installation.py" return', installer)
        self.assertLess(installer.index('switch_installation.py" return'), installer.index('Dead-man sentinel, armed'))
        self.assertIn('recover_switch.sh', restore)
        self.assertIn('NIGHTSTAND_OPERATION_OWNER', restore)

    def test_cross_fork_rollback_dispatches_before_ordinary_swap(self):
        script = read('rollback_pod.sh')
        start = script.index('# Cross-fork rollback requires companion state')
        end = script.index('# Other forks cannot run', start)
        block = script[start:end]
        self.assertIn('restore_cross_fork_rollback', block)
        self.assertIn('recheck_in_use', block)
        self.assertLess(start, script.index('RESULT_PHASE=swapping', start))


if __name__ == '__main__':
    unittest.main()
