import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from firmware_health import classify_log


class HealthClassifierTest(unittest.TestCase):
    def test_allowlist_is_independent_of_firmware_level(self):
        cases = [('[condensation] temp: 24.6, humidity: 50, dew point: 12.3', 'moisture'),
                 ('[thermostat] tec[left] locked (pump)', 'pump-interlock'),
                 ('[thermostat] pump[right] slow 1900', 'pump-running'),
                 ('[thermostat] pump[left] off', 'pump-stopped'),
                 ('[cap_samplingL] status ok->too low', 'presence-low'),
                 ('[sensor] starting right reset', 'sensor-reset'),
                 ('[i2c1] timed out req 123', 'bus-timeout'),
                 ('failed to find USB device on port: 1-1.2', 'device-missing'),
                 ('Capwater not calibrated', 'water-calibration'),
                 ('FS_WRITE_FAIL: 0', 'write-failures'),
                 ('started throttling cooling [disabled]', 'throttling-disabled')]
        for message, code in cases:
            with self.subTest(message=message):
                self.assertEqual(classify_log(message)['code'], code)

    def test_unknown_faults_settings_and_optional_base_are_excluded(self):
        for message in ('missing base heartbeat', 'bad thermistor', '[no water]', 'target: 25',
                        'settings secret blob', 'FS_WRITE_FAIL: nan', 'x' * 2049):
            self.assertIsNone(classify_log(message))

    def test_side_and_bounded_numeric_details(self):
        self.assertEqual(classify_log('[cap_samplingR] status ok->too low')['side'], 'right')
        self.assertEqual(classify_log('[i2c12] timed out req 2')['details'], {'bus': 12})
        self.assertEqual(classify_log('FS_WRITE_FAIL: 0')['value'], 0)
        self.assertIsNone(classify_log('SENSOR_SAMPLES_DROPPED: 123'))

    def test_every_pump_speed_counts_as_running(self):
        for speed in ('slow', 'fast', 'default'):
            with self.subTest(speed=speed):
                result = classify_log(f'[frozen] -> FW: pump[left] {speed} @ 8.963509V 0.34')
                self.assertEqual((result['code'], result['side']), ('pump-running', 'left'))
        self.assertIsNone(classify_log('[frozen] -> FW: [pump-left] default=>8.000000'))


if __name__ == '__main__':
    unittest.main()


def test_capwater_keeps_only_numeric_readings_and_calibration_state():
    assert classify_log('[capwater] Raw: 0.056194, Capwater not calibrated') == {
        'side': None, 'code': 'water-calibration', 'details': {'raw': 0.056194, 'calibrated': False}}
    assert classify_log('[capwater] Raw: 1.141855, Capwater calibrated. Empty: 0.84, Full: 1.13') == {
        'side': None, 'code': 'water-calibrated',
        'details': {'raw': 1.141855, 'calibrated': True, 'empty': 0.84, 'full': 1.13}}
    assert classify_log('[capwater] Raw: nan, Capwater calibrated') is None
