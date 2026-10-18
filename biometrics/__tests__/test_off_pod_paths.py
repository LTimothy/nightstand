"""The daily jobs read their data from the data folder, on or off the Pod."""
import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

BIOMETRICS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SLEEP_DETECTION = os.path.join(BIOMETRICS, 'sleep_detection')
sys.path.insert(0, BIOMETRICS)
import get_logger as gl

gl._get_file_handler = lambda *args: logging.NullHandler()
for name in gl.LOGGER_NAMES:
    gl.get_logger(name)

import load_raw_files
import service_health


class DataFolderPathsTest(unittest.TestCase):
    def test_archive_is_read_from_the_data_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            live = os.path.join(folder, 'live')
            archive = os.path.join(folder, 'data', 'raw-archive')
            os.makedirs(live)
            os.makedirs(archive)
            for path in (os.path.join(live, 'B.RAW'), os.path.join(live, 'SEQNO.RAW'),
                         os.path.join(archive, 'A.RAW'), os.path.join(archive, 'C.RAW')):
                open(path, 'wb').close()
            with unittest.mock.patch.object(load_raw_files.logger, 'folder_path', os.path.join(folder, 'data', '')):
                files = load_raw_files.get_current_files(live)
        self.assertEqual(sorted(os.path.basename(p) for p in files), ['A.RAW', 'B.RAW', 'C.RAW'])

    def test_biometrics_switch_is_read_from_the_data_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            os.makedirs(os.path.join(folder, 'lowdb'))
            with open(os.path.join(folder, 'lowdb', 'servicesDB.json'), 'w') as file:
                json.dump({'biometrics': {'enabled': True}}, file)
            with unittest.mock.patch.object(service_health.logger, 'folder_path', os.path.join(folder, '')):
                self.assertTrue(service_health.is_biometrics_enabled())


class ScriptsRunOffPodTest(unittest.TestCase):
    def _run(self, script, *args):
        with tempfile.TemporaryDirectory() as folder:
            env = dict(os.environ, DATA_FOLDER=folder, PYTHONDONTWRITEBYTECODE='1')
            # Under a journal (CI runners too) the console keeps only warnings; these checks read the info lines.
            env.pop('JOURNAL_STREAM', None)
            result = subprocess.run(
                [sys.executable, '-B', os.path.join(SLEEP_DETECTION, script), *args],
                env=env, capture_output=True, text=True, timeout=300,
            )
            logs = sorted(os.listdir(os.path.join(folder, 'logs')))
        return result, logs

    def test_analyzer_uses_its_arguments_and_the_data_folder(self):
        result, logs = self._run('analyze_sleep.py', '--side=left',
                                 '--start_time=2026-09-28T00:00:00Z', '--end_time=2026-09-28T01:00:00Z')
        self.assertIn('Loading RAW files from /persistent/ | 2026-09-28T00:00:00+00:00 -> 2026-09-28T01:00:00+00:00',
                      result.stderr)
        self.assertIn('sleep-analyzer.log', logs)

    def test_calibration_uses_its_arguments_and_the_data_folder(self):
        result, logs = self._run('calibrate_sensor_thresholds.py', '--side=left', '--force',
                                 '--start_time=2026-09-28T00:00:00Z', '--end_time=2026-09-28T01:00:00Z')
        self.assertIn('Loading RAW files from /persistent/ | 2026-09-28T00:00:00+00:00', result.stderr)
        self.assertIn('calibrate-sensor.log', logs)


if __name__ == '__main__':
    unittest.main()
