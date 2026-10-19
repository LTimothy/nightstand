"""Each piezo record concatenates each sensor-2 window once."""
import os
import sys
import unittest
import unittest.mock

import numpy as np

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
import stream_fixture  # noqa: F401,E402  (sets up paths, loggers and the db stub)
import stream_processor  # noqa: E402


def _record(ts):
    samples = np.zeros(500, dtype=np.int32)
    return {'type': 'piezo-dual', 'ts': ts, 'freq': 500, 'adc': 65, 'gain': 400,
            'left1': samples, 'left2': samples, 'right1': samples, 'right2': samples, 'seq': ts}


class TestSensorTwoSignals(unittest.TestCase):
    def test_builds_each_sensor_two_window_once_per_record(self):
        processor = stream_processor.StreamProcessor(_record(stream_fixture.START))
        processor.iteration_count = processor.left_processor.heart_rate_window_seconds + 1
        for side in (processor.left_processor, processor.right_processor):
            side.present_for = side.heart_rate_window_seconds + 1
            side.calculate_heart_rate = unittest.mock.Mock()
        with unittest.mock.patch.object(processor, 'check_presence'), \
                unittest.mock.patch.object(processor, '_use_vitals2', return_value=False), \
                unittest.mock.patch.object(processor, 'can_calculate_breath_rate', return_value=False), \
                unittest.mock.patch.object(processor, 'can_calculate_hrv', return_value=False), \
                unittest.mock.patch.object(processor.buffer, 'get_heart_rate_signal',
                                           wraps=processor.buffer.get_heart_rate_signal) as signal:
            processor.process_piezo_record(_record(stream_fixture.START + 1))
        sensor_two = [call for call in signal.call_args_list if call.args[1] == 2]
        self.assertEqual(len(sensor_two), 2)
        processor.left_processor.calculate_heart_rate.assert_called_once()
        processor.right_processor.calculate_heart_rate.assert_called_once()


if __name__ == '__main__':
    unittest.main()
