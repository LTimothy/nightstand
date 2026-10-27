"""Synthetic firmware telemetry, including unverified diagnostic shapes."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from firmware_telemetry import FirmwareDelivery, normalize_record, number


class FirmwareTelemetryTest(unittest.TestCase):
    def test_huge_integers_and_invalid_numeric_types_are_ignored(self):
        class InvalidNumber(int):
            def __float__(self):
                raise TypeError('invalid conversion')

        for value in (2**1100, InvalidNumber(1)):
            with self.subTest(value_type=type(value)):
                self.assertIsNone(number(value))
                self.assertEqual(normalize_record({'type': 'log', 'ts': value}, 'RAW', 100), [])

    def test_thermostat_preserves_flags_and_celsius(self):
        row = {'type': 'frzTherm', 'ts': 100, 'left': {'target': 25.08, 'power': -0.1, 'valid': True, 'enabled': False}}
        records = normalize_record(row, 'RAW', 101)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['targetC'], 25.08)
        self.assertFalse(records[0]['enabled'])
        self.assertEqual(records[0]['timestamp'], 100)
        self.assertEqual(records[0]['receivedAt'], 101)

    def test_invalid_missing_and_nonfinite_fields(self):
        self.assertEqual(normalize_record({'type': 'frzTherm', 'ts': 100, 'left': 25}, 'RAW', 101), [])
        row = {'type': 'frzTherm', 'ts': 100, 'left': {'target': float('nan'), 'valid': True, 'enabled': True}}
        self.assertIsNone(normalize_record(row, 'RAW', 101)[0]['targetC'])
        for stamp in (True, float('nan'), 0, 102):
            self.assertEqual(normalize_record({**row, 'ts': stamp}, 'RAW', 101), [])


if __name__ == '__main__':
    unittest.main()


class ThermalNormalizationTest(unittest.TestCase):
    def test_measured_centidegrees_and_loop_temperature(self):
        water = normalize_record({'type': 'frzTemp', 'ts': 100, 'left': 2456, 'right': -32768}, 'RAW', 100)
        self.assertEqual(water[0]['waterC'], 24.56)
        self.assertIsNone(water[1]['waterC'])
        pump = normalize_record({'type': 'frzHealth', 'ts': 100,
            'left': {'pump': {'rpm': 200, 'water': True}, 'temps': {'flowrate': 25}}}, 'RAW', 100)[0]
        self.assertEqual((pump['rpm'], pump['water'], pump['loopC']), (200, True, 25))


class RecordIdentityTest(unittest.TestCase):
    def test_preserves_large_envelope_sequence_and_receipt(self):
        row = {'type': 'frzTherm', 'ts': 100, 'left': {'target': 25, 'power': -0.1, 'valid': True, 'enabled': True},
               '_firmware': {'sequence': 2**64 - 1, 'index': 12, 'receivedAt': 101}}
        event = normalize_record(row, 'RAW', 102)[0]
        self.assertEqual(event['sequence'], '18446744073709551615')
        self.assertEqual(event['index'], 12)
        self.assertEqual(event['receivedAt'], 101)


class DeliveryBoundsTest(unittest.TestCase):
    def delivery(self, flags):
        delivery = FirmwareDelivery()
        delivery.flags = flags
        delivery.refresh_at = float('inf')
        delivery.started = True  # Exercise queueing without a transport thread.
        return delivery

    def test_disabled_flags_do_not_queue_work(self):
        delivery = self.delivery({})
        delivery.ingest({'type': 'log', 'ts': 100, 'msg': 'FS_WRITE_FAIL: 1'}, 'RAW', 100)
        self.assertTrue(delivery.pending.empty())

    def test_queue_is_bounded_and_counter_warnings_wake_delivery(self):
        delivery = self.delivery({'firmwareHealth': True})
        for timestamp in range(100, 500):
            delivery.ingest({'type': 'log', 'ts': timestamp, 'msg': 'FS_WRITE_FAIL: 1'}, 'RAW', timestamp)
        self.assertEqual(delivery.pending.qsize(), 256)
        self.assertEqual(delivery.pending.get_nowait()['timestamp'], 244)
        self.assertTrue(delivery.wake.is_set())

    def test_button_taps_queue_without_tap_diagnostics_and_wake_delivery(self):
        delivery = self.delivery({})
        delivery.ingest({'type': 'buttonEvent', 'ts': 100, 'right': {'top': 2}}, 'RAW', 100)
        self.assertEqual(delivery.pending.qsize(), 1)
        self.assertEqual(delivery.pending.get_nowait()['count'], 2)
        self.assertTrue(delivery.wake.is_set())

    def test_other_taps_still_need_tap_diagnostics(self):
        delivery = self.delivery({})
        delivery.ingest({'type': 'tap-gesture', 'ts': 100, 'side': 'left', 'taps': 3}, 'RAW', 100)
        self.assertTrue(delivery.pending.empty())

    def test_each_kind_requires_its_own_flag(self):
        delivery = self.delivery({'tapDiagnostics': True})
        delivery.ingest({'type': 'log', 'ts': 100, 'msg': 'FS_WRITE_FAIL: 1'}, 'RAW', 100)
        delivery.ingest({'type': 'frzTemp', 'ts': 100, 'left': 2500}, 'RAW', 100)
        delivery.ingest({'type': 'buttonEvent', 'ts': 100, 'right': {'top': 1}}, 'RAW', 100)
        self.assertEqual(delivery.pending.qsize(), 1)
        self.assertEqual(delivery.pending.get_nowait()['kind'], 'tap')
