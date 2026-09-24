"""Tests for the presence-entry run-up trace.

The periodic [presence-debug] snapshot is throttled to one line a minute,
which cannot show how a session began. Measured over eleven days of pod logs,
the live detector reports 23 to 30 presence sessions per side per day with
most of them under 20 minutes, while the offline analyzer sees one session per
side per night on the same hardware. Amplitude is not the explanation: in-bed
readings sit around 3 to 5 million against roughly 90 thousand on an empty
bed, so the two populations barely overlap.

That leaves the entry path, which the snapshot cannot see. This trace logs the
frames immediately before each entry so the run-up can be read directly rather
than guessed at.

Run locally (needs scipy/db stubbed, see below; the real dependencies only
exist on the pod):
    python3 -m unittest biometrics.__tests__.test_presence_entry_trace -v
"""
import unittest

import sys, os, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# heart.heartpy/heart.analysis pull in scipy at import time; db.py opens a
# real sqlite connection at import time. Neither is reachable from the local
# Mac and neither is touched by detect_presence, so stub both out. Keep this
# identical in shape to the sibling presence tests: whichever module imports
# first wins, so they must agree.
_scipy = types.ModuleType('scipy')
_scipy_interpolate = types.ModuleType('scipy.interpolate')
_scipy_signal = types.ModuleType('scipy.signal')
_scipy_interpolate.UnivariateSpline = object
for _fn in ('welch', 'periodogram', 'butter', 'filtfilt', 'iirnotch', 'savgol_filter'):
    setattr(_scipy_signal, _fn, lambda *a, **k: None)
_scipy.interpolate = _scipy_interpolate
_scipy.signal = _scipy_signal
sys.modules.setdefault('scipy', _scipy)
sys.modules.setdefault('scipy.interpolate', _scipy_interpolate)
sys.modules.setdefault('scipy.signal', _scipy_signal)

_db = types.ModuleType('db')
_db.insert_vitals = lambda *a, **k: None
sys.modules.setdefault('db', _db)

import logging
import get_logger as _gl
_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()
from get_logger import get_logger, LOGGER_NAMES

for _name in LOGGER_NAMES:
    get_logger(_name)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'stream'))
import numpy as np
import biometric_processor
from biometric_processor import BiometricProcessor, _PresenceCoordinator


def _signal(value, n=1000):
    """A signal array whose p98-p2 range is ~= value (see _range_p98_p2)."""
    arr = np.zeros(n, dtype=np.int64)
    arr[n // 2:] = value
    return arr


QUIET = _signal(0)
DOMINANT = _signal(300_000)


class TestPresenceEntryTrace(unittest.TestCase):
    def setUp(self):
        _PresenceCoordinator._latest = {'left': 0.0, 'right': 0.0}
        self.left = BiometricProcessor(side='left')
        self.right = BiometricProcessor(side='right')
        self.left._update_presence_api = lambda is_present: None
        self.right._update_presence_api = lambda is_present: None

    def _entry_lines(self, captured):
        return [r.getMessage() for r in captured.records
                if 'Presence entry on left side' in r.getMessage()]

    def test_entry_logs_the_frames_that_led_into_it(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            for _ in range(5):
                self.left.detect_presence(DOMINANT)
                self.right.detect_presence(QUIET)

        lines = self._entry_lines(captured)
        self.assertEqual(len(lines), 1)
        # 5 dominant frames, each marked own-side above noise, other side not,
        # dominant. The counter is its value entering the frame, so a clean
        # entry counts 0 through 4 and the gate opens on the fifth.
        self.assertIn('300000/S-D', lines[0])
        for n in range(5):
            self.assertIn(f'/{n}', lines[0])

    def test_quiet_frames_before_the_burst_are_kept(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            for _ in range(4):
                self.left.detect_presence(QUIET)
                self.right.detect_presence(QUIET)
            for _ in range(5):
                self.left.detect_presence(DOMINANT)
                self.right.detect_presence(QUIET)

        line = self._entry_lines(captured)[0]
        # The run-up must show the empty frames before the burst, which is the
        # whole point: a brief disturbance and a real settling-in look the same
        # at the moment of entry and different in the seconds before it.
        self.assertIn('0/---', line)
        self.assertEqual(line.count('300000'), 5)

    def test_no_entry_line_without_an_entry(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            # 4 dominant frames is one short of the entry gate.
            for _ in range(4):
                self.left.detect_presence(DOMINANT)
                self.right.detect_presence(QUIET)
            # keep the log non-empty so assertLogs has something to capture
            biometric_processor.logger.info('marker')

        self.assertFalse(self.left.present)
        self.assertEqual(self._entry_lines(captured), [])


class TestPresenceSettleTrace(unittest.TestCase):
    """The minute after an entry, logged once, so each entry labels itself.

    The run-up shows how an entry began but not whether anyone stayed. A
    person settles far above the noise bar; an empty side that spiked over it
    falls back to its floor within seconds, and a fresh session with no
    signal fast-exits after 30. Logging what follows the entry separates the
    two without keeping raw sensor files around.
    """

    def setUp(self):
        _PresenceCoordinator._latest = {'left': 0.0, 'right': 0.0}
        self.left = BiometricProcessor(side='left')
        self.right = BiometricProcessor(side='right')
        self.left._update_presence_api = lambda is_present: None
        self.right._update_presence_api = lambda is_present: None

    def _tick(self, left_signal, n=1):
        for _ in range(n):
            self.left.detect_presence(left_signal)
            self.right.detect_presence(QUIET)

    def _settle_lines(self, captured):
        return [r.getMessage() for r in captured.records
                if 'Presence settle on left side' in r.getMessage()]

    def test_a_person_who_stays_is_logged_once_at_sixty_seconds(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            self._tick(DOMINANT, 5)
            self.assertTrue(self.left.present)
            self._tick(DOMINANT, 60)

        lines = self._settle_lines(captured)
        self.assertEqual(len(lines), 1)
        self.assertIn('60s after entry:', lines[0])
        self.assertNotIn('exited', lines[0])
        self.assertIn('median 300000', lines[0])

    def test_an_entry_that_falls_back_is_flushed_when_presence_ends(self):
        # The spurious case: an entry, then nothing. The fresh session exits
        # before the minute is up, and the trace must not be lost with it.
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            self._tick(DOMINANT, 5)
            self._tick(QUIET, 59)

        self.assertFalse(self.left.present)
        lines = self._settle_lines(captured)
        self.assertEqual(len(lines), 1)
        self.assertIn('(exited)', lines[0])
        self.assertIn('median 0', lines[0])

    def test_nothing_is_logged_while_the_minute_is_still_running(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            self._tick(DOMINANT, 5)
            self._tick(DOMINANT, 30)
            biometric_processor.logger.info('marker')

        self.assertTrue(self.left.present)
        self.assertEqual(self._settle_lines(captured), [])

    def test_a_long_session_does_not_log_again_after_the_first_minute(self):
        with self.assertLogs(biometric_processor.logger, level='INFO') as captured:
            self._tick(DOMINANT, 5)
            self._tick(DOMINANT, 200)

        self.assertEqual(len(self._settle_lines(captured)), 1)


if __name__ == '__main__':
    unittest.main()
