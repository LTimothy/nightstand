"""Calibration on Pods that write the older capSense records: the baseline,
its noise and the format the calibrator saw."""
import json
import logging
import os
import sqlite3
import sys
import tempfile
import unittest
import unittest.mock
from collections import Counter
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'sleep_detection'))
sys.path.insert(0, HERE)

import get_logger as _gl

_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()
from get_logger import get_logger, LOGGER_NAMES

for _name in LOGGER_NAMES:
    get_logger(_name)

import pandas as pd

import calibration
import cap_data
import load_raw_files
import presence_scenarios as scenarios
from presence import sensors
from presence.params import baselines_from_calibration
from presence.replay import FrameCollector
from presence_scenarios import Night
from test_presence_calibration import SCHEMA

EMPTY = Night(seconds=1800)


def empty_records(kind='legacy'):
    records = scenarios.legacy_raw_records(EMPTY, 50.0) if kind == 'legacy' else scenarios.raw_records(EMPTY)
    quiet = scenarios.piezo_samples(2_000.0)
    for index, record in enumerate(records):
        if record['type'] == 'piezo-dual':
            record = dict(record, left1=quiet, left2=quiet, right1=quiet, right2=quiet)
        elif record['type'] == 'capSense':
            # A one-count wobble on out, so the summed noise is measurable.
            record['left']['out'] += index % 3 - 1
        yield record


def with_placeholders(records, every=50):
    """Every so many capSense records carry the -32768 placeholder on the left out channel."""
    for index, record in enumerate(records):
        if record['type'] == 'capSense' and index % every == 0:
            record['left']['out'] = -32768
        yield record


class LegacyCalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import calibrate_sensor_thresholds
        cls.calibrator = calibrate_sensor_thresholds

    def calibrate(self, enabled, records=None):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.executescript(SCHEMA + 'CREATE TABLE vitals (timestamp INTEGER NOT NULL);')
        with tempfile.TemporaryDirectory() as folder:
            scenarios.write_raw_file(os.path.join(folder, 'empty.RAW'),
                                     empty_records() if records is None else records)
            start = datetime.fromtimestamp(scenarios.T0, timezone.utc)
            with unittest.mock.patch.object(load_raw_files.logger, 'folder_path', os.path.join(folder, '')), \
                    unittest.mock.patch.object(cap_data, 'LEFT_CAP_BASE_LINE_FILE_PATH', os.path.join(folder, 'l.json')), \
                    unittest.mock.patch.object(calibration, '_connection', lambda conn_=None: conn_ or conn), \
                    unittest.mock.patch.object(self.calibrator, 'biometrics_v2_enabled', return_value=enabled):
                try:
                    self.calibrator.calibrate_sensor_thresholds('left', start, start + timedelta(seconds=1800), folder)
                except Exception:
                    # A run without capacitance rows raises after recording itself.
                    pass
        profile = calibration.get_profile('left', 'cap', conn=conn)
        runs = conn.execute("SELECT status, payload FROM calibration_runs WHERE sensor_type = 'cap'").fetchall()
        return (profile['payload'] if profile else None), runs

    def test_one_unknown_record_does_not_fail_capsense2_calibration(self):
        records = list(empty_records('capsense2'))
        records.append({'type': 'capSense3', 'ts': scenarios.T0 + 100})
        payload, runs = self.calibrate(enabled=True, records=records)
        self.assertIsNotNone(payload)
        self.assertEqual(payload['provenance']['format'], 'capSense2')
        self.assertEqual(runs[0][0], 'success')

    def test_a_baseline_in_counts_is_learned_from_capsense(self):
        payload, _ = self.calibrate(enabled=True)
        self.assertAlmostEqual(payload['left_out']['mean'], 387.0, places=0)
        self.assertEqual(payload['left_cen']['mean'], 381.0)
        self.assertEqual(payload['left_in']['mean'], 505.0)
        self.assertGreater(payload['delta_noise'], 0.0)
        self.assertLess(payload['delta_noise'], 2.0)

    def test_the_new_detector_reads_that_baseline(self):
        payload, _ = self.calibrate(enabled=True)
        right = scenarios.legacy_cap_payload('right', delta_noise=1.0)
        baselines = baselines_from_calibration({
            'left': {'cap': payload, 'cap_occupied': None, 'piezo_floors': []},
            'right': {'cap': right, 'cap_occupied': None, 'piezo_floors': []},
        })
        self.assertAlmostEqual(baselines['left'].mean[2], 505.0)
        self.assertEqual(baselines['left'].noise, payload['delta_noise'])

    def test_the_run_records_the_format_with_the_switch_on(self):
        _, runs = self.calibrate(enabled=True)
        self.assertEqual([(status, json.loads(payload)['format']) for status, payload in runs],
                         [('success', 'capSense')])
        self.assertEqual(json.loads(runs[0][1])['provenance']['format'], 'capSense')
        _, runs = self.calibrate(enabled=True, records=empty_records('capsense2'))
        self.assertEqual(json.loads(runs[0][1])['format'], 'capSense2')
        self.assertEqual(json.loads(runs[0][1])['provenance']['normalizationVersion'], 1)

    def test_switch_off_keeps_channel_calculations_and_adds_provenance(self):
        payload, runs = self.calibrate(enabled=False)
        self.assertNotIn('delta_noise', payload)
        self.assertEqual(runs[0][0], 'success')
        self.assertEqual(json.loads(runs[0][1])['provenance'], payload['provenance'])
        self.assertEqual(payload['provenance']['format'], 'capSense')

    def test_a_placeholder_count_stays_out_of_what_the_new_detector_reads(self):
        records = list(with_placeholders(empty_records()))
        on, _ = self.calibrate(enabled=True, records=records)
        self.assertAlmostEqual(on['reading_means']['out'], 387.0, places=0)
        self.assertEqual(on['reading_means']['cen'], 381.0)
        right = scenarios.legacy_cap_payload('right')
        baselines = baselines_from_calibration({
            'left': {'cap': on, 'cap_occupied': None, 'piezo_floors': []},
            'right': {'cap': right, 'cap_occupied': None, 'piezo_floors': []},
        })
        self.assertAlmostEqual(baselines['left'].mean[0], 387.0, places=0)

    def test_the_baseline_older_versions_read_is_the_same_either_way(self):
        # The analyzer with the switch off, and older versions, read only the channel entries.
        records = list(with_placeholders(empty_records()))
        on, _ = self.calibrate(enabled=True, records=records)
        off, _ = self.calibrate(enabled=False, records=records)
        self.assertLess(off['left_out']['mean'], 0.0)
        self.assertEqual({key: value for key, value in on.items() if key not in ('delta_noise', 'reading_means')}, off)

    def test_only_a_capsense_window_with_the_switch_on_stores_reading_means(self):
        self.assertNotIn('reading_means', self.calibrate(enabled=False)[0])
        self.assertNotIn('reading_means', self.calibrate(enabled=True, records=empty_records('capsense2'))[0])

    def test_a_run_without_readable_capacitance_still_says_what_it_saw(self):
        records = [dict(record, type='capSense3') if record['type'] == 'capSense' else record
                   for record in empty_records()]
        _, runs = self.calibrate(enabled=True, records=records)
        self.assertEqual(runs[0][0], 'insufficient_data')
        self.assertEqual(json.loads(runs[0][1]), {'format': 'unknown'})

    def test_a_window_without_capacitance_waits_for_data(self):
        records = [record for record in empty_records() if record['type'] != 'capSense']
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                _, runs = self.calibrate(enabled=enabled, records=records)
                self.assertEqual([status for status, _ in runs], ['insufficient_data'])


class FormatPayloadTest(unittest.TestCase):
    def test_the_most_common_known_format_wins(self):
        import calibrate_sensor_thresholds as calibrator
        self.assertIsNone(calibrator.format_payload(None))
        self.assertEqual(calibrator.format_payload(Counter()), {'format': 'none'})
        self.assertEqual(calibrator.format_payload(Counter(unknown=5)), {'format': 'unknown'})
        self.assertEqual(calibrator.format_payload(Counter(capSense=3, capSense2=9, unknown=50)),
                         {'format': 'capSense2'})

    def test_a_tie_goes_to_the_format_the_analyzer_would_pick(self):
        import calibrate_sensor_thresholds as calibrator
        tie = Counter(capSense=3, capSense2=3)
        self.assertEqual(calibrator.format_payload(tie), {'format': 'capSense2'})
        # The order formats are listed in decides, not their names.
        reordered = {name: sensors.FORMATS[name] for name in ('capSense', 'capSense2')}
        with unittest.mock.patch.dict(sensors.FORMATS, reordered, clear=True):
            self.assertEqual(calibrator.format_payload(tie), {'format': 'capSense'})
            collector = FrameCollector(None)
            collector.cap_formats.update(tie)
            self.assertIs(collector.cap_format(), sensors.CAPSENSE)


class FormatCountTest(unittest.TestCase):
    def test_only_records_in_the_window_are_counted(self):
        # capSense2 for the ten minutes before the window, capSense inside it,
        # and an unknown type every second throughout.
        night = Night(seconds=1200)
        records = list(scenarios.raw_records(night, end=600)) + list(scenarios.legacy_raw_records(night, 50.0, start=600))
        records += [{'type': 'capSense3', 'ts': scenarios.T0 + second} for second in range(1200)]
        start = datetime.fromtimestamp(scenarios.T0 + 600, timezone.utc)
        counts = Counter()
        with tempfile.TemporaryDirectory() as folder:
            scenarios.write_raw_file(os.path.join(folder, 'night.RAW'), records)
            load_raw_files.load_raw_files(folder, start, start + timedelta(seconds=599), 'left', sensor_count=1,
                                          raw_data_types=['capSense', 'piezo-dual'], cap_formats=counts)
        self.assertEqual(counts, Counter(capSense=1200, unknown=600))


class NegativeCountTest(unittest.TestCase):
    def test_rows_with_a_negative_count_are_left_out_of_the_noise(self):
        frame = pd.DataFrame({'left_out': [387, 388, -32768, 387], 'left_cen': [381] * 4, 'left_in': [505] * 4})
        clean = pd.DataFrame({'left_out': [387, 388, 387], 'left_cen': [381] * 3, 'left_in': [505] * 3})
        self.assertAlmostEqual(cap_data.summed_delta_noise(frame, 'left'), cap_data.summed_delta_noise(clean, 'left'))

    def means(self, out):
        frame = pd.DataFrame({'left_out': out, 'left_cen': [381] * len(out), 'left_in': [505] * len(out)})
        return cap_data.reading_means(frame, 'left')

    def test_negative_counts_are_left_out_of_the_reading_means(self):
        self.assertEqual(self.means([387, 389, -32768, 387, -1]), {'out': 388 - 1 / 3, 'cen': 381.0, 'in': 505.0})

    def test_a_single_reading_is_its_own_mean(self):
        self.assertEqual(self.means([-32768, 390, -32768])['out'], 390.0)

    def test_a_channel_of_placeholders_only_is_left_out(self):
        self.assertEqual(self.means([-32768, -32768]), {'cen': 381.0, 'in': 505.0})

    def test_the_new_detector_falls_back_to_the_plain_mean_per_channel(self):
        payload = scenarios.legacy_cap_payload('left', reading_means={'out': 390.0, 'cen': 'bad'})
        right = scenarios.legacy_cap_payload('right')
        baselines = baselines_from_calibration({
            'left': {'cap': payload, 'cap_occupied': None, 'piezo_floors': []},
            'right': {'cap': right, 'cap_occupied': None, 'piezo_floors': []},
        })
        self.assertEqual(baselines['left'].mean, (390.0, 381.0, 505.0))
        self.assertEqual(baselines['right'].mean, (1076.0, 1075.0, 1074.0))

if __name__ == '__main__':
    unittest.main()
