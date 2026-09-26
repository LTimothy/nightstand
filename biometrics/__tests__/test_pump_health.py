"""Tests for pump-stall detection (service_health.update_pump_health).

Root cause: the hub water-temperature sensor sits next to the TEC
(heating/cooling element), not in the bed. If the pump stalls while the TEC
keeps drawing current, the sensor reads stagnant water next to a powered
heating element, a runaway number, not bed temperature. Reported by a
free-sleep user (side ran to 102F overnight against an 84F setpoint) and
documented independently by sleepypod/core's ADR 0022.

Run locally (needs cbor2, not part of the node CI):
    python3 -m pytest biometrics/__tests__/test_pump_health.py -v
(also runs under plain unittest: python3 -m unittest discover ...)
"""
import unittest

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import logging
import get_logger as _gl

_gl._get_file_handler = lambda data_folder_path, name: logging.NullHandler()

from get_logger import get_logger, LOGGER_NAMES

for _name in LOGGER_NAMES:
    get_logger(_name)

import service_health


def _frame(left_rpm=1950, left_current=12.0, left_water=True,
           right_rpm=2000, right_current=8.0, right_water=True):
    return {
        'type': 'frzHealth',
        'ts': 1783654226,
        'left': {'tec': {'current': left_current}, 'pump': {'mode': 'pwm', 'rpm': left_rpm, 'water': left_water}},
        'right': {'tec': {'current': right_current}, 'pump': {'mode': 'pwm', 'rpm': right_rpm, 'water': right_water}},
    }


class TestPumpHealth(unittest.TestCase):
    def setUp(self):
        # Fresh dwell-counter state per test, and capture update_health calls
        # instead of hitting the network.
        service_health._pump_state = {
            'left': service_health.new_pump_state(),
            'right': service_health.new_pump_state(),
        }
        self.calls = []
        self._orig_update_health = service_health.update_health
        service_health.update_health = lambda job_key, status, message='': self.calls.append((job_key, status, message))
        # The tests below model a side that is switched on with a stalled
        # pump, so the server answers "on" unless a test says otherwise. It
        # also keeps every test off the network.
        self.sides_on = {'left': True, 'right': True}
        self.intent_asks = 0
        self._orig_sides_commanded_on = service_health._sides_commanded_on

        def fake_sides_commanded_on():
            self.intent_asks += 1
            return self.sides_on

        service_health._sides_commanded_on = fake_sides_commanded_on

    def tearDown(self):
        service_health.update_health = self._orig_update_health
        service_health._sides_commanded_on = self._orig_sides_commanded_on

    def test_healthy_pump_reports_healthy_once(self):
        for _ in range(3):
            service_health.update_pump_health(_frame())
        # Only the first confirmed-healthy frame should report; no repeats.
        self.assertEqual(self.calls, [('pumpLeft', 'healthy', ''), ('pumpRight', 'healthy', '')])

    def test_pump_off_with_tec_idle_does_not_alert(self):
        # Side is off: TEC isn't drawing current, pump is idle at 0 RPM.
        # This must not be treated as a stall.
        for _ in range(10):
            service_health.update_pump_health(_frame(left_rpm=0, left_current=0.0, left_water=False))
        left_calls = [c for c in self.calls if c[0] == 'pumpLeft']
        self.assertEqual(left_calls, [])

    def test_sustained_stall_trips_after_dwell(self):
        # TEC actively driving but pump stalled (near-zero RPM), matches the
        # reported failure mode. Should not trip before the dwell window.
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES - 1):
            service_health.update_pump_health(_frame(left_rpm=5, left_current=12.0, left_water=False))
        self.assertEqual([c for c in self.calls if c[0] == 'pumpLeft'], [])

        service_health.update_pump_health(_frame(left_rpm=5, left_current=12.0, left_water=False))
        left_calls = [c for c in self.calls if c[0] == 'pumpLeft']
        self.assertEqual(len(left_calls), 1)
        self.assertEqual(left_calls[0][1], 'failed')
        self.assertIn('stall', left_calls[0][2].lower())

    def test_single_noisy_frame_does_not_trip(self):
        service_health.update_pump_health(_frame())
        service_health.update_pump_health(_frame(left_rpm=0, left_current=12.0, left_water=False))
        service_health.update_pump_health(_frame())
        left_calls = [c for c in self.calls if c[0] == 'pumpLeft' and c[1] == 'failed']
        self.assertEqual(left_calls, [])

    def test_recovers_after_dwell(self):
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(left_rpm=5, left_current=12.0, left_water=False))
        self.calls.clear()

        for _ in range(service_health._PUMP_RECOVERY_DWELL_FRAMES):
            service_health.update_pump_health(_frame())
        left_calls = [c for c in self.calls if c[0] == 'pumpLeft']
        self.assertEqual(len(left_calls), 1)
        self.assertEqual(left_calls[0][1], 'healthy')

    def test_missing_fields_are_skipped_not_crashed(self):
        service_health.update_pump_health({'type': 'frzHealth', 'ts': 1, 'left': {}, 'right': {}})
        self.assertEqual(self.calls, [])

    def test_stalled_latch_clears_once_side_goes_fully_quiet(self):
        # Trip a stall, then simulate the side powering off: frzHealth stops
        # carrying live TEC/pump numbers for it (empty dict), same shape as
        # test_missing_fields_are_skipped_not_crashed. A latch that trips
        # right before power-off must still be able to self-clear instead of
        # staying 'failed' forever with no more qualifying frames to receive.
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(left_rpm=5, left_current=12.0, left_water=False))
        self.assertTrue(service_health._pump_state['left']['is_stalled'])
        self.calls.clear()

        for _ in range(service_health._PUMP_RECOVERY_DWELL_FRAMES):
            service_health.update_pump_health({'type': 'frzHealth', 'ts': 1, 'left': {}, 'right': {}})
        left_calls = [c for c in self.calls if c[0] == 'pumpLeft']
        self.assertEqual(len(left_calls), 1)
        self.assertEqual(left_calls[0][1], 'healthy')
        self.assertFalse(service_health._pump_state['left']['is_stalled'])

    def test_transition_trace_fires_only_when_pump_ok_changes(self):
        # The per-frame trace records rpm but not the rest of the frame, which
        # is what is needed to tell a commanded-off side from a stalled one.
        # Dump the whole frame on the frames where that state flips, and only
        # those, so the diagnostic costs a few lines a day rather than one per
        # frame.
        logger = service_health.logger
        with self.assertLogs(logger, level='INFO') as captured:
            # first frame ever seen: None -> True is a transition
            service_health.update_pump_health(_frame())
            # steady state, no further transitions
            for _ in range(3):
                service_health.update_pump_health(_frame())
            # pump stops reporting rpm: True -> False
            service_health.update_pump_health(_frame(left_rpm=0))

        lines = [r.getMessage() for r in captured.records
                 if 'transition' in r.getMessage() and ' left ' in r.getMessage()]
        self.assertEqual(len(lines), 2)
        self.assertIn('pump_ok None -> True', lines[0])
        self.assertIn('pump_ok True -> False', lines[1])
        # the whole pump dict rides along, which is the point of the line
        self.assertIn("'mode': 'pwm'", lines[1])

    # A stopped pump is only a stall on a side that is meant to be running.
    # Eleven days of frames showed rpm at 0 for exactly the hours the schedule
    # had a side off, with TEC current never below 7A and pump mode unchanged,
    # so nothing in the frame tells switched-off from stalled. The server does.
    OFF_FRAME = dict(left_rpm=0, left_current=10.0, left_water=True)

    def test_a_side_switched_off_does_not_raise_a_stall(self):
        # The daily false alarm: the schedule powers the side off.
        self.sides_on = {'left': False, 'right': True}
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES * 10):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        failed = [c for c in self.calls if c[0] == 'pumpLeft' and c[1] == 'failed']
        self.assertEqual(failed, [])

    def test_a_side_switched_off_still_reports_healthy(self):
        # Otherwise a pod that starts while a side is off never reports that
        # side at all, and the Status page shows it as never checked.
        self.sides_on = {'left': False, 'right': True}
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        self.assertIn(('pumpLeft', 'healthy', ''), self.calls)

    def test_a_side_switched_on_with_a_stopped_pump_is_a_stall(self):
        # The case the monitor exists for, including a pump that never spins
        # up after the side is switched on.
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        failed = [c for c in self.calls if c[0] == 'pumpLeft' and c[1] == 'failed']
        self.assertEqual(len(failed), 1)

    def test_a_stall_clears_when_the_side_is_switched_off(self):
        # Recovery used to need the pump spinning again, which a switched-off
        # side never does, so a stall latched just before power-off stayed.
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        self.assertTrue(service_health._pump_state['left']['is_stalled'])
        self.calls.clear()

        self.sides_on = {'left': False, 'right': True}
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        self.assertFalse(service_health._pump_state['left']['is_stalled'])
        self.assertIn(('pumpLeft', 'healthy', ''), self.calls)

    def test_no_stall_is_declared_when_the_server_cannot_say(self):
        # No evidence the side is meant to be running is not evidence of a
        # stall. If the server is unreachable there is no Status page to show
        # one on either.
        self.sides_on = None
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES * 3):
            service_health.update_pump_health(_frame(**self.OFF_FRAME))
        failed = [c for c in self.calls if c[0] == 'pumpLeft' and c[1] == 'failed']
        self.assertEqual(failed, [])

    def test_the_server_is_asked_once_per_dwell_window_not_per_frame(self):
        # Every ask is a round trip to the hardware socket.
        self.sides_on = {'left': False, 'right': False}
        windows = 5
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES * windows):
            service_health.update_pump_health(_frame(
                left_rpm=0, left_current=10.0, right_rpm=0, right_current=10.0))
        # both sides share one answer per frame that needs it
        self.assertEqual(self.intent_asks, windows)

    def test_a_running_pump_never_asks(self):
        for _ in range(service_health._PUMP_STALL_DWELL_FRAMES * 3):
            service_health.update_pump_health(_frame())
        self.assertEqual(self.intent_asks, 0)

if __name__ == '__main__':
    unittest.main()
