"""
Analyze one side's sleep for a time window: load RAW sensor data, find time in
bed and movement, write sleep_records and movement, and record the run in
analysis_runs.

Usage (on the Pod the server runs this daily and from the Status page):
    /home/dac/venv/bin/python -B analyze_sleep.py --side=left --start_time=2026-09-28T19:00:00Z --end_time=2026-09-29T20:00:00Z

Off the Pod, set DATA_FOLDER to a folder holding free-sleep.db, lowdb/ and
raw-archive/.
"""

import gc
import os
import sqlite3
import sys
import time
from argparse import ArgumentParser, Namespace
from datetime import datetime, timezone
from typing import Tuple

sys.path.append(os.getcwd())
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Live RAW files; the archive under the data folder is read as well.
FOLDER_PATH = '/persistent/'
MIN_AVAILABLE_MB = 400

from get_logger import get_logger
# This must run before the other local import in order to set up the logger
logger = get_logger('sleep-analyzer')

import analysis_runs
from db import replace_analysis_results, widen_window
from sleep_detector import detect_sleep, detect_movement
from resource_usage import get_memory_usage_unix, get_available_memory_mb, get_peak_rss_mb
from biometrics_helpers import validate_datetime_utc
from service_health import update_health, is_biometrics_enabled
from insufficient_data import outcome_for_exception, NO_SLEEP_MESSAGE


def _parse_args() -> Namespace:
    parser = ArgumentParser(description="Process presence intervals with UTC datetime.")
    parser.add_argument(
        "--side",
        choices=["left", "right"],
        required=True,
        help="Side of the bed to process (left or right)."
    )
    parser.add_argument(
        "--start_time",
        type=validate_datetime_utc,
        required=True,
        help="Start time in UTC format 'YYYY-MM-DD HH:MM:SS'."
    )
    parser.add_argument(
        "--end_time",
        type=validate_datetime_utc,
        required=True,
        help="End time in UTC format 'YYYY-MM-DD HH:MM:SS'."
    )
    args = parser.parse_args()
    if args.start_time >= args.end_time:
        raise ValueError("--start_time must be earlier than --end_time")
    return args


def run_analysis(side: str, start_time: datetime, end_time: datetime, folder_path: str, conn=None) -> Tuple[str, str]:
    """Analyze one window, record the attempt in analysis_runs, and return the
    (status, message) to show on the Status page."""
    started = time.monotonic()
    window_start = int(start_time.timestamp())
    window_end = int(end_time.timestamp())
    try:
        run_id = analysis_runs.start_run(side, analysis_runs.KIND_ANALYZE, window_start, window_end, conn=conn)
    except sqlite3.Error as error:
        logger.warning(f'Could not record the analysis run, continuing without it: {error}')
        run_id = None

    counts = {}
    error_text = None
    try:
        # Read the whole of any stored night this window overlaps, so the run
        # can replace it instead of leaving a truncated copy.
        wide_start, wide_end = widen_window(side, window_start, window_end)
        if (wide_start, wide_end) != (window_start, window_end):
            logger.info(f'Widening the window to {wide_start} -> {wide_end} to cover a stored night')
            window_start, window_end = wide_start, wide_end
            start_time = datetime.fromtimestamp(window_start, tz=timezone.utc)
            end_time = datetime.fromtimestamp(window_end, tz=timezone.utc)
            if run_id is not None:
                try:
                    analysis_runs.set_window(run_id, window_start, window_end, conn=conn)
                except Exception as error:
                    logger.warning(f'Could not record the widened window: {error}')
        if get_available_memory_mb() < MIN_AVAILABLE_MB:
            raise MemoryError('Available memory is too little, exiting...')
        merged_df, sleep_records, cap_df = detect_sleep(side, start_time, end_time, folder_path)
        counts['rows_loaded'] = int(merged_df.shape[0])
        del merged_df
        movement_rows = detect_movement(side, cap_df)
        del cap_df
        gc.collect()
        records_written, movement_written = replace_analysis_results(
            side, sleep_records, movement_rows, window_start, window_end)
        counts['records_written'] = records_written
        counts['movement_written'] = movement_written
        run_status = analysis_runs.STATUS_OK
        # No sleep found is not an error, but say so instead of a silent green.
        outcome = ('healthy', analysis_runs.summarize(counts) if sleep_records else NO_SLEEP_MESSAGE)
    except Exception as error:
        # No full night archived yet (fresh install) is the calm
        # 'waiting_for_data' state; everything else is a failure.
        outcome = outcome_for_exception(error)
        if outcome[0] == 'failed':
            run_status = analysis_runs.STATUS_FAILED
            error_text = repr(error)
            logger.error(error)
            logger.error('Error analyzing sleep')
        else:
            run_status = analysis_runs.STATUS_NO_DATA
            logger.info(outcome[1])

    if run_id is not None:
        try:
            analysis_runs.finish_run(
                run_id, run_status, conn=conn,
                duration_ms=int((time.monotonic() - started) * 1000),
                peak_rss_mb=get_peak_rss_mb(),
                error=error_text,
                **counts,
            )
        except Exception as error:
            logger.warning(f'Could not finish the analysis run record: {error}')
    return outcome


def main():
    args = _parse_args()
    job_key = f'analyzeSleep{args.side.capitalize()}'
    # An unreadable switch (None) runs the analysis; only an explicit off skips it.
    if is_biometrics_enabled() is False:
        logger.info('Not analyzing sleep, biometrics is disabled')
        update_health(job_key, 'failed', 'Biometrics is off')
        return

    logger.debug(f"START Free Memory: {get_available_memory_mb()} MB")
    logger.debug(f"START Memory Usage: {get_memory_usage_unix():.2f} MB")
    update_health(job_key, 'started', '')
    try:
        status, message = run_analysis(args.side, args.start_time, args.end_time, FOLDER_PATH)
    except KeyboardInterrupt:
        logger.info('Keyboard interrupt signal received, exiting...')
        update_health(job_key, 'failed', 'Interrupted')
        sys.exit(1)
    update_health(job_key, status, message)
    logger.debug(f"END Memory Usage: {get_memory_usage_unix():.2f} MB")
    logger.debug(f"END Free Memory: {get_available_memory_mb()} MB")


if __name__ == "__main__":
    main()
