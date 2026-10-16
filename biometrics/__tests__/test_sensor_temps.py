"""Tests for sensor-temp forwarding (service_health.update_sensor_temps).

Root cause: both stream ingest paths can replay old frzTemp records (the
RAW-file fallback re-reads the current file from byte 0 on startup; the
durable NATS consumer replays its acked backlog after a restart), and
update_sensor_temps posted them without checking the record's own `ts`.
The 30s wall-clock throttle then posted the oldest record of each window
and suppressed the fresher ones behind it, so the API replayed the old
temperature history instead of the live readings.
"""
import json
import time
import unittest
from datetime import datetime, timezone

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import logging
import get_logger as _gl

_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()

from get_logger import get_logger, LOGGER_NAMES

for _name in LOGGER_NAMES:
    get_logger(_name)

import service_health


def _frz_temp(ts, hs=1450, amb=2168, left=1975, right=1981):
    return {'type': 'frzTemp', 'ts': ts, 'amb': amb, 'hs': hs, 'left': left, 'right': right, 'seq': 1}


class TestUpdateSensorTemps(unittest.TestCase):
    def setUp(self):
        # Reset the throttle and capture POSTs instead of hitting the network.
        service_health._last_sensor_temps_update = 0
        self.posts = []
        self.timeouts = []
        self._orig_urlopen = service_health.urllib.request.urlopen

        test = self

        class _FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(req, timeout=None):
            test.posts.append(json.loads(req.data.decode('utf-8')))
            test.timeouts.append(timeout)
            return _FakeResponse()

        service_health.urllib.request.urlopen = fake_urlopen

    def tearDown(self):
        service_health.urllib.request.urlopen = self._orig_urlopen

    def _posted_temps(self, index=-1):
        return self.posts[index]['biometrics']['sensorTemps']

    def test_fresh_record_posts_current_values(self):
        now = time.time()
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1450))
        self.assertEqual(len(self.posts), 1)
        temps = self._posted_temps()
        self.assertEqual(temps['heatsink'], 1450)
        self.assertEqual(temps['ambient'], 2168)

    def test_stale_record_is_dropped(self):
        # An hour-old record from a RAW-file or NATS backlog replay must not
        # overwrite the live reading.
        stale_ts = time.time() - 3600
        service_health.update_sensor_temps(_frz_temp(ts=stale_ts, hs=1900))
        self.assertEqual(self.posts, [])

    def test_stale_record_does_not_consume_throttle_window(self):
        # The original bug's worst mode: a stale record posted first and then
        # throttled out the live record behind it for 30s. Stale records must
        # be invisible to the throttle so the next live record posts at once.
        now = time.time()
        service_health.update_sensor_temps(_frz_temp(ts=now - 3600, hs=1900))
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1450))
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self._posted_temps()['heatsink'], 1450)

    def test_throttles_fresh_records_within_interval(self):
        now = time.time()
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1450))
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1460))
        self.assertEqual(len(self.posts), 1)

    def test_posts_again_after_interval_elapses(self):
        now = time.time()
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1450))
        # Age the throttle instead of sleeping.
        service_health._last_sensor_temps_update = now - service_health.SENSOR_TEMPS_UPDATE_INTERVAL - 1
        service_health.update_sensor_temps(_frz_temp(ts=now, hs=1460))
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self._posted_temps()['heatsink'], 1460)

    def test_last_updated_reflects_record_timestamp(self):
        # lastUpdated stamped with post time (rather than reading time) is
        # what hid the replay staleness from downstream consumers.
        record_ts = time.time() - 60
        service_health.update_sensor_temps(_frz_temp(ts=record_ts))
        posted = datetime.fromisoformat(self._posted_temps()['lastUpdated'])
        self.assertAlmostEqual(posted.timestamp(), record_ts, delta=1)

    def test_record_without_timestamp_is_treated_as_live(self):
        record = _frz_temp(ts=None)
        del record['ts']
        before = datetime.now(timezone.utc)
        service_health.update_sensor_temps(record)
        self.assertEqual(len(self.posts), 1)
        posted = datetime.fromisoformat(self._posted_temps()['lastUpdated'])
        self.assertGreaterEqual(posted, before)

    def test_gives_up_on_a_server_that_does_not_answer(self):
        service_health.update_sensor_temps(_frz_temp(ts=time.time()))
        self.assertEqual(self.timeouts, [5])

    def test_health_updates_give_up_too(self):
        service_health.update_health('stream', 'healthy')
        self.assertEqual(self.timeouts, [5])

    def test_string_timestamp_is_parsed_as_utc(self):
        # load_raw_files rewrites ts to a '%Y-%m-%d %H:%M:%S' UTC string;
        # a stale one must still be recognized as stale.
        stale = datetime.fromtimestamp(time.time() - 3600, timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        service_health.update_sensor_temps(_frz_temp(ts=stale))
        self.assertEqual(self.posts, [])
        fresh = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
        service_health.update_sensor_temps(_frz_temp(ts=fresh, hs=1450))
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self._posted_temps()['heatsink'], 1450)


if __name__ == '__main__':
    unittest.main()
