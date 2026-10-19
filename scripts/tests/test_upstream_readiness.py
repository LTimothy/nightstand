"""Readiness must outlast delayed startup and prove ongoing processing."""
import importlib.util
import os
import signal
import tempfile
from unittest.mock import patch
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


class UpstreamReadinessTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('upstream_readiness', SCRIPTS / 'upstream_readiness.py')
        self.assertTrue(Path(spec.origin).exists(), 'Readiness checker is missing')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def sample(self, now, enabled=True):
        def service(pid):
            return dict(active=True, pid=pid, invocation='a' * 32,
                        start=1000000, restarts=0, procStartTicks=100)
        return dict(version='3.0.3', server=service(10), stream=service(20), enabled=enabled,
                    health=dict(status='healthy', age=0, postLaunch=True),
                    probe=dict(schemaVersion=1, token='launch-token', pid=20, procStartTicks=100,
                               launched=0, heartbeat=now, successes=int(now) + 1,
                               lastSuccess=now, errors=0, workerAlive=True, fatal=False))

    def check(self, enabled=True):
        return self.module.Readiness('3.0.3', enabled, 'launch-token')

    def sample_probe(self, probe):
        service = dict(active=True, pid=20, invocation='a' * 32, start=1, restarts=0, procStartTicks=100)
        replies = {'deviceStatus': {'freeSleep': {'version': '3.0.3'}},
                   'services': {'biometrics': {'enabled': True, 'jobs': {}}}}
        signal.signal(signal.SIGALRM, lambda *_: self.fail('Reading the probe blocked'))
        signal.alarm(5)
        self.addCleanup(signal.alarm, 0)
        with patch.object(self.module, 'service_state', return_value=service), \
                patch.object(self.module, 'http_json', side_effect=replies.__getitem__):
            return self.module.sample_system(probe, True)

    def test_a_fifo_probe_is_refused_without_blocking(self):
        with tempfile.TemporaryDirectory() as folder:
            probe = Path(folder) / 'probe.json'
            os.mkfifo(str(probe))
            with self.assertRaisesRegex(ValueError, 'regular file'):
                self.sample_probe(probe)

    def test_enabled_requires_ninety_seconds_of_sustained_success(self):
        check = self.check()
        for now in range(0, 90, 5):
            self.assertFalse(check.observe(self.sample(now), now))
        self.assertTrue(check.observe(self.sample(90), 90))

    def test_second_31_import_failure_never_passes(self):
        check = self.check()
        for now in range(0, 31, 5):
            self.assertFalse(check.observe(self.sample(now), now))
        sample = self.sample(31)
        sample['stream']['active'] = False
        with self.assertRaises(ValueError):
            check.observe(sample, 31)

    def test_stale_health_dead_worker_errors_and_silent_input_fail(self):
        for failure in ('health', 'worker', 'errors', 'silent', 'heartbeat', 'fatal'):
            with self.subTest(failure=failure):
                check = self.check()
                for now in range(0, 90, 5):
                    self.assertFalse(check.observe(self.sample(now), now))
                sample = self.sample(90)
                if failure == 'health':
                    sample['health']['age'] = 76
                elif failure == 'worker':
                    sample['probe']['workerAlive'] = False
                elif failure == 'errors':
                    sample['probe']['errors'] = 1
                elif failure == 'silent':
                    sample['probe']['lastSuccess'] = 0
                elif failure == 'heartbeat':
                    sample['probe']['heartbeat'] = 0
                else:
                    sample['probe']['fatal'] = True
                self.assertFalse(check.observe(sample, 90))

    def test_restarts_pid_reuse_and_server_replacement_fail(self):
        for component, field, replacement in (
            ('stream', 'pid', 21), ('stream', 'restarts', 1),
            ('stream', 'invocation', 'b' * 32), ('stream', 'start', 2000000),
            ('stream', 'procStartTicks', 200), ('server', 'pid', 11),
            ('server', 'restarts', 1)):
            with self.subTest(component=component, field=field):
                check = self.check()
                check.observe(self.sample(0), 0)
                sample = self.sample(90)
                sample[component][field] = replacement
                with self.assertRaises(ValueError):
                    check.observe(sample, 90)

    def test_wrong_version_wrong_token_old_launch_and_regressing_counter_fail(self):
        for failure in ('version', 'token', 'pid', 'start', 'regressing'):
            with self.subTest(failure=failure):
                check = self.check()
                check.observe(self.sample(0), 0)
                sample = self.sample(90)
                if failure == 'version':
                    sample['version'] = '3.0.2'
                elif failure == 'regressing':
                    sample['probe']['successes'] = 0
                else:
                    key = dict(token='token', pid='pid', start='procStartTicks')[failure]
                    sample['probe'][key] = 'old-launch' if key == 'token' else 99
                with self.assertRaises(ValueError):
                    check.observe(sample, 90)

    def test_disabled_stays_disabled_without_requiring_probe_or_stream(self):
        check = self.check(False)
        for now in range(0, 91, 5):
            sample = self.sample(now, False)
            sample.pop('probe')
            sample.pop('health')
            sample['stream'] = dict(active=False)
            self.assertEqual(check.observe(sample, now), now == 90)
        sample['stream']['active'] = True
        with self.assertRaises(ValueError):
            check.observe(sample, 91)

    def test_enabled_failure_is_not_treated_as_disabled(self):
        with self.assertRaises(ValueError):
            self.check().observe(self.sample(0, False), 0)
        with self.assertRaises(ValueError):
            self.module.Readiness('3.0.3', None, 'launch-token')

    def test_missing_probe_stale_health_and_silent_input_time_out_at_five_minutes(self):
        for failure in ('missing', 'health', 'silent', 'errors', 'worker'):
            with self.subTest(failure=failure):
                clock = [0]
                def sleep(seconds):
                    clock[0] += seconds
                def sample():
                    value = self.sample(clock[0])
                    if failure == 'missing':
                        value['probe'] = None
                    elif failure == 'health':
                        value['health']['postLaunch'] = False
                    elif failure == 'silent':
                        value['probe']['successes'] = 0
                    elif failure == 'errors':
                        value['probe']['errors'] = 1
                    else:
                        value['probe']['workerAlive'] = False
                    return value
                with self.assertRaises(TimeoutError):
                    self.module.wait_ready(self.check(), sample, lambda: clock[0], sleep)
                self.assertEqual(clock[0], 300)

    def test_success_counter_must_advance_throughout_window(self):
        check = self.check()
        for now in range(0, 100, 5):
            sample = self.sample(now)
            sample['probe']['successes'] = 1
            self.assertFalse(check.observe(sample, now))

    def test_sampling_gap_cannot_count_as_uninterrupted_runtime(self):
        check = self.check()
        check.observe(self.sample(0), 0)
        self.assertFalse(check.observe(self.sample(90), 90))

    def test_slow_final_observation_cannot_pass_after_deadline(self):
        clock = [0]
        def sleep(seconds):
            clock[0] += seconds
        def sample():
            if clock[0] < 210:
                value = self.sample(clock[0])
                value['probe'] = None
                return value
            if clock[0] == 295:
                clock[0] = 300
            return self.sample(clock[0])
        with self.assertRaises(TimeoutError):
            self.module.wait_ready(self.check(), sample, lambda: clock[0], sleep)


if __name__ == '__main__':
    unittest.main()
