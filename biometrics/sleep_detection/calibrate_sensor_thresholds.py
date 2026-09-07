"""
This script calibrates sensor thresholds by analyzing historical raw data to establish a baseline
for sleep detection using piezoelectric and capacitance sensors.

Key functionalities:
- Loads raw `.RAW` sensor data for a specified time range and bed side.
- Processes piezoelectric sensor data to detect presence using signal thresholds.
- Analyzes capacitance sensor data to create a baseline for occupancy detection.
- Identifies a baseline period and saves the capacitance sensor baseline for future reference.
- Optimized for memory efficiency using garbage collection (`gc`).

Usage:
Run the script with required parameters:
    cd /home/dac/free-sleep/biometrics/sleep_detection && /home/dac/venv/bin/python calibrate_sensor_thresholds.py --side=left --start_time="YYYY-MM-DD HH:MM:SS" --end_time="YYYY-MM-DD HH:MM:SS"
"""
import sys
import platform
import os
import gc
import json
import time
import urllib.request
from argparse import Namespace, ArgumentParser
import traceback
from typing import Union
from datetime import datetime, timezone, timedelta


sys.path.append(os.getcwd())
FOLDER_PATH = '/Users/ds/main/8sleep_biometrics/data/people/david/raw/loaded/2025-01-10/'
if platform.system().lower() == 'linux':
    FOLDER_PATH = '/persistent/'
    sys.path.append('/home/dac/free-sleep/biometrics/')

# This must run before the other local import in order to set up the logger
from get_logger import get_logger

logger = get_logger('calibrate-sensor')

from data_types import *
from load_raw_files import load_raw_files
from piezo_data import load_piezo_df, detect_presence_piezo, identify_baseline_period, summarize_empty_floor, one_value_per_second
from cap_data import load_cap_df, create_cap_baseline_from_cap_df, save_baseline
from resource_usage import get_memory_usage_unix, get_available_memory_mb
from biometrics_helpers import validate_datetime_utc
from service_health import update_health, is_biometrics_enabled
from insufficient_data import InsufficientDataError, outcome_for_exception
import calibration


def _parse_args() -> Union[Namespace, None]:
    # Argument parser setup
    parser = ArgumentParser(description="Process presence intervals with UTC datetime.")

    # Named arguments with default values if needed
    parser.add_argument(
        "--side",
        choices=["left", "right"],
        required=False,
        help="Side of the bed to process (left or right)."
    )
    parser.add_argument(
        "--start_time",
        type=validate_datetime_utc,
        required=False,
        help="Start time in UTC format 'YYYY-MM-DD HH:MM:SS'."
    )
    parser.add_argument(
        "--end_time",
        type=validate_datetime_utc,
        required=False,
        help="End time in UTC format 'YYYY-MM-DD HH:MM:SS'."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Skip the bed-occupancy guard. For user-initiated runs where the "
             "user has confirmed the bed is empty, the live presence detector "
             "can latch 'present' on a side whose empty-bed noise floor sits "
             "near the detection threshold, which would otherwise block "
             "calibration forever (the thresholds it needs are the very thing "
             "calibration fixes)."
    )

    # Parse arguments
    args = parser.parse_args()
    if args.start_time is None or args.end_time is None or args.side is None:
        # Both-sides mode (side/window omitted); only --force carries over.
        return Namespace(side=None, start_time=None, end_time=None, force=args.force)
    # Validate that start_time is before end_time
    if args.start_time >= args.end_time:
        raise ValueError("--start_time must be earlier than --end_time")

    return args


def _record_piezo_floor(side: Side, merged_df, window_start, window_end, window_seconds: float, trigger: str):
    """Measure this side's empty-bed piezo floor and store it. Never raises.

    Runs after the capacitive baseline has already been saved, and that
    baseline is what presence detection depends on today. This measurement
    depends on nothing and is depended on by nothing, so it must not be able
    to turn a calibration that already succeeded into a failed one. Every
    error is recorded against its own run row and swallowed.

    The floor is measured over the same window the capacitive baseline came
    from, which is the only empty-bed label on this pod that is produced by a
    guard rather than by an assumption about what time of day it is.
    """
    started_at = int(time.time())

    def _record(status: str, quality=None, message=None, payload=None,
                source_start=None, source_end=None):
        return calibration.record_run(
            side, calibration.SENSOR_TYPE_PIEZO, status, trigger,
            started_at=started_at,
            duration_ms=int((time.time() - started_at) * 1000),
            quality=quality, message=message, payload=payload,
            source_start=source_start, source_end=source_end,
        )

    try:
        try:
            column = f'{side}1_p2p'
            if column not in merged_df.columns:
                raise KeyError(f'{column} is missing, load_piezo_df was called without with_p2p=True')

            payload = summarize_empty_floor(one_value_per_second(merged_df.loc[window_start:window_end, column]))
            quality = calibration.compute_quality(window_seconds, payload['samples'], int(window_seconds))
            run_id = _record(
                calibration.STATUS_SUCCESS, quality=quality, payload=payload,
                source_start=int(window_start.timestamp()), source_end=int(window_end.timestamp()),
            )
            calibration.save_profile(
                side, calibration.SENSOR_TYPE_PIEZO, payload, quality=quality,
                source_start=int(window_start.timestamp()),
                source_end=int(window_end.timestamp()),
                samples_used=payload['samples'], run_id=run_id,
            )
            logger.info(
                f"Learned an empty-bed piezo floor for the {side} side: {payload['floor']:,.0f} "
                f"(p{payload['floor_percentile']} of {payload['samples']:,} samples, quality {quality:.2f})"
            )
        except InsufficientDataError as error:
            _record(calibration.STATUS_INSUFFICIENT_DATA, message=str(error))
        except Exception as error:
            logger.warning(f'Could not measure the {side} empty-bed piezo floor: {error}')
            _record(calibration.STATUS_FAILED, message=str(error))
    except Exception as error:
        # Recording the outcome can itself fail: the store shares its SQLite
        # file with the vitals writer and a write can hit a lock. Losing this
        # record is acceptable. Losing the calibration that already succeeded
        # is not.
        logger.warning(f'Could not record the {side} piezo floor run: {error}')


def calibrate_sensor_thresholds(side: Side, start_time: datetime, end_time: datetime, folder_path: str, trigger: str = calibration.TRIGGER_DAILY):
    started_at = int(time.time())
    expected_row_count = int((end_time - start_time).total_seconds())
    logger.debug(f"Calibrating sensors for {side} side | {start_time.isoformat()} -> {end_time.isoformat()} | Expected row count: {expected_row_count:,}")

    def _elapsed_ms():
        return int((time.time() - started_at) * 1000)

    run_id = None
    try:
        data = load_raw_files(
            folder_path,
            start_time,
            end_time,
            side,
            sensor_count=1,
            raw_data_types=['capSense', 'piezo-dual']
        )

        # with_p2p=True adds the within-second p98-p2 range column. That is the
        # quantity both presence detectors threshold, so it is the only one
        # whose empty-bed floor is comparable to their entry bar. It costs one
        # extra pass over the raw arrays before they are dropped below.
        piezo_df = load_piezo_df(data, side, expected_row_count=expected_row_count, with_p2p=True)
        # threshold_percent=0.70: 70% of the rolling window must read "above range"
        # before that window counts as occupied, so a couple of noisy seconds inside
        # an otherwise-empty window can't flip the calibration off course.
        # range_threshold=80_000: piezo range gate for this pass, same family as
        # NOISE_THRESHOLD in biometric_processor.py (both bound the same signal).
        detect_presence_piezo(
            piezo_df,
            side,
            rolling_seconds=10,
            threshold_percent=0.70,
            range_threshold=80_000,
            range_rolling_seconds=10,
            clean=False
        )

        cap_df = load_cap_df(data, side, expected_row_count=expected_row_count)
        # Cleanup data
        del data
        gc.collect()

        merged_df = piezo_df.merge(cap_df, on='ts', how='inner')
        # Free up memory from old dfs
        piezo_df.drop(piezo_df.index, inplace=True)
        cap_df.drop(cap_df.index, inplace=True)
        del piezo_df
        del cap_df
        gc.collect()

        # Create baseline. min_std uses create_cap_baseline_from_cap_df's default
        # (see that function's docstring/comment for how it was derived).
        # empty_minutes=5: shortest window worth calibrating from; long enough for
        # the stability check below to be meaningful, short enough that a genuinely
        # empty stretch of the night is still likely to contain one.
        # Reject any candidate window where either side recorded vitals. The
        # search reads only this side's sensors, so without this a side can
        # learn its empty-bed baseline from a stretch where the partner was in
        # bed and coupling through the mattress frame. The range is chosen by
        # identify_baseline_period from the frame it searches, not here: the
        # loaded frame starts before the requested window, and a range taken
        # from the request leaves those early candidates unchecked.
        def _occupied_lookup(window_start_ts: int, window_end_ts: int):
            try:
                occupied = calibration.occupied_seconds(window_start_ts, window_end_ts)
                if occupied:
                    logger.debug(f'{len(occupied):,} seconds in this load had someone in the bed')
                return occupied
            except Exception as error:
                # Falling back to the previous behaviour beats failing a
                # calibration the capacitive baseline depends on, but say so
                # plainly: this run's window was not checked for occupancy.
                logger.warning(f'Could not read bed occupancy, picking a window without that check: {error}')
                return []

        baseline_start_time, baseline_end_time = identify_baseline_period(
            merged_df, side, threshold_range=10_000, empty_minutes=5, occupied_lookup=_occupied_lookup)
        if baseline_start_time is None:
            # RAW data exists but no clean empty-bed window was found in it yet, so
            # there is nothing trustworthy to calibrate against. Treat this as
            # insufficient-data (a calm waiting state), not a failure, and don't
            # save a baseline built over occupied time (that offsets toward
            # "present" and is exactly what the occupancy guard protects against).
            raise InsufficientDataError(
                f'No empty-bed period found for the {side} side yet, so there is '
                f'nothing to calibrate against. This resolves once the sensors '
                f'record a stretch of empty bed.'
            )
        cap_baseline = create_cap_baseline_from_cap_df(merged_df, baseline_start_time, baseline_end_time, side)

        # Score the profile over the baseline window that was actually used,
        # not the much longer window of raw data loaded to find it.
        window_seconds = (baseline_end_time - baseline_start_time).total_seconds()
        window_df = merged_df[baseline_start_time:baseline_end_time]
        # Distinct seconds, not rows: the capacitive sensor contributes two
        # rows per second, and the quality score compares this count against
        # seconds. Row count saturated it, so a half-empty window scored full.
        samples_used = window_df.index.nunique()
        quality = calibration.compute_quality(window_seconds, samples_used, int(window_seconds))

        # Write the legacy baseline file before touching the calibration
        # store. It is what an instant rollback to an older server reads, and
        # that database is shared with the vitals writer (5 second busy
        # timeout), so a store write can fail on a lock. Writing it first
        # means a store failure costs the store, not the rollback safety net.
        save_baseline(side, cap_baseline)

        run_id = calibration.record_run(
            side, 'cap', calibration.STATUS_SUCCESS, trigger,
            started_at=started_at, duration_ms=_elapsed_ms(), quality=quality,
        )
        calibration.save_profile(
            side, 'cap', cap_baseline, quality=quality,
            source_start=int(baseline_start_time.timestamp()),
            source_end=int(baseline_end_time.timestamp()),
            samples_used=samples_used, run_id=run_id,
        )

        # Nothing reads this yet. Both presence detectors still gate on their
        # hardcoded threshold. Storing the learned number first makes it, and
        # its night-to-night stability, observable before anything bets on it.
        _record_piezo_floor(side, merged_df, baseline_start_time, baseline_end_time, window_seconds, trigger)

        merged_df.drop(merged_df.index, inplace=True)
        del merged_df
        gc.collect()
    except InsufficientDataError as error:
        calibration.record_run(
            side, 'cap', calibration.STATUS_INSUFFICIENT_DATA, trigger,
            started_at=started_at, duration_ms=_elapsed_ms(), message=str(error),
        )
        raise
    except Exception as error:
        if run_id is not None:
            # The success row for this attempt already autocommitted (SQLite
            # isolation_level=None). A failure past this point amends that
            # row so one attempt still leaves exactly one record, instead of
            # appending a second, contradicting row for the same attempt.
            calibration.update_run(run_id, calibration.STATUS_FAILED, message=str(error))
        else:
            calibration.record_run(
                side, 'cap', calibration.STATUS_FAILED, trigger,
                started_at=started_at, duration_ms=_elapsed_ms(), message=str(error),
            )
        raise


def calibrate_both_sides():
    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(hours=14)
    logger.info(
        f'No args passed to calibrate_sensor_thresholds.py, calibrating for the last 14 hours... {start_time.isoformat()} -> {end_time.isoformat()}')

    calibrate_sensor_thresholds(
        'left',
        start_time,
        end_time,
        FOLDER_PATH,
    )
    calibrate_sensor_thresholds(
        'right',
        start_time,
        end_time,
        FOLDER_PATH,
    )


def update_health_both_sides(status: str, message: str):
    update_health('calibrateLeft', status, message)
    update_health('calibrateRight', status, message)


def _is_anyone_currently_present() -> Union[bool, None]:
    """Returns True if either side is currently occupied per the live stream.

    The live presence detector (stream_processor / biometric_processor) is
    much more reliable than identify_baseline_period: it uses dual-piezo
    where available, the cross-side dominance arbiter, and a 3-min stillness
    grace. So if it says someone is on the bed right now, we should trust it
    and skip calibration, calibrating against a still person produces a
    baseline that's offset toward "present" and tanks subsequent detection.

    Returns True if occupied, False if empty, None if the API is unreachable.
    """
    try:
        with urllib.request.urlopen('http://127.0.0.1:3000/api/metrics/presence', timeout=5) as r:
            data = json.load(r)
        return bool(data.get('left', {}).get('present')) or bool(data.get('right', {}).get('present'))
    except Exception as err:
        logger.warning(f'Could not reach presence API: {err}')
        return None


if __name__ == "__main__":
    try:
        if not is_biometrics_enabled():
            logger.warning('Not analyzing sleep, biometrics is disabled')

        logger.debug(f"START Free Memory: {get_available_memory_mb()} MB")
        logger.debug(f"START Memory Usage: {get_memory_usage_unix():.2f} MB")
        if get_available_memory_mb() < 400:
            raise MemoryError('Available memory is too little, exiting...')

        if logger.env == 'prod':
            args = _parse_args()
        else:
            # DEBUGGING
            date = '2025-01-20'
            FOLDER_PATH = f'/Users/ds/main/8sleep_biometrics/data/people/david/raw/loaded/{date}/'
            args = Namespace(
                side="right",
                start_time=datetime.strptime(f'{date} 07:00:00', '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc),
                end_time=datetime.strptime(f'{date} 15:00:00', '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc),
                force=False,
            )

        # Bail before doing anything if the bed is occupied right now. The daily
        # cron runs at 17:00/17:30 PDT, when someone may already be in bed.
        # identify_baseline_period can be fooled by a still person, producing
        # a baseline offset toward "present" and breaking detection.
        # --force (user-initiated runs) skips this: the user has confirmed the
        # bed is empty, and a latched false "present" would otherwise block
        # calibration forever.
        if args.force:
            logger.info('--force given: skipping the bed-occupancy guard.')
        else:
            occupied = _is_anyone_currently_present()
            if occupied is True:
                # Skipping here is the guard doing its job, not a failure:
                # leave the job status alone so the last real run's outcome
                # keeps showing (mirrors the occupied-is-None branch below,
                # which also proceeds without touching status). Reporting
                # this as 'failed' used to leave the Status page stuck on
                # "needs attention" for up to 24h, until the next scheduled
                # window happened to find the bed empty.
                msg = 'Bed is currently occupied, skipping calibration to avoid corrupting the baseline.'
                logger.warning(msg)
                sides_skipped = [args.side] if args.side is not None else ['left', 'right']
                for skipped_side in sides_skipped:
                    calibration.record_run(
                        skipped_side, 'cap', calibration.STATUS_SKIPPED_OCCUPIED, calibration.TRIGGER_DAILY,
                        started_at=int(time.time()), duration_ms=0,
                        message='Someone was on the bed at the scheduled time, so calibration was skipped.',
                    )
                sys.exit(0)
            elif occupied is None:
                logger.warning('Presence API unreachable, proceeding with calibration anyway.')

        if args.side is None:
            update_health_both_sides('started', '')
            calibrate_both_sides()
            update_health_both_sides('healthy', '')
        else:
            job_key = f"calibrate{args.side.capitalize()}"
            update_health(job_key, 'started', '')
            calibrate_sensor_thresholds(
                args.side,
                args.start_time,
                args.end_time,
                FOLDER_PATH,
            )
            update_health(job_key, 'healthy', '')

    except KeyboardInterrupt:
        logger.info('Keyboard interrupt signal received, exiting...')
        if 'job_key' in locals():
            update_health(job_key, 'failed', 'Interrupted')
        else:
            update_health_both_sides('failed', 'Interrupted')
    except Exception as error:
        # Insufficient-data conditions (fresh install, no empty-bed window yet)
        # report the calm 'waiting_for_data' state; everything else stays a
        # 'failed' outcome, logged with its stack as before.
        status, message = outcome_for_exception(error)
        if status == 'failed':
            logger.error(error)
            stack = traceback.format_exc()
            logger.error(stack)
            logger.error('Error calibrating sensors, exiting...')
        else:
            logger.info(message)
        if 'job_key' in locals():
            update_health(job_key, status, message)
        else:
            update_health_both_sides(status, message)

