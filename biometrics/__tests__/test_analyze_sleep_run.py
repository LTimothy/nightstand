"""analyze_sleep reports what really happened and records it."""
import importlib.util
import logging
import os
import sqlite3
import sys
import types
import unittest
import unittest.mock
from datetime import datetime, timedelta, timezone

BIOMETRICS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, BIOMETRICS)
sys.path.insert(0, os.path.join(BIOMETRICS, 'sleep_detection'))
import get_logger as gl

gl._get_file_handler = lambda *args: logging.NullHandler()
for name in gl.LOGGER_NAMES:
    gl.get_logger(name)

import pandas as pd
from insufficient_data import InsufficientDataError, NO_SLEEP_MESSAGE

MIGRATION = os.path.join(BIOMETRICS, '..', 'server', 'prisma', 'migrations', '20260930000000_analysis_runs', 'migration.sql')
START = datetime(2026, 9, 28, 19, 0, tzinfo=timezone.utc)
END = START + timedelta(hours=25)


def _load_analyze_sleep():
    detector = types.ModuleType('sleep_detector')
    detector.detect_sleep = lambda *a, **k: None
    detector.detect_movement = lambda *a, **k: None
    database = types.ModuleType('db')
    database.replace_analysis_results = lambda *a, **k: (0, 0)
    database.widen_window = lambda side, start, end: (start, end)
    path = os.path.join(BIOMETRICS, 'sleep_detection', 'analyze_sleep.py')
    spec = importlib.util.spec_from_file_location('analyze_sleep_under_test', path)
    module = importlib.util.module_from_spec(spec)
    with unittest.mock.patch.dict(sys.modules, {'sleep_detector': detector, 'db': database}):
        spec.loader.exec_module(module)
    return module


class RunAnalysisTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = _load_analyze_sleep()

    def setUp(self):
        self.conn = sqlite3.connect(':memory:', isolation_level=None)
        with open(MIGRATION) as file:
            self.conn.executescript(file.read())
        frame = pd.DataFrame({'left_out': [1.0, 2.0, 3.0]})
        for name, kwargs in (
            ('get_available_memory_mb', {'return_value': 2000}),
            ('detect_sleep', {'return_value': (frame, [{'side': 'left'}], frame.copy())}),
            ('detect_movement', {'return_value': [(1790568000, 0.4), (1790568120, 2.5)]}),
            ('replace_analysis_results', {'return_value': (1, 2)}),
            ('widen_window', {'side_effect': lambda side, start, end: (start, end)}),
        ):
            patcher = unittest.mock.patch.object(self.module, name, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, conn=None):
        return self.module.run_analysis('left', START, END, '/persistent/', conn=conn or self.conn)

    def _runs(self):
        return self.conn.execute(
            'SELECT side, kind, status, window_start, window_end, rows_loaded, records_written, movement_written, '
            'error, finished_at IS NOT NULL, duration_ms >= 0, peak_rss_mb > 0 FROM analysis_runs'
        ).fetchall()

    def test_successful_run_is_recorded_and_healthy(self):
        status, message = self._run()
        self.assertEqual(status, 'healthy')
        self.assertEqual(message, '1 sleep record and 2 movement rows from 3 sensor rows')
        self.assertEqual(self._runs(), [
            ('left', 'analyze', 'ok', int(START.timestamp()), int(END.timestamp()), 3, 1, 2, None, 1, 1, 1),
        ])
        self.module.replace_analysis_results.assert_called_once_with(
            'left', [{'side': 'left'}], [(1790568000, 0.4), (1790568120, 2.5)],
            int(START.timestamp()), int(END.timestamp()))

    def test_a_run_that_finds_no_sleep_says_so(self):
        frame = pd.DataFrame({'left_out': [1.0, 2.0, 3.0]})
        self.module.detect_sleep.return_value = (frame, [], frame.copy())
        self.module.replace_analysis_results.return_value = (0, 2)
        status, message = self._run()
        self.assertEqual((status, message), ('healthy', NO_SLEEP_MESSAGE))
        self.assertEqual(self._runs()[0][2], 'ok')

    def test_a_run_that_finds_sleep_reports_the_summary(self):
        status, message = self._run()
        self.assertEqual(status, 'healthy')
        self.assertNotEqual(message, NO_SLEEP_MESSAGE)
        self.assertEqual(message, '1 sleep record and 2 movement rows from 3 sensor rows')

    def test_sleep_kept_as_stored_still_reports_the_summary(self):
        self.module.replace_analysis_results.return_value = (0, 2)
        status, message = self._run()
        self.assertEqual((status, message), ('healthy', '0 sleep records and 2 movement rows from 3 sensor rows'))

    def test_a_widened_window_is_read_written_and_recorded(self):
        wide = (int(START.timestamp()) - 1800, int(END.timestamp()) + 1800)
        self.module.widen_window.side_effect = lambda side, start, end: wide
        self._run()
        read_start, read_end = self.module.detect_sleep.call_args.args[1:3]
        self.assertEqual((int(read_start.timestamp()), int(read_end.timestamp())), wide)
        self.assertEqual(self.module.replace_analysis_results.call_args.args[3:], wide)
        [row] = self._runs()
        self.assertEqual(row[3:5], wide)

    def test_failed_database_write_is_reported_as_failed(self):
        self.module.replace_analysis_results.side_effect = sqlite3.OperationalError('database is locked')
        with unittest.mock.patch.object(self.module.logger, 'error'):
            status, message = self._run()
        self.assertEqual(status, 'failed')
        self.assertIn('database is locked', message)
        [row] = self._runs()
        self.assertEqual(row[2], 'failed')
        self.assertIn('database is locked', row[8])
        self.assertEqual(row[5], 3)
        self.assertIsNone(row[6])

    def test_a_failing_finish_run_still_returns_the_outcome(self):
        with unittest.mock.patch.object(self.module.analysis_runs, 'finish_run', side_effect=RuntimeError('boom')), \
                unittest.mock.patch.object(self.module.logger, 'warning') as warned:
            status, _ = self._run()
        self.assertEqual(status, 'healthy')
        self.assertIn('boom', warned.call_args.args[0])

    def test_a_failing_set_window_does_not_stop_the_run(self):
        wide = (int(START.timestamp()) - 1800, int(END.timestamp()) + 1800)
        self.module.widen_window.side_effect = lambda side, start, end: wide
        with unittest.mock.patch.object(self.module.analysis_runs, 'set_window', side_effect=RuntimeError('boom')), \
                unittest.mock.patch.object(self.module.logger, 'warning') as warned:
            status, _ = self._run()
        self.assertEqual(status, 'healthy')
        self.assertIn('boom', warned.call_args.args[0])
        self.assertEqual(self.module.replace_analysis_results.call_args.args[3:], wide)

    def test_a_failing_widen_window_is_a_recorded_failure(self):
        self.module.widen_window.side_effect = sqlite3.OperationalError('database is locked')
        with unittest.mock.patch.object(self.module.logger, 'error'):
            status, message = self._run()
        self.assertEqual(status, 'failed')
        self.assertIn('database is locked', message)
        [row] = self._runs()
        self.assertEqual((row[2], row[3:5]), ('failed', (int(START.timestamp()), int(END.timestamp()))))
        self.assertIn('database is locked', row[8])
        self.module.detect_sleep.assert_not_called()

    def test_missing_sensor_data_is_waiting_not_failed(self):
        self.module.detect_sleep.side_effect = InsufficientDataError('No piezo rows found')
        status, message = self._run()
        self.assertEqual((status, message), ('waiting_for_data', 'No piezo rows found'))
        self.assertEqual(self._runs()[0][2], 'no_data')

    def test_low_memory_is_a_recorded_failure(self):
        self.module.get_available_memory_mb.return_value = 100
        with unittest.mock.patch.object(self.module.logger, 'error'):
            status, _ = self._run()
        self.assertEqual(status, 'failed')
        self.assertEqual(self._runs()[0][2], 'failed')
        self.module.detect_sleep.assert_not_called()

    def test_analysis_runs_without_the_runs_table(self):
        bare = sqlite3.connect(':memory:', isolation_level=None)
        with unittest.mock.patch.object(self.module.logger, 'warning') as warned:
            status, _ = self._run(conn=bare)
        self.assertEqual(status, 'healthy')
        warned.assert_called()


class MainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = _load_analyze_sleep()

    def test_reports_failed_and_does_nothing_while_biometrics_is_off(self):
        argv = ['analyze_sleep.py', '--side', 'left', '--start_time', '2026-09-28 19:00:00', '--end_time', '2026-09-29 20:00:00']
        with unittest.mock.patch.object(sys, 'argv', argv), \
                unittest.mock.patch.object(self.module, 'is_biometrics_enabled', return_value=False), \
                unittest.mock.patch.object(self.module, 'update_health') as health, \
                unittest.mock.patch.object(self.module, 'run_analysis') as analysis:
            self.module.main()
        health.assert_called_once_with('analyzeSleepLeft', 'failed', 'Biometrics is off')
        analysis.assert_not_called()


    def test_runs_when_the_switch_cannot_be_read(self):
        argv = ['analyze_sleep.py', '--side', 'left', '--start_time', '2026-09-28 19:00:00', '--end_time', '2026-09-29 20:00:00']
        with unittest.mock.patch.object(sys, 'argv', argv), \
                unittest.mock.patch.object(self.module, 'is_biometrics_enabled', return_value=None), \
                unittest.mock.patch.object(self.module, 'update_health') as health, \
                unittest.mock.patch.object(self.module, 'run_analysis', return_value=('healthy', '')) as analysis:
            self.module.main()
        analysis.assert_called_once()
        health.assert_called_with('analyzeSleepLeft', 'healthy', '')

if __name__ == '__main__':
    unittest.main()
