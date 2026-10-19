"""Tests for the stream service's record filtering and dedup helpers.

These cover the pure logic shared by the NATS JetStream consumer and the
RAW-file fallback watcher: outer-row decoding, the piezo queueing filter
(type/timestamp/recency checks), and the bounded sequence-dedup ring.

Run locally (needs cbor2, numpy, watchdog):
    python3 -m unittest biometrics.__tests__.test_stream_helpers -v
(also runs under plain unittest discover, or pytest where available)
"""
import asyncio
import time
import types
import unittest
import unittest.mock
from datetime import datetime, timedelta

import cbor2

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'stream'))

import logging
import shutil
import tempfile
import get_logger as _gl

_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()

from get_logger import get_logger, LOGGER_NAMES

# db.py derives its SQLite path from the folder_path of whichever logger a
# nameless get_logger() finds first, which points at a developer-machine path
# locally, give every logger a writable temp dir instead. Other test modules
# in the same run may already have created some of them.
_tmp_folder = tempfile.mkdtemp() + '/'
for _name in LOGGER_NAMES:
    get_logger(_name).folder_path = _tmp_folder

import stream
from presence import model
from presence.sensors import CAPSENSE, CAPSENSE2


def recent_piezo(seq=None, ts=None):
    record = {
        'type': 'piezo-dual',
        'ts': ts if ts is not None else datetime.now().timestamp(),
        'right1': b'\x01\x00\x00\x00',
    }
    if seq is not None:
        record['seq'] = seq
    return record


class StreamHelpersTestCase(unittest.TestCase):
    def setUp(self):
        stream.processed_sequences.clear()
        stream.processed_sequence_order.clear()
        while not stream.piezo_record_queue.empty():
            stream.piezo_record_queue.get_nowait()


class TestDecodeRawRow(StreamHelpersTestCase):
    def test_unwraps_nested_data(self):
        inner = {'type': 'piezo-dual', 'ts': 1.0}
        row = {'seq': 1, 'data': cbor2.dumps(inner)}
        decoded = list(stream._decode_raw_row(row))
        self.assertEqual(len(decoded), 1)
        self.assertEqual(decoded[0]['type'], inner['type'])
        self.assertEqual(decoded[0]['ts'], inner['ts'])
        self.assertEqual(decoded[0]['_firmware']['sequence'], 1)

    def test_passes_through_direct_records(self):
        row = {'type': 'piezo-dual', 'ts': 1.0}
        self.assertEqual(list(stream._decode_raw_row(row))[0]['type'], row['type'])

    def test_rejects_non_dict(self):
        self.assertEqual(list(stream._decode_raw_row([1, 2])), [])
        self.assertEqual(list(stream._decode_raw_row(None)), [])


class TestQueueDecodedPiezoRecord(StreamHelpersTestCase):
    def test_queues_recent_piezo_record(self):
        self.assertTrue(stream._queue_decoded_piezo_record(recent_piezo(seq=1)))
        self.assertEqual(stream.piezo_record_queue.qsize(), 1)

    def test_skips_wrong_type(self):
        self.assertFalse(stream._queue_decoded_piezo_record({'type': 'frzTemp', 'ts': 0}))

    def test_skips_missing_timestamp(self):
        self.assertFalse(stream._queue_decoded_piezo_record({'type': 'piezo-dual'}))

    def test_skips_stale_records(self):
        stale_ts = (datetime.now() - timedelta(minutes=10)).timestamp()
        self.assertFalse(stream._queue_decoded_piezo_record(recent_piezo(ts=stale_ts)))

    def test_deduplicates_by_sequence(self):
        self.assertTrue(stream._queue_decoded_piezo_record(recent_piezo(seq=7)))
        self.assertFalse(stream._queue_decoded_piezo_record(recent_piezo(seq=7)))
        self.assertEqual(stream.piezo_record_queue.qsize(), 1)

    def test_records_without_sequence_are_not_deduplicated(self):
        self.assertTrue(stream._queue_decoded_piezo_record(recent_piezo()))
        self.assertTrue(stream._queue_decoded_piezo_record(recent_piezo()))


class TestSequenceRing(StreamHelpersTestCase):
    def test_ring_evicts_oldest(self):
        limit = stream.PROCESSED_SEQUENCE_LIMIT
        for seq in range(limit + 10):
            stream._mark_sequence_processed(seq)
        self.assertEqual(len(stream.processed_sequences), limit)
        self.assertNotIn(0, stream.processed_sequences)
        self.assertIn(limit + 9, stream.processed_sequences)


def recent_cap(ts=None):
    return {
        'type': 'capSense2',
        'ts': ts if ts is not None else datetime.now().timestamp(),
        'left': {'values': [12.0] * 6 + [1.2, 1.2], 'status': 'good'},
        'right': {'values': [13.0] * 6 + [1.2, 1.2], 'status': 'good'},
    }


def cap_profiles(cap_format=CAPSENSE2):
    return {
        side: {
            'cap': {**{f'{side}_{channel}': {'mean': 11.0, 'std': 1} for channel in ('out', 'cen', 'in')},
                    'provenance': {'format': cap_format.name, 'normalizationVersion': 1}},
            'cap_occupied': None,
            'piezo_floors': [],
        }
        for side in ('left', 'right')
    }


class CapPresenceTestCase(StreamHelpersTestCase):
    def setUp(self):
        super().setUp()
        self.latest = stream.LatestCap()
        stream._unknown_cap_logged.clear()
        stream._experimental_logged.clear()
        overflow = unittest.mock.patch.object(stream, '_unknown_cap_overflow_logged', False)
        overflow.start()
        self.addCleanup(overflow.stop)
        patcher = unittest.mock.patch.object(stream, 'latest_cap', self.latest)
        patcher.start()
        self.addCleanup(patcher.stop)


class TestStoreDecodedCapRecord(CapPresenceTestCase):
    def test_keeps_the_newest_values(self):
        record = recent_cap()
        self.assertTrue(stream._store_decoded_cap_record(record))
        self.assertEqual(self.latest.read(), (int(record['ts']), (12.0, 12.0, 12.0), (13.0, 13.0, 13.0), CAPSENSE2))
        self.assertEqual(self.latest.cap_format().name, 'capSense2')

    def test_consumes_stale_and_malformed_records_without_storing(self):
        self.assertTrue(stream._store_decoded_cap_record(recent_cap(ts=(datetime.now() - timedelta(minutes=10)).timestamp())))
        self.assertTrue(stream._store_decoded_cap_record({'type': 'capSense2', 'ts': datetime.now().timestamp(), 'left': {}}))
        self.assertTrue(stream._store_decoded_cap_record({'type': 'capSense2'}))
        self.assertIsNone(self.latest.read())

    def test_consumes_records_with_unusable_timestamps_or_values(self):
        for ts in (float('nan'), float('inf'), 1e20, True):
            self.assertTrue(stream._store_decoded_cap_record(recent_cap(ts=ts)))
        record = recent_cap()
        record['left']['values'] = ['12.0'] * 8
        self.assertTrue(stream._store_decoded_cap_record(record))
        self.assertIsNone(self.latest.read())

    def test_consumes_records_that_read_as_nothing_without_storing(self):
        for ts in ('1790568000', None):
            record = recent_cap()
            record['ts'] = ts
            self.assertTrue(stream._store_decoded_cap_record(record))
        both_unreadable = recent_cap()
        both_unreadable['left'] = both_unreadable['right'] = None
        self.assertTrue(stream._store_decoded_cap_record(both_unreadable))
        oversized = recent_cap()
        oversized['right']['values'] = [10 ** 400] * 8
        self.assertTrue(stream._store_decoded_cap_record(oversized))
        self.assertIsNone(self.latest.read())
        self.assertIsNone(self.latest.cap_format())

    def test_keeps_legacy_capsense_with_its_format(self):
        record = {'type': 'capSense', 'ts': datetime.now().timestamp(), 'seq': 1,
                  'left': {'out': 387, 'cen': 381, 'in': 505, 'status': 'good'},
                  'right': {'out': 1076, 'cen': 1075, 'in': 1074, 'status': 'good'}}
        self.assertTrue(stream._store_decoded_cap_record(record))
        self.assertEqual(self.latest.read()[1], (387.0, 381.0, 505.0))
        self.assertEqual(self.latest.cap_format().name, 'capSense')

    def test_consumes_an_unknown_capacitance_type_and_says_so_once(self):
        record = {'type': 'capSense3', 'ts': datetime.now().timestamp(), 'left': {'values': [1.0] * 18}}
        with self.assertLogs(stream.logger, level='WARNING') as logs:
            self.assertTrue(stream._store_decoded_cap_record(record))
            self.assertTrue(stream._store_decoded_cap_record(record))
            stream.logger.warning('end')
        self.assertEqual(sum('capSense3' in line for line in logs.output), 1)
        self.assertIsNone(self.latest.read())

    def test_says_so_for_each_unknown_type_and_for_the_wider_names(self):
        kinds = ('capsense4', 'cap_sense', 'cap-v2', 'capacitance')
        with self.assertLogs(stream.logger, level='WARNING') as logs:
            for kind in kinds * 2:
                self.assertTrue(stream._store_decoded_cap_record({'type': kind, 'ts': datetime.now().timestamp()}))
            stream.logger.warning('end')
        for kind in kinds:
            self.assertEqual(sum(kind in line for line in logs.output), 1, kind)

    def test_bounds_the_unknown_types_it_remembers_and_the_name_it_logs(self):
        now = datetime.now().timestamp()
        with self.assertLogs(stream.logger, level='WARNING') as logs:
            for index in range(stream.UNKNOWN_CAP_LOG_LIMIT + 10):
                self.assertTrue(stream._store_decoded_cap_record({'type': f'capSense{index + 3}', 'ts': now}))
            self.assertTrue(stream._store_decoded_cap_record({'type': 'capSense' + 'x' * 500, 'ts': now}))
            stream.logger.warning('end')
        self.assertEqual(len(stream._unknown_cap_logged), stream.UNKNOWN_CAP_LOG_LIMIT)
        # One line per remembered type, one saying more were not shown, and 'end'.
        self.assertEqual(len(logs.output), stream.UNKNOWN_CAP_LOG_LIMIT + 2)
        self.assertEqual(sum('not shown' in line for line in logs.output), 1)

    def test_logs_a_long_unknown_type_name_truncated(self):
        record = {'type': 'capSense' + 'x' * 500, 'ts': datetime.now().timestamp()}
        with self.assertLogs(stream.logger, level='WARNING') as logs:
            self.assertTrue(stream._store_decoded_cap_record(record))
        self.assertLess(len(logs.output[0]), 250)
        self.assertNotIn('x' * (stream.UNKNOWN_CAP_NAME_LENGTH + 1), logs.output[0])

    def test_logs_an_unknown_type_name_on_one_line(self):
        record = {'type': 'capSense\n3\x1b[0m', 'ts': datetime.now().timestamp()}
        with self.assertLogs(stream.logger, level='WARNING') as logs:
            self.assertTrue(stream._store_decoded_cap_record(record))
        self.assertIn('capSense3[0m', logs.output[0])
        self.assertNotIn('\n', logs.output[0])
        self.assertNotIn('\x1b', logs.output[0])

    def test_leaves_other_records_to_the_piezo_path(self):
        self.assertFalse(stream._store_decoded_cap_record(recent_piezo()))
        self.assertFalse(stream._store_decoded_cap_record(None))
        self.assertEqual(stream.piezo_record_queue.qsize(), 0)


class TestPresenceMode(CapPresenceTestCase):
    def _inputs(self, enabled=True, profiles=None):
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=enabled), \
                unittest.mock.patch.object(stream.calibration, 'load_presence_profiles',
                                           return_value=profiles or cap_profiles()):
            return stream._presence_v2_inputs()

    def test_off_when_the_switch_is_off(self):
        self.latest.update(time.time(), [12.0] * 8, [12.0] * 8)
        self.assertIsNone(self._inputs(enabled=False))

    def test_off_until_capsense2_records_arrive(self):
        self.assertIsNone(self._inputs())
        self.latest.update(time.time() - 120, [12.0] * 8, [12.0] * 8)
        self.assertIsNone(self._inputs())

    def test_off_without_a_capacitance_baseline(self):
        self.latest.update(time.time(), [12.0] * 8, [12.0] * 8)
        profiles = cap_profiles()
        profiles['right']['cap'] = None
        self.assertIsNone(self._inputs(profiles=profiles))

    def test_unknown_or_mismatched_provenance_keeps_live_presence_on_piezo(self):
        self.latest.update(time.time(), [12.0] * 8, [12.0] * 8)
        for provenance in (None, {'format': 'capSense', 'normalizationVersion': 1},
                           {'format': 'capSense2', 'normalizationVersion': 99}):
            profiles = cap_profiles()
            for side in ('left', 'right'):
                profiles[side]['cap']['provenance'] = provenance
            self.assertIsNone(self._inputs(profiles=profiles))

    def test_on_with_the_switch_fresh_readings_and_a_baseline(self):
        self.latest.update(time.time(), [12.0] * 8, [12.0] * 8)
        params, baselines = self._inputs()
        self.assertEqual(params.left.enter_delta, 4.0)
        self.assertEqual(baselines['left'].mean, (11.0, 11.0, 11.0))

    def _legacy_inputs(self, profiles, cadence_ok=True):
        self.latest.update(time.time(), (500.0, 500.0, 500.0), (500.0, 500.0, 500.0), CAPSENSE)
        processor = unittest.mock.Mock()
        processor.cadence.ok.return_value = cadence_ok
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=True), \
                unittest.mock.patch.object(stream.calibration, 'load_presence_profiles', return_value=profiles):
            return stream._presence_v2_inputs(processor)

    def test_an_unchecked_format_waits_for_learned_levels(self):
        with self.assertLogs(stream.logger, level='INFO') as logs:
            self.assertIsNone(self._legacy_inputs(cap_profiles(CAPSENSE)))
            self.assertIsNone(self._legacy_inputs(cap_profiles(CAPSENSE)))
        self.assertEqual(len(logs.output), 1)
        self.assertIn('learned', logs.output[0])
        self.assertIn('the vibration sensor keeps deciding who is in bed, and the legacy estimators keep taking vitals',
                      logs.output[0])

    def test_an_unchecked_format_waits_for_records_once_a_second(self):
        profiles = cap_profiles(CAPSENSE)
        for side in ('left', 'right'):
            profiles[side]['cap_occupied'] = {'level': 900.0, 'provenance': {'format': 'capSense', 'normalizationVersion': 1}}
        self.assertIsNone(self._legacy_inputs(profiles, cadence_ok=None))
        self.assertIsNone(self._legacy_inputs(profiles, cadence_ok=False))

    def test_an_unchecked_format_runs_with_its_units_once_ready(self):
        profiles = cap_profiles(CAPSENSE)
        for side in ('left', 'right'):
            profiles[side]['cap_occupied'] = {'level': 900.0, 'provenance': {'format': 'capSense', 'normalizationVersion': 1}}
        params, baselines, cap_format = self._legacy_inputs(profiles)
        self.assertIs(cap_format, CAPSENSE)
        self.assertAlmostEqual(params.left.enter_delta, 360.0)
        self.assertEqual(params.left.offset_limit, 225.0)

    def _capsense2_inputs(self, pod5, profiles=None, cadence_ok=True):
        self.latest.update(time.time(), (12.0, 12.0, 12.0), (12.0, 12.0, 12.0))
        processor = unittest.mock.Mock()
        processor.cadence.ok.return_value = cadence_ok
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=True), \
                unittest.mock.patch.object(stream.calibration, 'load_presence_profiles',
                                           return_value=profiles or cap_profiles()), \
                unittest.mock.patch.object(model, 'is_pod5', return_value=pod5), \
                unittest.mock.patch.object(model, '_unknown_logged', False):
            return stream._presence_v2_inputs(processor)

    def test_capsense2_on_a_pod_5_runs_as_checked(self):
        params, baselines = self._capsense2_inputs(True)
        self.assertEqual(params.left.enter_delta, 4.0)

    def test_capsense2_on_another_pod_waits_like_an_unchecked_format(self):
        with self.assertLogs(stream.logger, level='INFO') as logs:
            self.assertIsNone(self._capsense2_inputs(False))
        self.assertIn('With capSense2 capacitance,', logs.output[0])
        profiles = cap_profiles()
        for side in ('left', 'right'):
            profiles[side]['cap_occupied'] = {'level': 20.0, 'provenance': {'format': 'capSense2', 'normalizationVersion': 1}}
        self.assertIsNone(self._capsense2_inputs(False, profiles, cadence_ok=False))
        params, baselines, cap_format = self._capsense2_inputs(False, profiles)
        self.assertEqual(cap_format.name, 'capSense2')
        self.assertFalse(cap_format.validated)
        self.assertEqual(params.left.enter_delta, 8.0)
        self.assertEqual(baselines['left'].mean, (11.0, 11.0, 11.0))

    def test_capsense2_on_an_unknown_model_runs_as_before_and_says_so(self):
        with self.assertLogs(stream.logger, level='INFO') as logs:
            params, baselines = self._capsense2_inputs(None)
        self.assertEqual(params.left.enter_delta, 4.0)
        self.assertIn('Could not read the Pod model', logs.output[0])

    def test_the_refresh_passes_the_processor(self):
        processor = unittest.mock.Mock()
        with unittest.mock.patch.object(stream, '_presence_v2_inputs', return_value=None) as inputs:
            stream._refresh_presence_mode(processor)
        inputs.assert_called_once_with(processor)

    def test_a_failed_read_keeps_the_current_mode(self):
        processor = unittest.mock.Mock()
        with unittest.mock.patch.object(stream, '_presence_v2_inputs', side_effect=RuntimeError('database is locked')):
            stream._refresh_presence_mode(processor)
        processor.use_presence_v2.assert_not_called()

    def test_a_definite_answer_is_applied(self):
        processor = unittest.mock.Mock()
        inputs = (object(), {})
        with unittest.mock.patch.object(stream, '_presence_v2_inputs', side_effect=[inputs, None]):
            stream._refresh_presence_mode(processor)
            stream._refresh_presence_mode(processor)
        self.assertEqual([call.args[0] for call in processor.use_presence_v2.call_args_list], [inputs, None])

    def test_a_failure_while_switching_keeps_the_current_mode(self):
        processor = unittest.mock.Mock()
        processor.use_presence_v2.side_effect = RuntimeError('boom')
        with unittest.mock.patch.object(stream, '_presence_v2_inputs', return_value=None):
            stream._refresh_presence_mode(processor)
        processor.use_presence_v2.assert_called_once_with(None)


class TestStalePresenceHandBack(CapPresenceTestCase):
    def _processor(self, v2=True):
        processor = unittest.mock.Mock()
        processor.presence = object() if v2 else None
        return processor

    def test_hands_back_to_piezo_as_soon_as_capsense2_stops(self):
        self.latest.update(time.time() - stream.CAP_FRESH_SECONDS - 5, [12.0] * 8, [12.0] * 8)
        processor = self._processor()
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', side_effect=AssertionError('read per record')):
            stream._drop_stale_presence_v2(processor)
        processor.use_presence_v2.assert_called_once_with(None)

    def test_keeps_the_capacitance_detector_while_readings_arrive(self):
        self.latest.update(time.time(), [12.0] * 8, [12.0] * 8)
        processor = self._processor()
        stream._drop_stale_presence_v2(processor)
        processor.use_presence_v2.assert_not_called()

    def test_leaves_piezo_presence_alone(self):
        processor = self._processor(v2=False)
        stream._drop_stale_presence_v2(processor)
        processor.use_presence_v2.assert_not_called()

    def test_a_failed_hand_back_is_logged_not_raised(self):
        processor = self._processor()
        processor.use_presence_v2.side_effect = RuntimeError('boom')
        self.latest.update(time.time() - stream.CAP_FRESH_SECONDS - 5, [12.0] * 8, [12.0] * 8)
        stream._drop_stale_presence_v2(processor)
        processor.use_presence_v2.assert_called_once_with(None)


class TestUncheckedFormatRunning(CapPresenceTestCase):
    """The stream's own hand-back and refresh while an unchecked format drives vitals."""

    def setUp(self):
        super().setUp()
        self.latest.update(time.time(), (500.0, 500.0, 500.0), (500.0, 500.0, 500.0), CAPSENSE)
        self.processor = stream.StreamProcessor(recent_piezo(), cap_source=self.latest)
        self.piezo = (self.processor.left_processor, self.processor.right_processor)
        self.profiles = cap_profiles(CAPSENSE)
        for side in ('left', 'right'):
            self.profiles[side]['cap_occupied'] = {'level': 900.0, 'provenance': {'format': 'capSense', 'normalizationVersion': 1}}
        self.enabled = unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=True)
        self.enabled.start()
        self.addCleanup(self.enabled.stop)
        self.cadence = unittest.mock.patch.object(self.processor.cadence, 'ok', return_value=True)
        self.cadence.start()
        self.addCleanup(self.cadence.stop)
        self.read = unittest.mock.patch.object(stream.calibration, 'load_presence_profiles',
                                               side_effect=lambda: self.profiles)
        self.read.start()
        self.addCleanup(self.read.stop)

    def _refresh(self):
        stream._refresh_presence_mode(self.processor)

    def test_the_refresh_starts_it_and_leaves_it_running(self):
        self._refresh()
        detector = self.processor.presence
        self.assertIsNotNone(detector)
        self.assertEqual(self.processor._piezo_presence, self.piezo)
        self._refresh()
        self.assertIs(self.processor.presence, detector)
        self.assertEqual(self.processor._piezo_presence, self.piezo)

    def test_stale_capacitance_hands_vitals_back_to_the_piezo_detector(self):
        self._refresh()
        self.latest.update(time.time() - stream.CAP_FRESH_SECONDS - 5, (500.0, 500.0, 500.0), (500.0, 500.0, 500.0), CAPSENSE)
        stream._drop_stale_presence_v2(self.processor)
        self.assertIsNone(self.processor.presence)
        self.assertIsNone(self.processor._piezo_presence)
        self.assertEqual((self.processor.left_processor, self.processor.right_processor), self.piezo)

    def test_fresh_capacitance_is_left_running(self):
        self._refresh()
        detector = self.processor.presence
        stream._drop_stale_presence_v2(self.processor)
        self.assertIs(self.processor.presence, detector)

    def test_the_refresh_hands_back_when_the_levels_go_away(self):
        self._refresh()
        for side in ('left', 'right'):
            self.profiles[side]['cap_occupied'] = None
        self._refresh()
        self.assertIsNone(self.processor.presence)
        self.assertEqual((self.processor.left_processor, self.processor.right_processor), self.piezo)

    def test_the_refresh_hands_back_when_piezo_stops_coming_once_a_second(self):
        self._refresh()
        with unittest.mock.patch.object(self.processor.cadence, 'ok', return_value=False):
            self._refresh()
        self.assertIsNone(self.processor.presence)
        self.assertEqual((self.processor.left_processor, self.processor.right_processor), self.piezo)

    def test_the_refresh_does_not_restart_inputs_the_guard_declined(self):
        self._refresh()
        declined = self.processor._presence_inputs
        self.processor.use_presence_v2(None)
        self.processor._declined_inputs = declined
        self._refresh()
        self.assertIsNone(self.processor.presence)
        self.assertEqual((self.processor.left_processor, self.processor.right_processor), self.piezo)

    def test_the_refresh_takes_new_levels_into_a_running_detector(self):
        self._refresh()
        detector = self.processor.presence
        self.profiles['right']['cap_occupied'] = {'level': 600.0, 'provenance': {'format': 'capSense', 'normalizationVersion': 1}}
        self._refresh()
        self.assertIsNot(self.processor.presence, detector)
        self.assertEqual(self.processor._piezo_presence, self.piezo)


class TestProcessBiometricsLoop(CapPresenceTestCase):
    def test_refreshes_the_mode_at_start_and_every_minute_and_checks_freshness_per_record(self):
        for _ in range(71):
            stream.piezo_record_queue.put(recent_piezo())
        stream.piezo_record_queue.put(None)
        processor = unittest.mock.Mock()
        with unittest.mock.patch.object(stream, 'StreamProcessor', return_value=processor) as build, \
                unittest.mock.patch.object(stream, 'update_health'), \
                unittest.mock.patch.object(stream, '_refresh_presence_mode') as refresh, \
                unittest.mock.patch.object(stream, '_drop_stale_presence_v2') as drop_stale:
            stream.process_biometrics()
        self.assertIs(build.call_args.kwargs['cap_source'], self.latest)
        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(drop_stale.call_count, 70)
        self.assertEqual(processor.process_piezo_record.call_count, 70)

    def test_refreshes_the_vitals_path_with_the_presence_mode_and_shares_the_pump(self):
        for _ in range(71):
            stream.piezo_record_queue.put(recent_piezo())
        stream.piezo_record_queue.put(None)
        processor = unittest.mock.Mock()
        with unittest.mock.patch.object(stream, 'StreamProcessor', return_value=processor) as build, \
                unittest.mock.patch.object(stream, 'update_health'), \
                unittest.mock.patch.object(stream, '_refresh_presence_mode'), \
                unittest.mock.patch.object(stream, '_refresh_vitals_mode') as refresh, \
                unittest.mock.patch.object(stream, '_drop_stale_presence_v2'):
            stream.process_biometrics()
        self.assertIs(build.call_args.kwargs['pump'], stream.pump_speed)
        self.assertEqual(refresh.call_count, 2)
        refresh.assert_called_with(processor)

    def test_a_failing_mode_switch_does_not_stop_processing(self):
        for _ in range(71):
            stream.piezo_record_queue.put(recent_piezo())
        stream.piezo_record_queue.put(None)
        processor = unittest.mock.Mock()
        processor.presence = None
        processor.use_presence_v2.side_effect = RuntimeError('boom')
        with unittest.mock.patch.object(stream, 'StreamProcessor', return_value=processor), \
                unittest.mock.patch.object(stream, 'update_health'), \
                unittest.mock.patch.object(stream, '_presence_v2_inputs', return_value=(object(), {})):
            stream.process_biometrics()
        self.assertEqual(processor.process_piezo_record.call_count, 70)
        self.assertEqual(processor.use_presence_v2.call_count, 2)


class TestVitalsMode(unittest.TestCase):
    def test_the_refresh_follows_the_switch(self):
        processor = unittest.mock.Mock()
        for enabled in (True, False):
            with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=enabled):
                stream._refresh_vitals_mode(processor)
            processor.use_vitals_v2.assert_called_with(enabled)

    def test_a_failed_switch_keeps_the_current_path(self):
        processor = unittest.mock.Mock()
        processor.use_vitals_v2.side_effect = RuntimeError('boom')
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=True), \
                unittest.mock.patch.object(stream, '_vitals_switch_failed', False), \
                self.assertLogs(stream.logger, 'ERROR'):
            stream._refresh_vitals_mode(processor)

    def test_a_switch_that_keeps_failing_is_reported_once(self):
        processor = unittest.mock.Mock()
        processor.use_vitals_v2.side_effect = ImportError('no module')
        with unittest.mock.patch.object(stream, 'biometrics_v2_enabled', return_value=True), \
                unittest.mock.patch.object(stream, '_vitals_switch_failed', False), \
                self.assertLogs(stream.logger, 'DEBUG') as logs:
            for _ in range(3):
                stream._refresh_vitals_mode(processor)
        self.assertEqual([record.levelname for record in logs.records], ['ERROR', 'DEBUG', 'DEBUG'])
        self.assertEqual(processor.use_vitals_v2.call_count, 3)


def pump_frame(rpm=3000):
    return {'type': 'frzHealth', 'ts': time.time(), 'left': {'pump': {'rpm': rpm}}, 'right': {'pump': {'rpm': 1950}}}


class TestPumpSpeedFeed(StreamHelpersTestCase):
    """Both readers hand every frzHealth frame to the shared pump speed as well as to pump health."""

    def setUp(self):
        super().setUp()
        self.pump = stream.PumpSpeed()
        pump = unittest.mock.patch.object(stream, 'pump_speed', self.pump)
        pump.start()
        self.addCleanup(pump.stop)
        health = unittest.mock.patch.object(stream, 'update_pump_health')
        self.health = health.start()
        self.addCleanup(health.stop)
        warned = unittest.mock.patch.object(stream, '_pump_frame_warned', False)
        warned.start()
        self.addCleanup(warned.stop)

    def follow(self, *frames):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with open(os.path.join(folder, 'a.RAW'), 'wb') as handle:
            for seq, frame in enumerate(frames):
                handle.write(cbor2.dumps({'seq': seq, 'data': cbor2.dumps(frame)}))
        handler = stream.LatestRawFileHandler(folder)
        handler.follow_latest_file()
        handler.latest_file_obj.close()
        return handler

    def assert_health_frame(self, frame, sequence):
        self.health.assert_called_once()
        decoded = self.health.call_args.args[0]
        self.assertEqual({key: value for key, value in decoded.items() if key not in ('_firmware', 'seq')}, frame)
        self.assertEqual(decoded['seq'], sequence)
        receipt = decoded['_firmware']['receivedAt']
        self.assertIsInstance(receipt, (int, float))
        self.assertGreaterEqual(receipt, frame['ts'])
        self.assertLessEqual(receipt, time.time())
        self.assertEqual(decoded['_firmware'], {'sequence': sequence, 'index': 0, 'receivedAt': receipt})

    def test_the_file_watcher_feeds_both(self):
        frame = pump_frame()
        self.follow(frame)
        self.assertTrue(self.pump.fed)
        self.assertEqual(self.pump.speed_during(frame['ts'], frame['ts'] + 1), 'fast')
        self.assert_health_frame(frame, 0)

    def test_a_frame_the_pump_speed_cannot_read_still_reaches_pump_health(self):
        broken = {'type': 'frzHealth', 'ts': time.time(), 'left': ['not', 'a', 'side']}
        handler = self.follow(broken, recent_piezo(seq=9))
        self.assert_health_frame(broken, 0)
        self.assertFalse(self.pump.fed)
        # The reader moved past both records.
        self.assertEqual(handler.last_pos, os.path.getsize(handler.latest_file))
        self.assertEqual(stream.piezo_record_queue.qsize(), 1)

    def test_an_unreadable_frame_is_reported_once(self):
        broken = {'type': 'frzHealth', 'ts': time.time(), 'left': ['not', 'a', 'side']}
        with self.assertLogs(stream.logger, 'WARNING') as logs:
            self.follow(broken, dict(broken, ts=broken['ts'] + 10))
        self.assertEqual(len(logs.records), 1)
        self.assertIn('pump speed', logs.records[0].getMessage())

    def test_the_nats_consumer_feeds_both(self):
        from test_live_nats import fake_client
        frame = pump_frame()
        modules, _, _, _, _, message = fake_client()
        message.data = cbor2.dumps({'seq': 1, 'data': cbor2.dumps(frame)})
        with unittest.mock.patch.dict(sys.modules, modules), \
                unittest.mock.patch.object(stream, 'update_health'):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(stream._nats_session(unittest.mock.Mock()))
        self.assertEqual(self.pump.speed_during(frame['ts'], frame['ts'] + 1), 'fast')
        self.assert_health_frame(frame, 1)
        message.ack.assert_not_called()


class TestStreamHealth(unittest.TestCase):
    def test_reports_healthy_while_the_processing_thread_runs(self):
        thread = unittest.mock.Mock()
        thread.is_alive.return_value = True
        with unittest.mock.patch.object(stream, 'update_health') as update, \
                unittest.mock.patch.object(stream, '_last_sensor_record', time.monotonic()):
            self.assertTrue(stream._report_stream_health(thread))
        update.assert_called_once_with('stream', 'healthy', '')

    def test_reports_failed_once_the_processing_thread_has_died(self):
        thread = unittest.mock.Mock()
        thread.is_alive.return_value = False
        with unittest.mock.patch.object(stream, 'update_health') as update:
            self.assertFalse(stream._report_stream_health(thread))
        self.assertEqual(update.call_args.args[:2], ('stream', 'failed'))


class TestDeadProcessingThread(unittest.TestCase):
    class Runaway(Exception):
        pass

    def test_the_nats_loop_ends_so_the_file_watcher_can_take_over(self):
        fetches = []
        stream.piezo_record_queue.put(recent_piezo())
        self.addCleanup(lambda: [stream.piezo_record_queue.get_nowait() for _ in range(stream.piezo_record_queue.qsize())])
        with unittest.mock.patch.dict(sys.modules, {'nats': types.SimpleNamespace()}), \
                unittest.mock.patch.object(stream, '_nats_session', side_effect=RuntimeError('disconnected')), \
                unittest.mock.patch.object(stream, 'process_biometrics', lambda stop_event=None: None), \
                unittest.mock.patch.object(stream, 'update_health') as update, \
                unittest.mock.patch.object(stream, 'STREAM_HEALTH_INTERVAL_SECONDS', 0):
            with self.assertRaises(RuntimeError):
                asyncio.run(stream.watch_nats_stream())
        self.assertLess(len(fetches), 20)
        self.assertTrue(stream.piezo_record_queue.empty())
        self.assertEqual(update.call_args_list[-1].args[:2], ('stream', 'failed'))

    def test_a_dead_thread_sends_the_stream_to_the_file_watcher(self):
        with unittest.mock.patch.object(stream, 'watch_nats_stream', side_effect=RuntimeError('processing thread stopped')), \
                unittest.mock.patch.object(stream, 'watch_directory') as watch:
            stream.watch_stream()
        watch.assert_called_once_with('/persistent')


class TestRawFileRecovery(StreamHelpersTestCase):
    def _ingested(self):
        # The decoder adds envelope metadata; the recovery tests compare sensor fields.
        return [{key: value for key, value in call.args[0].items() if key != '_firmware'}
                for call in self.ingest.call_args_list]

    def setUp(self):
        super().setUp()
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        self.path = os.path.join(self.folder, 'a.RAW')
        self.frames = [recent_piezo(seq=sequence) for sequence in (1, 2)]
        self.records = [cbor2.dumps({'seq': sequence, 'data': cbor2.dumps(frame)})
                        for sequence, frame in enumerate(self.frames)]
        patcher = unittest.mock.patch.object(stream, '_ingest_live_record')
        self.ingest = patcher.start()
        self.addCleanup(patcher.stop)

    def handler(self, fixture):
        with open(self.path, 'wb') as handle:
            handle.write(fixture)
        handler = stream.LatestRawFileHandler(self.folder)
        self.addCleanup(lambda: handler.latest_file_obj.close())
        return handler

    def test_reads_the_rest_of_a_file_before_following_the_next(self):
        handler = self.handler(self.records[0])
        handler.follow_latest_file()
        with open(self.path, 'ab') as handle:
            handle.write(self.records[1])
        third = recent_piezo(seq=3)
        newer = os.path.join(self.folder, 'b.RAW')
        with open(newer, 'wb') as handle:
            handle.write(cbor2.dumps({'seq': 2, 'data': cbor2.dumps(third)}))
        later = time.time() + 5
        os.utime(newer, (later, later))
        handler.track_latest_file()
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames + [third])

    def test_resyncs_corrupt_middle_header_and_logs_skipped_bytes(self):
        corrupt = b'\xa2\x63bad header'
        fixture = self.records[0] + corrupt + self.records[1]
        handler = self.handler(fixture)
        with self.assertLogs(stream.logger, 'WARNING') as logs:
            handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames)
        self.assertEqual(handler.last_pos, len(fixture))
        self.assertTrue(any('Skipped %d bytes' % len(corrupt) in entry for entry in logs.output))

    def test_resyncs_invalid_inner_cbor(self):
        corrupt = cbor2.dumps({'seq': 7, 'data': b'\x1c'})
        handler = self.handler(self.records[0] + corrupt + self.records[1])
        handler.follow_latest_file()
        self.assertEqual(self.ingest.call_count, 2)

    def test_skips_invalid_decimal_payload_and_advances_the_follower(self):
        corrupt = cbor2.dumps({'seq': 7, 'data': bytes.fromhex('c4 82 1b 7f ff ff ff ff ff ff ff 01')})
        for gap in (b'', b'broken'):
            with self.subTest(gap=gap):
                self.ingest.reset_mock()
                fixture = self.records[0] + gap + corrupt + self.records[1]
                handler = self.handler(fixture)
                handler.follow_latest_file()
                handler.follow_latest_file()
                self.assertEqual(self._ingested(), self.frames)
                self.assertEqual(handler.last_pos, len(fixture))

    def test_resyncs_to_a_complete_empty_sequence_marker(self):
        marker = cbor2.dumps({'seq': 7, 'data': b''})
        fixture = self.records[0] + b'broken' + marker
        handler = self.handler(fixture)
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, len(fixture))
        self.assertEqual(self.ingest.call_count, 1)
        with open(self.path, 'ab') as handle:
            handle.write(self.records[1])
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames)

    def test_rejects_false_matches_and_finds_a_header_across_the_scan_boundary(self):
        false = cbor2.dumps({'seq': 7, 'data': cbor2.dumps(['not a record'])})
        corrupt = b'broken' + false + b'x' * (65535 - len(false) - len(b'broken'))
        wide = cbor2.dumps({'seq': 0x12345678, 'data': cbor2.dumps(self.frames[1])})
        handler = self.handler(self.records[0] + corrupt + wide)
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames)
        self.assertEqual(handler.last_pos, len(self.records[0] + corrupt + wide))

    def test_does_not_skip_a_corrupt_live_tail_to_an_incomplete_later_header(self):
        handler = self.handler(self.records[0] + b'broken' + self.records[1][:-3])
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, len(self.records[0]))
        with open(self.path, 'ab') as handle:
            handle.write(self.records[1][-3:])
        handler.follow_latest_file()
        self.assertEqual(self.ingest.call_count, 2)

    def test_resyncs_a_broken_length_that_reads_past_the_next_record(self):
        corrupt = b'\xa2\x63seq\x01\x64data\x59\xff\xffbroken'
        handler = self.handler(self.records[0] + corrupt + self.records[1])
        handler.follow_latest_file()
        self.assertEqual(self.ingest.call_count, 2)

    def test_resyncs_when_a_wrong_length_swallows_the_next_record(self):
        inner = cbor2.dumps(self.frames[0])
        corrupt = cbor2.dumps({'seq': 7, 'data': inner + self.records[1]})
        handler = self.handler(self.records[0] + corrupt)
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames)

    def test_keeps_partial_live_tail_and_reads_it_after_append(self):
        fixture = self.records[0] + self.records[1][:-4]
        handler = self.handler(fixture)
        handler.follow_latest_file()
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, len(self.records[0]))
        self.assertEqual(self.ingest.call_count, 1)
        with open(self.path, 'ab') as handle:
            handle.write(self.records[1][-4:])
        handler.follow_latest_file()
        self.assertEqual(self.ingest.call_count, 2)
        self.assertEqual(handler.last_pos, sum(map(len, self.records)))

    def test_waits_for_a_partial_record_that_completes_during_the_resync(self):
        third = recent_piezo(seq=3)
        records = self.records + [cbor2.dumps({'seq': 2, 'data': cbor2.dumps(third)})]
        handler = self.handler(records[0] + records[1][:-3])
        real_read = stream._read_raw_record

        grown = []

        def read_then_grow(handle, **kwargs):
            try:
                return real_read(handle, **kwargs)
            except EOFError:
                if grown:
                    raise
                grown.append(True)
                # The Pod finishes the record and writes the next one before the resync scan.
                with open(self.path, 'ab') as grow:
                    grow.write(records[1][-3:] + records[2])
                raise

        with unittest.mock.patch.object(stream, '_read_raw_record', side_effect=read_then_grow):
            handler.follow_latest_file()
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames + [third])

    def test_keeps_live_tail_even_when_it_contains_an_invalid_header_match(self):
        tail = b'bad\xa2\x63seq\x01\x64data\x41\xff'
        handler = self.handler(self.records[0] + tail)
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, len(self.records[0]))
        self.assertEqual(self.ingest.call_count, 1)

    def test_switches_to_a_newer_file_after_a_partial_tail(self):
        handler = self.handler(self.records[0] + self.records[1][:-4])
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, len(self.records[0]))
        newer = os.path.join(self.folder, 'b.RAW')
        with open(newer, 'wb') as handle:
            handle.write(self.records[1])
        later = os.path.getmtime(self.path) + 1
        os.utime(newer, (later, later))
        handler.on_created(types.SimpleNamespace(is_directory=False, src_path=newer))
        handler.follow_latest_file()
        self.assertEqual(self._ingested(), self.frames)
        self.assertEqual(handler.latest_file, newer)
        self.assertEqual(handler.last_pos, len(self.records[1]))

    def test_a_processing_failure_does_not_resync_past_a_decoded_record(self):
        handler = self.handler(b''.join(self.records))
        self.ingest.side_effect = RuntimeError('processor failed')
        handler.follow_latest_file()
        self.assertEqual(handler.last_pos, 0)
        self.assertEqual(self.ingest.call_count, 1)


class TestRawFileCapRecords(CapPresenceTestCase):
    def test_the_file_watcher_stores_capsense2_and_queues_piezo(self):
        cap = recent_cap()
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        with open(os.path.join(folder, 'a.RAW'), 'wb') as handle:
            handle.write(cbor2.dumps({'seq': 1, 'data': cbor2.dumps(cap)}))
            handle.write(cbor2.dumps({'seq': 2, 'data': cbor2.dumps(recent_piezo(seq=2))}))
        handler = stream.LatestRawFileHandler(folder)
        handler.follow_latest_file()
        handler.latest_file_obj.close()
        self.assertEqual(self.latest.read()[0], int(cap['ts']))
        self.assertEqual(stream.piezo_record_queue.qsize(), 1)


class TestFirmwareIngestIsolation(CapPresenceTestCase):
    def test_delivery_failure_preserves_sensor_ingestion_and_limits_warnings(self):
        cap = recent_cap()
        with unittest.mock.patch.object(stream, '_firmware_ingest_warning_at', None), \
                unittest.mock.patch.object(stream.firmware_delivery, 'ingest', side_effect=RuntimeError('bad telemetry')), \
                unittest.mock.patch.object(stream.time, 'monotonic', return_value=100) as clock, \
                self.assertLogs(stream.logger, 'WARNING') as logs:
            self.assertTrue(stream._ingest_live_record(cap))
            self.assertTrue(stream._ingest_live_record(recent_piezo(seq=30)))
            clock.return_value = 161
            self.assertTrue(stream._ingest_live_record(recent_piezo(seq=31)))
        self.assertEqual(self.latest.read()[0], int(cap['ts']))
        self.assertEqual(stream.piezo_record_queue.qsize(), 2)
        self.assertEqual(len(logs.records), 2)
        self.assertTrue(all('firmware telemetry' in record.getMessage() for record in logs.records))


if __name__ == "__main__":
    unittest.main()
