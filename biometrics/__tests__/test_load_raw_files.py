"""Tests for RAW-file record normalization.

Pod 5 firmware writes 'capSense2' records ({'values': [8 floats], 'status'}
per side) instead of the legacy 'capSense' shape ({'out','cen','in','status'}).
_normalize_cap_sense2 maps the first three pair-means onto out/cen/in so the
downstream baseline/presence pipeline keeps working unchanged.

Run locally (needs cbor2, numpy, pandas, not part of the node CI):
    python3 -m pytest biometrics/__tests__/test_load_raw_files.py -v
(also runs under plain unittest: python3 -m unittest discover ...)
"""
import tempfile
import unittest
import unittest.mock
from datetime import datetime, timedelta, timezone

import cbor2

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import logging
import get_logger as _gl

_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()

# load_raw_files calls the nameless get_logger(), which needs a named logger
# to exist first (same setup as test_stream_helpers).
from get_logger import get_logger, LOGGER_NAMES

for _name in LOGGER_NAMES:
    get_logger(_name)

from load_raw_files import _decode_cbor_file, _normalize_cap_sense2
import load_raw_files


def _cap_sense2_record():
    return {
        'type': 'capSense2',
        'ts': 1783638926,
        'version': 1,
        'left': {'values': [10.0, 12.0, 9.0, 11.0, 15.0, 17.0, 1.2, 1.2], 'status': 'good'},
        'right': {'values': [20.0, 22.0, 19.0, 21.0, 25.0, 27.0, 1.1, 1.1], 'status': 'good'},
    }


class TestNormalizeCapSense2(unittest.TestCase):
    def test_maps_pair_means_to_legacy_channels(self):
        record = _normalize_cap_sense2(_cap_sense2_record())
        self.assertEqual(record['type'], 'capSense')
        self.assertEqual(record['left'], {'out': 11.0, 'cen': 10.0, 'in': 16.0, 'status': 'good'})
        self.assertEqual(record['right'], {'out': 21.0, 'cen': 20.0, 'in': 26.0, 'status': 'good'})
        self.assertEqual(record['ts'], 1783638926)

    def test_short_values_list_left_unchanged(self):
        record = _cap_sense2_record()
        record['right']['values'] = [1.0, 2.0]
        out = _normalize_cap_sense2(record)
        # Still typed capSense2, so the loader's type filter drops it
        # instead of feeding a half-converted record downstream.
        self.assertEqual(out['type'], 'capSense2')
        self.assertIn('values', out['left'])

    def test_missing_side_left_unchanged(self):
        record = _cap_sense2_record()
        del record['left']
        out = _normalize_cap_sense2(record)
        self.assertEqual(out['type'], 'capSense2')

    def test_missing_status_defaults_to_good(self):
        record = _cap_sense2_record()
        del record['left']['status']
        out = _normalize_cap_sense2(record)
        self.assertEqual(out['left']['status'], 'good')


def _cap_sense_record(ts):
    channel = {'out': 1.0, 'cen': 2.0, 'in': 3.0, 'status': 'good'}
    return {'type': 'capSense', 'ts': ts, 'left': dict(channel), 'right': dict(channel)}


class TestDecodeWindowTrim(unittest.TestCase):
    """A RAW file covers ~15 minutes, so it can straddle either edge of the
    requested window; samples outside the window must not be loaded."""

    def setUp(self):
        self.window_start = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        self.window_end = self.window_start + timedelta(hours=1)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _write_file(self, first, minutes):
        path = os.path.join(self.tmp.name, 'test.RAW')
        with open(path, 'wb') as handle:
            for seq in range(minutes):
                ts = int((first + timedelta(minutes=seq)).timestamp())
                handle.write(cbor2.dumps({'seq': seq, 'data': cbor2.dumps(_cap_sense_record(ts))}))
        return path

    def _load(self, path):
        data = {'capSense': []}
        _decode_cbor_file(path, data, self.window_start, self.window_end, 'left', 1)
        return [row['ts'] for row in data['capSense']]

    def test_file_starting_before_window_is_trimmed_to_start(self):
        path = self._write_file(self.window_start - timedelta(minutes=5), 15)
        loaded = self._load(path)
        self.assertEqual(len(loaded), 10)
        self.assertEqual(min(loaded), '2026-09-28 12:00:00')

    def test_file_running_past_window_is_trimmed_to_end(self):
        path = self._write_file(self.window_end - timedelta(minutes=5), 15)
        loaded = self._load(path)
        self.assertEqual(len(loaded), 6)
        self.assertEqual(max(loaded), '2026-09-28 13:00:00')


if __name__ == '__main__':
    unittest.main()


class TestDecodeRecovery(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 9, 28, 12, 0, 0, tzinfo=timezone.utc)
        self.end = self.start + timedelta(hours=1)
        self.ts = int((self.start + timedelta(minutes=1)).timestamp())
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _load(self, content, types=('capSense',)):
        path = os.path.join(self.tmp.name, 'test.RAW')
        with open(path, 'wb') as handle:
            handle.write(content)
        data = {kind: [] for kind in types}
        _decode_cbor_file(path, data, self.start, self.end, 'left', 1)
        return data

    def _record(self, inner):
        return cbor2.dumps({'seq': 1, 'data': inner})

    def test_skips_a_corrupt_span_with_one_warning(self):
        content = (self._record(cbor2.dumps(_cap_sense_record(self.ts))) + b'\x01' * 3000
                   + self._record(cbor2.dumps(_cap_sense_record(self.ts + 60))))
        with self.assertLogs(load_raw_files.logger, 'WARNING') as logs:
            data = self._load(content)
        self.assertEqual(len(data['capSense']), 2)
        self.assertLessEqual(len(logs.records), 2, logs.output[:5])
        self.assertTrue(any('Skipped 3000 bytes' in line for line in logs.output), logs.output[:5])

    def test_stops_at_a_partial_record_that_completes_during_the_resync(self):
        records = [self._record(cbor2.dumps(_cap_sense_record(self.ts + 60 * n))) for n in range(3)]
        path = os.path.join(self.tmp.name, 'test.RAW')
        with open(path, 'wb') as handle:
            handle.write(records[0] + records[1][:-3])
        real_read = load_raw_files._read_raw_record

        grown = []

        def read_then_grow(handle):
            try:
                return real_read(handle)
            except EOFError:
                if grown:
                    raise
                grown.append(True)
                # The Pod finishes the record and writes the next one before the resync scan.
                with open(path, 'ab') as grow:
                    grow.write(records[1][-3:] + records[2])
                raise

        data = {'capSense': []}
        with unittest.mock.patch.object(load_raw_files, '_read_raw_record', side_effect=read_then_grow):
            _decode_cbor_file(path, data, self.start, self.end, 'left', 1)
        self.assertEqual(len(data['capSense']), 1)

    def test_skips_a_record_whose_length_runs_past_the_end(self):
        bad = b'\xa2\x63seq\x01\x64data\x5a\xff\xff\xff\x00'
        content = (self._record(cbor2.dumps(_cap_sense_record(self.ts))) + bad
                   + self._record(cbor2.dumps(_cap_sense_record(self.ts + 60))))
        self.assertEqual(len(self._load(content)['capSense']), 2)

    def test_keeps_every_record_of_a_bundled_payload(self):
        payload = cbor2.dumps(_cap_sense_record(self.ts)) + cbor2.dumps(_cap_sense_record(self.ts + 60))
        data = self._load(self._record(payload))
        self.assertEqual(len(data['capSense']), 2)
        self.assertNotIn('_firmware', data['capSense'][0])

    def test_loads_records_that_carry_no_piezo_sides(self):
        temperature = {'type': 'frzTemp', 'ts': self.ts, 'amb': 2100, 'hs': 1500, 'left': 1900, 'right': 1950}
        data = self._load(self._record(cbor2.dumps(temperature)), types=('frzTemp', 'log'))
        self.assertEqual(len(data['frzTemp']), 1)
