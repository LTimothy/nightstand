"""Run isolated updater fragments with temporary files and fake system commands."""
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def source(name):
    return (ROOT / 'scripts' / name).read_text()


class PortabilityTests(unittest.TestCase):
    def test_python_lock_and_missing_run_lock_directory(self):
        scripts = ['update.sh', 'rollback_pod.sh', 'switch-to-upstream.sh', 'install.sh', 'reset.sh']
        for name, native, missing in itertools.product(scripts, [False, True], [False, True]):
            if native and not shutil.which('flock'):
                continue
            with self.subTest(script=name, native=native, missing=missing), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                bindir = root / 'bin'
                bindir.mkdir()
                (bindir / 'python3').symlink_to(sys.executable)
                if native:
                    (bindir / 'flock').symlink_to(shutil.which('flock'))
                if not missing:
                    (root / 'missing').mkdir()
                text = source(name)
                if name in ('install.sh', 'reset.sh'):
                    body = text.split('# Share admission', 1)[1].split('\n\n', 1)[0]
                    body = '# Share admission' + body + '\n'
                else:
                    helpers = source('restore_helpers.sh')
                    lock = helpers[helpers.index('take_operation_lock() {'):]
                    lock = lock[:lock.index('\n}\n') + 3]
                    body = lock + text.split('# Keep the descriptor across updater exec handoffs; all three operations share it.')[1].split('\nesac', 1)[0] + '\nesac\n'
                body = body.replace('/run/lock', str(root / 'missing')).replace('/tmp/free-sleep-operation.lock', str(root / 'fallback.lock'))
                env = {k: v for k, v in os.environ.items() if not k.startswith('NIGHTSTAND_OPERATION_')}
                env['PATH'] = str(bindir)
                command = 'fail() { echo "$*" >&2; exit 1; };\n' + body
                holder = subprocess.Popen(['/bin/bash', '-c', command + 'echo ready; read -r done'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(holder.stdout.readline().strip(), 'ready', holder.stderr.read() if holder.poll() is not None else '')
                    denied = subprocess.run(['/bin/bash', '-c', command], env=env, text=True, capture_output=True)
                    self.assertNotEqual(denied.returncode, 0)
                    self.assertIn('already running', denied.stdout + denied.stderr)
                finally:
                    holder.communicate('\n', timeout=5)
                self.assertEqual(subprocess.run(['/bin/bash', '-c', command], env=env, capture_output=True).returncode, 0)

    def test_all_pre_floor_tags_cap_retention(self):
        manifest = json.loads((ROOT / 'fixtures/compat/archive-pre-floor-tags.json').read_text())
        for tag, digest in manifest.items():
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as tmp:
                fixture = ROOT / 'fixtures/compat/archive-raw-v3.2.2.sh'
                self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(), digest)
                target = Path(tmp) / 'archive.sh'
                shutil.copyfile(fixture, target)
                config = Path(tmp) / 'config'
                config.write_text('RETENTION_HOURS=1440\n')
                subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-downgrade.py'), str(target), str(config)], check=True, capture_output=True)
                self.assertIn('RETENTION_HOURS=336\n', target.read_text())

    def test_rollback_recognizes_original_nightstand(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scripts').mkdir()
            (root / 'server/src').mkdir(parents=True)
            shutil.copyfile(ROOT / 'fixtures/compat/serverInfo-v3.0.0.json', root / 'server/src/serverInfo.json')
            (root / 'scripts/archive-raw.sh').touch()
            text = source('rollback_pod.sh')
            body = text[text.index('# Other forks'):text.index('# --- swap')]
            success = text[text.index('if [ "$HEALTHY" = yes ]; then'):text.index('# --- swap back')]
            body += '\nHEALTHY=yes; TARGET_VERSION=3.0.0; CUR_VERSION=3.4.0; say() { :; }; rm() { echo delete; };\n' + success
            result = subprocess.run(['/bin/bash', '-c', 'set -eu\nPREV="$1"; LIVE="$1"; NIGHTSTAND_SCRIPTS="$1/scripts"; systemctl() { echo "$*"; }; python3() { :; }; follow_scripts() { :; }; fail() { exit 1; };\n' + body, 'fixture', tmp], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('stop free-sleep-archive', result.stdout)
            self.assertNotIn('delete', result.stdout)
            self.assertNotIn('disable', result.stdout)
            self.assertNotIn('TARGET_FORK', text)

    def test_firewall_requires_terminal_rules_for_both_families(self):
        text = source('update.sh')
        start = text.index('if [ "$HEALTHY" = yes ]; then', text.index('# A pod serving HTTP'))
        body = text[start:text.index('# --- automatic rollback', start)]
        for missing in ['4', '6', '4 6']:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / 'scripts').mkdir()
                (Path(tmp) / 'scripts/block_internet_access.sh').write_text('--dport 1337 --reject-with tcp-reset\n')
                setup = r'''
HEALTHY=yes; LIVE="$1"; STAGED_VERSION=test; PREV=previous; BK=backup
say() { echo "$*"; }
sh() { echo apply >> "$LIVE/calls"; }
fw4() { echo "4 $*" >> "$LIVE/checks"; [[ " $MISSING " != *" 4 "* ]]; }
fw6() { echo "6 $*" >> "$LIVE/checks"; [[ " $MISSING " != *" 6 "* ]]; }
'''
                result = subprocess.run(['/bin/bash', '-c', setup + body + '\necho rollback', 'fixture', tmp],
                                        text=True, capture_output=True, env={**os.environ, 'MISSING': missing})
                self.assertIn('rollback\n', result.stdout)
                self.assertNotIn('SUCCESS:', result.stdout)
                self.assertEqual((Path(tmp) / 'calls').read_text().splitlines(), ['apply', 'apply'])

    def test_firewall_checks_and_retries_end_state(self):
        text = source('update.sh')
        start = text.index('if [ "$HEALTHY" = yes ]; then', text.index('# A pod serving HTTP'))
        body = text[start:text.index('# --- automatic rollback', start)]
        for succeeds_at, expected, old, script_status, reset_missing in [(1, 1, False, 0, False), (2, 2, False, 0, False), (99, 2, False, 0, False), (1, 1, False, 1, False), (1, 1, True, 0, False), (1, 2, False, 0, True)]:
            with self.subTest(succeeds_at=succeeds_at), tempfile.TemporaryDirectory() as tmp:
                (Path(tmp) / 'scripts').mkdir()
                (Path(tmp) / 'scripts/block_internet_access.sh').write_text('iptables -A OUTPUT -j DROP\n' if old else 'iptables -A OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset\n')
                setup = '''
HEALTHY=yes; LIVE="$1"; STAGED_VERSION=test; PREV=previous; BK=backup; calls=0
say() { echo "$*"; }
sh() { calls=$((calls+1)); echo apply >> "$LIVE/calls"; return 0; }
iptables() { echo "$*" >> "$LIVE/checks"; if [ "$RESET_MISSING" = yes ] && [[ "$*" == *1337* ]]; then return 1; fi; if [ "$IS_DOWNGRADE" = yes ] && [[ "$*" == *"-C OUTPUT -j REJECT" ]]; then return 1; fi; [ "$calls" -ge "$2_SUCCESS" ]; }
fw4() { iptables -w 5 "$@"; }
fw6() { echo "ip6tables $*" >> "$LIVE/checks"; iptables -w 5 "$@"; }
'''.replace('"$2_SUCCESS"', str(succeeds_at)).replace('return 0;', 'return ' + str(script_status) + ';')
                setup += '\nRESET_MISSING=' + ('yes' if reset_missing else 'no') + '\n'
                setup += '\nIS_DOWNGRADE=' + ('yes' if old else 'no') + '\n'
                result = subprocess.run(['/bin/bash', '-c', setup + body + '\necho rollback', 'fixture', tmp], text=True, capture_output=True)
                self.assertEqual(len((Path(tmp) / 'calls').read_text().splitlines()), expected)
                self.assertEqual('rollback\n' in result.stdout, succeeds_at == 99)
                checks = (Path(tmp) / 'checks').read_text()
                if succeeds_at != 99:
                    self.assertIn('ip6tables -C OUTPUT -j', checks)
                if old:
                    self.assertIn('-w 5 -C OUTPUT -j DROP', checks)
                else:
                    self.assertIn('-w 5 -C OUTPUT -j REJECT', checks)
                if reset_missing:
                    self.assertIn('WARNING:', result.stdout)
                    self.assertIn('1337', result.stdout)
                    self.assertIn('SUCCESS:', result.stdout)
                if succeeds_at != 99 and not old:
                    self.assertIn('-w 5 -C OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset', checks)


if __name__ == '__main__':
    unittest.main()
