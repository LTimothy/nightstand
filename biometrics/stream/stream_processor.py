"""
This module defines the `StreamProcessor` class, which processes continuous piezoelectric
sensor data to track user presence and extract biometric metrics such as heart rate,
heart rate variability (HRV), and breathing rate.

Key functionalities:
- Buffers incoming piezoelectric sensor data to process trends over time.
- Detects user presence based on signal strength for both left and right sides.
- Uses `BiometricProcessor` to analyze heart rate, HRV, and breathing rate.
- Supports single and dual-sensor configurations.
- Maintains a rolling buffer of sensor readings to smooth out noise.
- Extracts timestamped biometric data and logs presence detections.

Usage:
Instantiate `StreamProcessor` with an initial piezo record and call `process_piezo_record(piezo_record)`
with new sensor data to continuously track and analyze biometric trends.
"""
import sys
from typing import TYPE_CHECKING, Dict, Optional, Tuple, Union
from get_logger import get_logger
from biometric_processor import BiometricProcessor
from buffer import Buffer
from data_types import *
from db import insert_vitals
from presence.cap import CAP_HOLD_SECONDS, CapBaseline, cap_delta
from presence.detector import FRAME_GAP_SECONDS, DetectorParams, PresenceDetector, piezo_range
from presence.guard import UnexplainedUseGuard
from presence.piezo import CadenceCheck, keep_layout, piezo_layout
from presence.sensors import CAPSENSE2, CapFormat
import numpy as np

if TYPE_CHECKING:
    from pump_speed import PumpSpeed

logger = get_logger()

# An entry this soon after the other side emptied, onto a side whose own last
# exit came earlier, is taken as the partner moving across, so the side's
# vitals state is cleared instead of carried over.
SIDE_SWAP_SECONDS = 120
# How far ahead of the clock a reading may be stamped and still count as current.
CAP_FUTURE_TOLERANCE_SECONDS = 5

# (params, baselines) for a checked format, (params, baselines, format) for one that is not.
PresenceInputs = Union[
    Tuple[DetectorParams, Dict[str, CapBaseline]],
    Tuple[DetectorParams, Dict[str, CapBaseline], CapFormat],
]


def _inputs_format(inputs) -> CapFormat:
    return inputs[2] if len(inputs) > 2 else CAPSENSE2


class _QuietProcessor(BiometricProcessor):
    """Vitals for a side whose presence the server keeps hearing from the piezo detector."""

    def _update_presence_api(self, is_present: bool):
        pass


class LatestCap:
    """Newest capacitance channels for both sides and their format, written by the reader thread."""

    def __init__(self):
        self._reading = None

    def update(self, ts, left, right, cap_format: CapFormat = CAPSENSE2) -> None:
        # One assignment, so the processing thread never sees half an update.
        self._reading = (int(ts), left, right, cap_format)

    def read(self):
        """(ts, left, right, format), or None before the first reading."""
        return self._reading

    def cap_format(self) -> Optional[CapFormat]:
        reading = self._reading
        return None if reading is None else reading[3]

    def is_fresh(self, now: float, max_age: float) -> bool:
        reading = self._reading
        return reading is not None and -CAP_FUTURE_TOLERANCE_SECONDS <= now - reading[0] <= max_age


def is_side_swap(entering: BiometricProcessor, other: BiometricProcessor, epoch: int) -> bool:
    """True when this entry looks like the partner moving across, not the side's occupant returning."""
    if other.present or other.last_exit_at is None:
        return False
    if not 0 <= epoch - other.last_exit_at <= SIDE_SWAP_SECONDS:
        return False
    return entering.last_exit_at is None or other.last_exit_at >= entering.last_exit_at


class StreamProcessor:
    def __init__(
            self,
            piezo_record,
            debug=False,
            cap_source: Optional[LatestCap] = None,
            pump: Optional['PumpSpeed'] = None,
    ):
        if 'left2' in piezo_record:
            self.sensor_count = 2
        else:
            self.sensor_count = 1
        # Vitals read the sample rate from here; presence reads the cadence.
        self.piezo_layout = None
        self._note_piezo_layout(piezo_record)
        self.cadence = CadenceCheck()
        self.cadence.add(piezo_record.get('ts'))
        self.left_processor = BiometricProcessor(side='left', sensor_count=self.sensor_count, insertion_frequency=60, debug=debug)
        self.right_processor = BiometricProcessor(side='right', sensor_count=self.sensor_count, insertion_frequency=60, debug=debug)
        self.buffer = Buffer(
            self.right_processor.heart_rate_window_seconds,
            self.right_processor.breath_rate_window_seconds,
            self.right_processor.hrv_window_seconds,
        )
        self.iteration_count = 0
        self.debug = debug
        self.cap_source = cap_source
        # Set through use_presence_v2. None leaves presence to the piezo detector.
        self.presence: Optional[PresenceDetector] = None
        self._presence_inputs: Optional[PresenceInputs] = None
        self._presence_epoch: Optional[int] = None
        self._guard: Optional[UnexplainedUseGuard] = None
        # Inputs whose levels did not fit this bed; tried again once calibration changes them.
        self._declined_inputs: Optional[PresenceInputs] = None
        # On an unchecked format, the piezo detector's processors, which go on
        # telling the server who is in bed while capacitance gates the vitals.
        self._piezo_presence: Optional[Tuple[BiometricProcessor, BiometricProcessor]] = None
        self.pump = pump
        # Set through use_vitals_v2. Off leaves vitals to the legacy processors, and the newer
        # estimators are not loaded until the switch is first on.
        self._vitals2_lib = None
        self.vitals2 = None
        self.vitals2_enabled = False
        # Whether the newer estimators wrote the last record's vitals, and the first minute they may write.
        self._vitals2_running = False
        self._vitals2_from = 0

    def use_presence_v2(self, inputs: Optional[PresenceInputs]) -> None:
        """Hand presence to the capacitance detector (inputs) or back to piezo (None).

        A change of detector ends any current session, so the new one starts
        from an empty bed. New calibration for a running detector waits until
        nobody is in the bed. Inputs handed back for not fitting the bed are
        refused until calibration changes them. On an unchecked format the
        server keeps hearing the piezo detector, unbroken, and capacitance
        decides only when vitals are taken.
        """
        if inputs is None:
            if self.presence is not None:
                logger.info('Presence switching to the piezo detector')
                if self._piezo_presence is not None:
                    self.left_processor, self.right_processor = self._piezo_presence
                    self._piezo_presence = None
                    self.left_processor.reset()
                    self.right_processor.reset()
                else:
                    self._end_sessions()
                self.presence = None
                self._presence_inputs = None
                self._guard = None
            return
        if inputs == self._declined_inputs:
            return
        if self.presence is not None and _inputs_format(inputs) != _inputs_format(self._presence_inputs):
            self.use_presence_v2(None)
        if self.presence is not None and (inputs == self._presence_inputs or any(self.presence.state().values())):
            return
        validated = _inputs_format(inputs).validated
        # Built before anything is swapped: a failure here must leave presence as it was.
        detector = PresenceDetector(inputs[0])
        guard = None if validated else UnexplainedUseGuard(inputs[0])
        if self.presence is None:
            logger.info('Presence switching to the capacitance detector')
            if validated:
                self._end_sessions()
            else:
                quiet = (self._quiet_processor('left'), self._quiet_processor('right'))
                self._piezo_presence = (self.left_processor, self.right_processor)
                self.left_processor, self.right_processor = quiet
        self.presence = detector
        self._presence_inputs = inputs
        self._presence_epoch = None
        self._guard = guard

    def use_vitals_v2(self, enabled: bool) -> None:
        """Let the newer estimators take vitals while capacitance presence is in charge (True), or never (False)."""
        if enabled == self.vitals2_enabled:
            return
        if enabled and self._vitals2_lib is None:
            import vitals2_stream
            self._vitals2_lib = vitals2_stream
        if enabled and self.vitals2 is None:
            self.vitals2 = self._new_vitals2()
        logger.info('Newer vitals estimators switched ' + ('on; they take vitals while capacitance presence '
                                                           'is in charge' if enabled else 'off'))
        self.vitals2_enabled = enabled

    def _use_vitals2(self, epoch: int) -> bool:
        """Whether this record's vitals come from the newer estimators, handing over between paths cleanly.

        The newer estimators need capacitance presence; otherwise the legacy
        path writes, as with the switch off. Each path starts cold, and no
        side and minute gets rows from both.
        """
        wanted = self.vitals2_enabled and self.presence is not None
        if wanted == self._vitals2_running:
            return wanted
        self._vitals2_running = wanted
        if wanted:
            logger.info('Vitals now from the newer estimators')
            self.vitals2 = self._new_vitals2()
            # The legacy path may already have written this minute.
            self._vitals2_from = epoch // 60 * 60 + 60
        else:
            logger.info('Vitals now from the legacy estimators')
            # Minutes before this one; the legacy path writes from here on.
            self._insert_vitals2(self.vitals2.flush(epoch, self.piezo_layout))
            self.vitals2 = self._new_vitals2() if self.vitals2_enabled else None
            # Measurements from before the newer estimators ran must not be written now.
            self.left_processor.reset()
            self.right_processor.reset()
        return wanted

    def _new_vitals2(self):
        return self._vitals2_lib.Vitals2Stream(pump=self.pump)

    def _insert_vitals2(self, rows) -> None:
        for row in rows:
            if row['timestamp'] >= self._vitals2_from:
                insert_vitals(row)

    def _present_sides(self) -> Dict[str, bool]:
        # Only the capacitance detector places a side for the newer estimators. It feeds these two
        # processors, the quiet pair on an unchecked format included.
        if self.presence is None:
            return {'left': False, 'right': False}
        return {'left': self.left_processor.present, 'right': self.right_processor.present}

    def _cap_age(self, epoch: int) -> Optional[float]:
        """Seconds since the capacitance reading the detector reads, None without one it can use."""
        if self.presence is None or self.cap_source is None:
            return None
        reading = self.cap_source.read()
        if reading is None or reading[3].name != _inputs_format(self._presence_inputs).name:
            return None
        return epoch - reading[0]

    def _process_vitals2(self, piezo_record) -> None:
        epoch = int(piezo_record['ts'])
        last = self.vitals2.last_epoch
        if last is not None and last - epoch > self._vitals2_lib.CLOCK_STEP_BACK_SECONDS:
            # The estimators start over on the new clock, so rows count from its next minute as at a hand-over.
            self._vitals2_from = epoch // 60 * 60 + 60
        self._insert_vitals2(self.vitals2.step(epoch, self.piezo_layout, self.buffer, self._present_sides(),
                                               cap_age=self._cap_age(epoch)))

    def _quiet_processor(self, side: str) -> BiometricProcessor:
        return _QuietProcessor(side=side, sensor_count=self.sensor_count, insertion_frequency=60, debug=self.debug)

    def _end_sessions(self) -> None:
        self.left_processor.end_presence_session()
        self.right_processor.end_presence_session()

    def _step_presence(self, piezo_record) -> None:
        epoch = int(piezo_record['ts'])
        # The detector reads a repeated or earlier second as a break in the
        # frames, so drop one; a long step back is a clock change and goes through.
        if self._presence_epoch is not None and 0 <= self._presence_epoch - epoch <= FRAME_GAP_SECONDS:
            return
        self._presence_epoch = epoch
        baselines = self._presence_inputs[1]
        cap = {'left': None, 'right': None}
        reading = self.cap_source.read() if self.cap_source is not None else None
        # A reading in another format would be read against the wrong baselines.
        if (reading is not None and abs(epoch - reading[0]) <= CAP_HOLD_SECONDS
                and reading[3].name == _inputs_format(self._presence_inputs).name):
            cap = {
                'left': cap_delta(reading[1], baselines['left']),
                'right': cap_delta(reading[2], baselines['right']),
            }
        piezo = {
            'left': piezo_range(piezo_record.get('left1')),
            'right': piezo_range(piezo_record.get('right1')),
        }
        states = self.presence.step(epoch, cap, piezo)
        if self._guard is not None and self._guard.step(states, piezo):
            logger.warning('Capacitance did not explain the bed in use for 10 of the last 15 minutes, so the '
                           'vibration sensor decides who is in bed and the legacy estimators take vitals until '
                           'calibration changes')
            declined = self._presence_inputs
            self.use_presence_v2(None)
            self._declined_inputs = declined
            return
        left, right = self.left_processor, self.right_processor
        left_swap = states['left'] and not left.present and is_side_swap(left, right, epoch)
        right_swap = states['right'] and not right.present and is_side_swap(right, left, epoch)
        # The side the partner came from keeps nothing for whoever lies down there next.
        if left_swap:
            right.reset()
        if right_swap:
            left.reset()
        if (left_swap or right_swap) and self.vitals2 is not None:
            # Rows the previous occupants still owe are written before the sides start over.
            self._insert_vitals2(self.vitals2.flush(epoch, self.piezo_layout))
            self.vitals2.reset_side('left')
            self.vitals2.reset_side('right')
        left.apply_presence(states['left'], epoch, reset_state=left_swap)
        right.apply_presence(states['right'], epoch, reset_state=right_swap)

    def check_presence(
        self,
        left1_signal: np.ndarray,
        right1_signal: np.ndarray,
        left2_signal=None,
        right2_signal=None,
    ):
        # Pass both piezos per side so detect_presence can use the max of
        # head + foot piezo, improves coverage when a person isn't centred
        # over a single sensor and gives the coordinator more signal to
        # distinguish real occupancy from asymmetric transmission.
        left, right = self._piezo_presence or (self.left_processor, self.right_processor)
        left.detect_presence(left1_signal, left2_signal)
        right.detect_presence(right1_signal, right2_signal)

    def can_calculate_breath_rate(self):
        return (
            self.iteration_count > self.left_processor.breath_rate_window_seconds
            and self.iteration_count % self.left_processor.breath_rate_insertion_frequency == 0
        )

    def can_calculate_hrv(self):
        return (
            self.iteration_count > self.left_processor.hrv_window_seconds
            and self.iteration_count % self.left_processor.hrv_insertion_frequency == 0
        )

    def _note_piezo_layout(self, piezo_record) -> None:
        if self.piezo_layout is None or self.piezo_layout.freq is None:
            self.piezo_layout = keep_layout(self.piezo_layout, piezo_layout(piezo_record))

    def process_piezo_record(self, piezo_record: PiezoDualData):
        self._note_piezo_layout(piezo_record)
        self.cadence.add(piezo_record.get('ts'))
        self.iteration_count += 1
        self.buffer.append(piezo_record)
        if self.presence is not None:
            self._step_presence(piezo_record)
        if self.iteration_count > self.left_processor.heart_rate_window_seconds:
            left1_signal = self.buffer.get_heart_rate_signal('left', 1)
            right1_signal = self.buffer.get_heart_rate_signal('right', 1)

            # Pull signal2 for both sides up-front (only if dual sensors are
            # available) so check_presence gets all four piezos.
            left2_signal = None
            right2_signal = None
            if self.sensor_count == 2:
                left2_signal = self.buffer.get_heart_rate_signal('left', 2)
                right2_signal = self.buffer.get_heart_rate_signal('right', 2)

            log = self.iteration_count % 300 == 0
            epoch = piezo_record['ts']
            time = datetime.fromtimestamp(epoch)
            if log:
                logger.debug(f'Process check - Processing piezo record @ {time.isoformat()}')

            if self.presence is None or self._piezo_presence is not None:
                self.check_presence(left1_signal, right1_signal, left2_signal, right2_signal)

            if self._use_vitals2(int(epoch)):
                self._process_vitals2(piezo_record)
                return

            # Process left side
            if self.left_processor.present_for > self.left_processor.heart_rate_window_seconds:
                if log:
                    logger.debug(f'Presence detected for left side @ {time.isoformat()}')

                # Heart rate calculation
                self.left_processor.calculate_heart_rate(epoch, left1_signal, left2_signal)

                # Breath rate calculation
                if self.can_calculate_breath_rate() and self.left_processor.present_for >= self.left_processor.breath_rate_window_seconds:
                    breath_rate_signal = self.buffer.get_signal('left', self.left_processor.breath_rate_window_seconds)
                    self.left_processor.calculate_breath_rate(breath_rate_signal, epoch)

                # HRV calculation
                if self.can_calculate_hrv() and self.left_processor.present_for >= self.left_processor.hrv_window_seconds:
                    hrv_signal = self.buffer.get_signal('left', self.left_processor.hrv_window_seconds)
                    self.left_processor.calculate_hrv(hrv_signal, epoch)

            # Process right side
            if self.right_processor.present_for > self.right_processor.heart_rate_window_seconds:
                if log:
                    logger.debug(f'Presence detected for right side @ {time.isoformat()}')

                # Heart rate calculation
                self.right_processor.calculate_heart_rate(epoch, right1_signal, right2_signal)

                # Breath rate calculation
                if self.can_calculate_breath_rate() and self.right_processor.present_for >= self.right_processor.breath_rate_window_seconds:
                    breath_rate_signal = self.buffer.get_signal('right', self.right_processor.breath_rate_window_seconds)
                    self.right_processor.calculate_breath_rate(breath_rate_signal, epoch)

                # HRV calculation
                if self.can_calculate_hrv() and self.right_processor.present_for >= self.right_processor.hrv_window_seconds:
                    hrv_signal = self.buffer.get_signal('right', self.right_processor.hrv_window_seconds)
                    self.right_processor.calculate_hrv(hrv_signal, epoch)



