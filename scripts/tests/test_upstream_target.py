import json
import os
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upstream_target

FIXTURES = json.loads((Path(__file__).parent / 'fixtures/upstream_targets.json').read_text())


class TargetTests(unittest.TestCase):
    def test_legacy_selector_ignores_v2(self):
        script = (Path(__file__).resolve().parents[1] / 'switch-to-upstream.sh').read_text()
        selector = script.split("SWITCH_PIN=$(printf '%s' \"$SWITCH_MANIFEST\" | python3 -c '\n", 1)[1].split("' 2>/dev/null)", 1)[0]
        for case in FIXTURES:
            with self.subTest(case=case['name']):
                output = io.StringIO()
                with patch.object(sys, 'stdin', io.StringIO(json.dumps(case['manifest']))), patch.object(sys, 'stdout', output):
                    exec(compile(selector, 'legacy upstream selector', 'exec'), {})
                self.assertEqual(output.getvalue().split()[1], 'ca7dc543119ae964dd10815c8ae0c80ddb9a4f8f')

    def test_shared_selection_fixtures(self):
        for case in FIXTURES:
            with self.subTest(case=case['name']):
                if case['expected'] is None:
                    with self.assertRaises(ValueError):
                        upstream_target.select_target(case['manifest'], case['confirmed'])
                else:
                    self.assertEqual(upstream_target.select_target(case['manifest'], case['confirmed']), case['expected'])
                self.assertEqual(case['manifest']['upstreamSwitch']['commit'],
                                 'ca7dc543119ae964dd10815c8ae0c80ddb9a4f8f')

    def test_expired_or_unparseable_request_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'operation-request.json'
            for content in ('{broken', 'null', '[]', '"invalid"'):
                with self.subTest(content=content):
                    request.write_text(content)
                    self.assertIsNone(upstream_target.request_target(request))
            for target in (FIXTURES[1]['expected'], None, {'commit': 'main'}):
                with self.subTest(target=target):
                    request.write_text(json.dumps(dict(source='app', target=target)))
                    os.utime(request, (1000, 1000))
                    self.assertIsNone(upstream_target.request_target(request))

    def test_fresh_malformed_request_target_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'operation-request.json'
            for target in (None, {}, {'commit': 'main'}, dict(FIXTURES[1]['expected'], extra=True)):
                with self.subTest(target=target):
                    request.write_text(json.dumps(dict(source='app', target=target)))
                    with self.assertRaises(ValueError):
                        upstream_target.request_target(request)

    def test_download_identity_must_match_every_field(self):
        target = FIXTURES[1]['expected']
        upstream_target.verify_artifact(target, target['commit'], target['version'], target['treeSha256'])
        for values in [('a' * 40, target['version'], target['treeSha256']),
                       (target['commit'], '3.0.2', target['treeSha256']),
                       (target['commit'], target['version'], 'a' * 64)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                upstream_target.verify_artifact(target, *values)

    def test_command_line_rejects_explicit_invalid_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'manifest.json'
            confirmed = Path(directory) / 'confirmed.json'
            manifest.write_text(json.dumps(FIXTURES[1]['manifest']))
            command = [sys.executable, str(Path(upstream_target.__file__)), str(manifest)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), FIXTURES[1]['expected'])
            for value in [None, {}, 'main', {**FIXTURES[1]['expected'], 'version': '3.0.2'}]:
                confirmed.write_text(json.dumps(value))
                with self.subTest(value=value):
                    result = subprocess.run(command + ['--confirmed', str(confirmed)], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')

class SwitchScriptContractTests(unittest.TestCase):
    def run_preflight(self, manifest, request, expired=False, raw_request=None):
        scripts = Path(__file__).resolve().parents[1]
        source = (scripts / 'switch-to-upstream.sh').read_text()
        target_block = source[source.index('# Read the confirmed target'):source.index('# Bed-in-use helpers')]
        request_block = target_block + source[source.index('\nREQUEST_FILE=') + 1:source.index('# Tests can ask')]
        selection = source[source.index('SWITCH_MANIFEST=$('):source.index('say "Downloading upstream')]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request_path = root / 'operation-request.json'
            if request is not None:
                request_path.write_text(json.dumps(request))
            if raw_request is not None:
                request_path.write_text(raw_request)
            if expired:
                os.utime(request_path, (1000, 1000))
            manifest_path = root / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest))
            request_block = request_block.replace('/persistent/free-sleep-data/operation-request.json', str(request_path))
            shell = '''set -uo pipefail
SWITCH_RELEASES_URL=fixture
UPSTREAM_ZIP_URL=main
LIVE=/missing-switch-fixture
NIGHTSTAND_SCRIPTS=/missing-switch-fixture/scripts
say() { echo "$*"; }
fail() { echo "$*" >&2; exit 1; }
curl() { cat "$MANIFEST_FIXTURE"; }
''' + request_block + selection + '\nprintf "%s\\n" "$SWITCH_COMMIT" "$SWITCH_DIGEST" "$UPSTREAM_ZIP_URL"\n'
            environment = dict(__import__('os').environ, MANIFEST_FIXTURE=str(manifest_path),
                               UPSTREAM_TARGET_HELPER=str(scripts / 'upstream_target.py'))
            return subprocess.run(['bash', '-c', shell], capture_output=True, text=True, env=environment)

    def test_expired_or_unparseable_request_uses_the_untargeted_legacy_path(self):
        manifest = FIXTURES[1]['manifest']
        cases = ({'raw_request': '{broken'}, {'raw_request': 'null'},
                 {'request': dict(source='app', target={'commit': 'main'}), 'expired': True})
        for case in cases:
            with self.subTest(case=case):
                result = self.run_preflight(manifest, **dict({'request': None}, **case))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(manifest['upstreamSwitch']['commit'], result.stdout)
                self.assertNotIn('transactional switch runner', result.stderr)

    def test_confirmed_legacy_record_is_used_with_or_without_v2(self):
        for manifest in (FIXTURES[0]['manifest'], FIXTURES[1]['manifest']):
            target = manifest['upstreamSwitch']
            result = self.run_preflight(manifest, dict(source='app', confirmInUse=True, target=target))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(target['commit'], result.stdout)
            self.assertIn(target['treeSha256'], result.stdout)

    def test_changed_confirmation_refuses_instead_of_switching_to_another_record(self):
        for target in (FIXTURES[1]['expected'], FIXTURES[1]['manifest']['upstreamSwitch']):
            target = dict(target, commit='b' * 40)
            result = self.run_preflight(FIXTURES[1]['manifest'], dict(source='app', target=target))
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('live install untouched', result.stderr)

    def test_v2_refuses_when_the_transactional_runner_is_missing(self):
        result = self.run_preflight(FIXTURES[1]['manifest'], dict(source='app', target=FIXTURES[1]['expected']))
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('transactional switch runner', result.stderr)
        self.assertIn('live install untouched', result.stderr)

    def test_malformed_explicit_target_never_falls_back_to_legacy(self):
        for target in (None, {}, dict(FIXTURES[1]['expected'], commit='main')):
            result = self.run_preflight(FIXTURES[1]['manifest'], dict(source='app', target=target))
            self.assertNotEqual(result.returncode, 0, result.stdout)


if __name__ == '__main__':
    unittest.main()
