import sys
import platform
import os
from datetime import datetime, timezone
import time

sys.path.append(os.getcwd())
if platform.system().lower() == 'linux':
    sys.path.append('/home/dac/free-sleep/biometrics/')

# This must run before the other local import in order to set up the logger
from get_logger import get_logger

logger = get_logger()

import urllib.request
import json

# Throttle sensor temp updates to avoid flooding the server
_last_sensor_temps_update: float = 0
SENSOR_TEMPS_UPDATE_INTERVAL = 30  # seconds


def is_biometrics_enabled() -> bool:
    try:
        services_db_file_path = '/persistent/free-sleep-data/lowdb/servicesDB.json'
        if os.path.isfile(services_db_file_path):
            print('Loading servicesDB.json...')
            with open(services_db_file_path) as file:
                services_db = json.load(file)
                return services_db["biometrics"]["enabled"]
        else:
            logger.error(f'File not found! {services_db_file_path}')
            return False
    except Exception as error:
        logger.error('Error checking if biometrics is enabled, returning false')
        logger.error(error)
        return False



def update_health(job_key: str, status: str, message: str = ''):
    try:
        logger.debug(f'Updating health status for {job_key} - {status} - {message}')

        data = json.dumps({
            "biometrics": {
                "jobs": {
                    job_key: {
                        "status": status,
                        "message": message,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                }
            },
        }).encode("utf-8")

        req = urllib.request.Request(
            "http://127.0.0.1:3000/api/services",
            headers={"Content-Type": "application/json"},
            method="POST",
            data=data,
        )

        with urllib.request.urlopen(req) as response:
            if response.status == 200:
                logger.debug("Updated status successfully")
            else:
                print(f"Unexpected status: {response.status}")

    except Exception as error:
        logger.error('Failed updating calibration status')
        logger.error(error)


def update_sensor_temps(frz_temp_data: dict):
    """
    Updates sensor temperature readings from frzTemp data.
    Called by the biometrics stream processor when temperature readings are received.
    Throttled to avoid flooding the server (updates at most every 30 seconds).
    """
    global _last_sensor_temps_update

    # Throttle updates
    now = time.time()
    if now - _last_sensor_temps_update < SENSOR_TEMPS_UPDATE_INTERVAL:
        return
    _last_sensor_temps_update = now

    try:
        logger.debug(f'Updating sensor temps - amb={frz_temp_data.get("amb")}')

        data = json.dumps({
            "biometrics": {
                "sensorTemps": {
                    "ambient": frz_temp_data.get("amb"),
                    "heatsink": frz_temp_data.get("hs"),
                    "left": frz_temp_data.get("left"),
                    "right": frz_temp_data.get("right"),
                    "lastUpdated": datetime.now(timezone.utc).isoformat(),
                }
            },
        }).encode("utf-8")

        req = urllib.request.Request(
            "http://127.0.0.1:3000/api/services",
            headers={"Content-Type": "application/json"},
            method="POST",
            data=data,
        )

        with urllib.request.urlopen(req) as response:
            if response.status == 200:
                logger.debug("Updated sensor temps successfully")
            else:
                logger.warning(f"Unexpected status updating sensor temps: {response.status}")

    except Exception as error:
        logger.error('Failed updating sensor temps')
        logger.error(error)


# Pump stall detection. The hub water-temperature sensor sits next to the
# heating/cooling element (TEC), not in the bed. While the pump circulates,
# it reads moving water leaving the bed, meaningful. If the pump stalls
# while the TEC keeps drawing current, the sensor reads stagnant water next
# to a powered heating element instead: a runaway number that doesn't
# reflect bed temperature. This exact failure mode was reported by a
# free-sleep user (side ran to 102F against an 84F setpoint overnight,
# cleared by a power cycle) and independently documented by sleepypod/core's
# ADR 0022. Verified against this pod's live frzHealth frames: pump RPM
# running ~1900-2000, TEC current several amps when actively heating/cooling
#, a >200 RPM floor while TEC is active is a wide, conservative margin.
_PUMP_RPM_STALL_THRESHOLD = 200
_PUMP_TEC_ACTIVE_AMPS = 1.0
# frzHealth frames arrive roughly once every 10s; 6 consecutive ~= 1 minute
# of sustained stall before alerting, 3 consecutive ~= 30s of recovery
# before clearing, avoids flapping on a single noisy frame in either
# direction.
#
# A stopped pump is only a stall on a side that is switched on, and nothing in
# the frame says which. Eleven days of it showed rpm at 0 for exactly the hours
# the power schedule had a side off, TEC current never below 7.2A in 96,247
# frames (so the 1.0A bar above never excludes anything), and pump mode still
# 'pwm' at rpm 0. So the server, which knows, is asked whether the side is on
# before a stall is declared. Do not tune these thresholds to compensate for a
# missing gate.
_PUMP_STALL_DWELL_FRAMES = 6
_PUMP_RECOVERY_DWELL_FRAMES = 3

def new_pump_state() -> dict:
    """Per-side dwell state. Shared with the tests so the two cannot drift."""
    return {
        'consecutive_stall': 0,
        'consecutive_healthy': 0,
        'is_stalled': False,
        'reported_healthy': False,
        'prev_pump_ok': None,
    }


_pump_state = {'left': new_pump_state(), 'right': new_pump_state()}


def _sides_commanded_on():
    """Which sides the server says are switched on, or None if it cannot say."""
    try:
        with urllib.request.urlopen('http://127.0.0.1:3000/api/deviceStatus', timeout=5) as response:
            status = json.load(response)
        return {side: bool((status.get(side) or {}).get('isOn')) for side in ('left', 'right')}
    except Exception as error:
        logger.warning(f'Could not read which sides are switched on: {error}')
        return None


def update_pump_health(frz_health_data: dict):
    """
    Watches frzHealth frames (pump RPM/water + TEC current per side) for a
    stalled-pump-while-heating condition and reports it to the Status page
    via the same update_health() job-status mechanism as other biometrics
    jobs. Called from the stream processor for every frzHealth frame.
    """
    # Fetched at most once per frame and only when a side needs it: every ask
    # is a round trip to the hardware socket.
    intent = {}

    def commanded_on(side):
        if 'sides' not in intent:
            intent['sides'] = _sides_commanded_on()
        return None if intent['sides'] is None else intent['sides'][side]

    try:
        for side in ('left', 'right'):
            side_data = frz_health_data.get(side) or {}
            tec = side_data.get('tec') or {}
            pump = side_data.get('pump') or {}
            current = tec.get('current')
            rpm = pump.get('rpm')
            water = pump.get('water')

            # Missing current/rpm can't confirm an active stall (tec_active
            # requires `current`), so treat it the same as "TEC not active"
            # rather than skipping the frame outright. A side that's fully
            # powered off stops carrying live TEC/pump numbers in frzHealth;
            # skipping froze the dwell counters entirely, so a stall latched
            # right before power-off could never reach the recovery dwell and
            # stayed 'failed' indefinitely.
            tec_active = current is not None and abs(current) >= _PUMP_TEC_ACTIVE_AMPS
            pump_ok = rpm is not None and rpm >= _PUMP_RPM_STALL_THRESHOLD and water is not False
            state = _pump_state[side]

            # Per-frame trace for diagnosing whether a stall onset is a real
            # mechanical stall or a momentary frame-data artifact:
            # there was previously no way to inspect the raw values leading
            # up to a trip.
            logger.debug(
                f'pump health {side}: current={current} rpm={rpm} water={water} '
                f'tec_active={tec_active} pump_ok={pump_ok} '
                f'consecutive_stall={state["consecutive_stall"]} consecutive_healthy={state["consecutive_healthy"]}'
            )

            # Whole-frame dump on the frames where pump_ok flips, which is
            # where the pump starts or stops reporting rpm. Logged only on the
            # transition, a few times a day, not on every frame.
            if state.get('prev_pump_ok') != pump_ok:
                logger.info(
                    f'pump health {side} transition: pump_ok {state.get("prev_pump_ok")} '
                    f'-> {pump_ok}, pump={pump} tec={tec}'
                )
            state['prev_pump_ok'] = pump_ok

            if tec_active and not pump_ok:
                state['consecutive_stall'] += 1
                state['consecutive_healthy'] = 0
            else:
                state['consecutive_healthy'] += 1
                state['consecutive_stall'] = 0

            job_key = f'pump{side.capitalize()}'

            # Asked once per dwell window, not per frame: whether a side is on
            # only changes at a schedule boundary or a manual switch.
            at_dwell = (
                state['consecutive_stall'] > 0
                and state['consecutive_stall'] % _PUMP_STALL_DWELL_FRAMES == 0
            )
            side_on = commanded_on(side) if at_dwell else None

            if not state['is_stalled'] and at_dwell and side_on:
                state['is_stalled'] = True
                state['reported_healthy'] = True
                message = (
                    f'Pump stall suspected on {side} side: the side is switched on but the '
                    f'pump reports rpm={rpm}, water={water}. The hub temperature sensor '
                    f'may be reading stagnant water next to the heating element, not '
                    f'actual bed temperature.'
                )
                logger.error(message)
                update_health(job_key, 'failed', message)
            elif state['is_stalled'] and at_dwell and side_on is False:
                # A switched-off side never spins its pump back up, so waiting
                # for rpm to recover would latch the stall indefinitely.
                state['is_stalled'] = False
                logger.info(f'Pump on {side} side is no longer checked: the side was switched off')
                update_health(job_key, 'healthy', '')
            elif state['is_stalled'] and state['consecutive_healthy'] >= _PUMP_RECOVERY_DWELL_FRAMES:
                state['is_stalled'] = False
                logger.info(f'Pump on {side} side recovered: rpm={rpm}, water={water}')
                update_health(job_key, 'healthy', '')
            elif (
                not state['is_stalled'] and not state['reported_healthy']
                and (pump_ok or (at_dwell and side_on is False))
            ):
                state['reported_healthy'] = True
                update_health(job_key, 'healthy', '')
    except Exception as error:
        logger.error('Failed updating pump health')
        logger.error(error)
