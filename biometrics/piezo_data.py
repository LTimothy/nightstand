import bisect
import gc
import math
import sys
import os
import pandas as pd
import numpy as np

sys.path.append(os.getcwd())
from data_types import *
from get_logger import get_logger
from insufficient_data import InsufficientDataError

logger = get_logger()


def _calculate_avg(arr: np.ndarray):
    return np.mean(arr)


def _calculate_p2p(arr: np.ndarray):
    """Percentile-based within-second waveform range (p98 - p2).

    Same quantity the live stream's presence detection uses
    (stream/biometric_processor.py _range_p98_p2): robust to int32
    sentinels/outliers, ~35-125k on an empty bed, 0.5M-8M whenever anyone
    is in the bed (either side - mechanical crosstalk also crosses the
    noise floor, which is why this metric alone cannot attribute
    occupancy to a side).
    """
    s = arr.astype(np.int64, copy=False)
    p2, p98 = np.percentile(s, [2, 98])
    return float(p98 - p2)


def load_piezo_df(data: Data, side: Side, lower_percentile=2, upper_percentile=98, expected_row_count=None, with_p2p=False) -> pd.DataFrame:
    logger.debug('Loading piezo df...')
    df = pd.DataFrame(data['piezo_dual'])
    df.sort_values(by='ts', inplace=True)
    df['ts'] = pd.to_datetime(df['ts'])
    df.set_index('ts', inplace=True)

    if df.empty:
        raise InsufficientDataError('No piezo rows found for the requested window (piezo_dual RAW data missing or not yet archived)')

    df[f'{side}1_avg'] = df[f'{side}1'].apply(_calculate_avg)
    # Compute the within-second p98-p2 range BEFORE the raw array column is
    # dropped below (the raw arrays are the memory-expensive part). The
    # avg-percentile row-trim just after retains this column on the same rows.
    if with_p2p:
        df[f'{side}1_p2p'] = df[f'{side}1'].apply(_calculate_p2p)

    lower_bound = np.percentile(df[f'{side}1_avg'], lower_percentile)
    upper_bound = np.percentile(df[f'{side}1_avg'], upper_percentile)
    df = df[(df[f'{side}1_avg'] >= lower_bound) & (df[f'{side}1_avg'] <= upper_bound)]

    df.drop(columns=[f'{side}1', 'type', 'freq', 'adc', 'gain'], inplace=True)
    logger.debug(f'Piezo rows loaded: {df.shape[0]:,}')
    if expected_row_count is not None:
        row_count = df.shape[0]
        if row_count / expected_row_count < 0.80:
            logger.warning(f'Potentially missing piezo rows! Expected: {expected_row_count:,} Loaded: {row_count:,} ({row_count / expected_row_count * 100:0.0f}%)')

    logger.debug(f'Loaded piezo df time range: {df.index[0]} -> {df.index[-1]}')
    return df


def detect_presence_piezo(df: pd.DataFrame, side: Side, rolling_seconds=10, threshold_percent=0.75, range_rolling_seconds=10, range_threshold=10_000,
                          clean=True):
    """Detects presence on a bed using piezo sensor data.

     The function determines when a person is present based on the sensor's range values.
     A rolling window approach is applied to check if the range exceeds a given threshold
     for a specified duration. Presence is marked when the threshold is met.

     Args:
         df (pd.DataFrame):
             The input DataFrame with a DatetimeIndex and columns `right1_avg` and `left1_avg` representing piezo sensor readings.
         rolling_seconds (int, optional):
             The duration (in seconds) for which presence is checked using a rolling sum. Defaults to 180.
         threshold_percent (float, optional):
             The percentage of time within `rolling_seconds` that the sensor range must exceed 10,000 to be considered present. Defaults to 0.75.
         range_rolling_seconds (int):
         clean (bool, optional):
             If True, drops intermediate computation columns from the DataFrame. Defaults to True.
     Returns:
         pd.DataFrame:
             The DataFrame with added `piezo_right1_presence` and `piezo_left1_presence` columns
             indicating presence (1) or absence (0) based on the rolling threshold.
     """
    logger.debug('Detecting piezo presence...')

    # Compute min/max range
    df[f'{side}1_min'] = df[f'{side}1_avg'].rolling(window=range_rolling_seconds, center=True).min()
    df[f'{side}1_max'] = df[f'{side}1_avg'].rolling(window=range_rolling_seconds, center=True).max()

    df[f'{side}1_range'] = df[f'{side}1_max'] - df[f'{side}1_min']

    # Apply presence detection
    df[f'piezo_{side}1_presence'] = (df[f'{side}1_range'] >= range_threshold).astype(int)

    threshold_count = math.ceil(threshold_percent * rolling_seconds)

    df[f"piezo_{side}1_presence"] = (
            df[f"piezo_{side}1_presence"]
            .rolling(window=range_rolling_seconds, min_periods=1)
            .sum()
            >= threshold_count
    ).astype(int)

    if clean:
        df.drop(
            columns=[
                f'{side}1_avg',
                f'{side}1_min',
                f'{side}1_max',
                f'{side}1_range',
            ],
            inplace=True
        )
    gc.collect()


def detect_presence_piezo_p2p(df: pd.DataFrame, side: Side, rolling_seconds=10,
                              threshold_percent=0.70, noise_threshold=150_000,
                              clean=True):
    """Detect presence from the per-second p98-p2 waveform range.

    Thresholds `{side}1_p2p` (produced by load_piezo_df(with_p2p=True)) against
    a fixed noise floor, then applies the same two-stage rolling-sum debounce as
    detect_presence_piezo. This measures the within-second signal amplitude,
    unlike detect_presence_piezo which thresholds second-to-second drift of the
    per-second MEAN (a DC offset that false-fires on pump cycling with an empty
    bed and carries no amplitude information).

    noise_threshold defaults to 150_000, the live stream's production
    NOISE_THRESHOLD (bumped 30k -> 100k -> 150k against observed empty-bed idle
    reaching ~110k with pump spikes; see biometric_processor.py:64-73). It
    answers "is anyone in the bed", NOT "is this side occupied": mechanical
    crosstalk through the mattress frame keeps a vacated side above this floor
    while the partner is still in bed, so when partners leave at different times
    the earlier riser's exit is still reported near the later riser's exit. That
    exit-attribution problem is out of scope here.

    Args:
        df (pd.DataFrame): DatetimeIndex frame with a `{side}1_p2p` column.
        rolling_seconds (int): Debounce window length in seconds.
        threshold_percent (float): Fraction of `rolling_seconds` that must be
            above noise_threshold to count as present.
        noise_threshold (int): Empty-vs-occupied p2p cutoff.
        clean (bool): If True, drops the `{side}1_p2p` and `{side}1_avg`
            intermediate columns, matching detect_presence_piezo's output shape.
    """
    logger.debug('Detecting piezo presence (p2p)...')

    df[f'piezo_{side}1_presence'] = (df[f'{side}1_p2p'] >= noise_threshold).astype(int)

    threshold_count = math.ceil(threshold_percent * rolling_seconds)

    df[f"piezo_{side}1_presence"] = (
            df[f"piezo_{side}1_presence"]
            .rolling(window=rolling_seconds, min_periods=1)
            .sum()
            >= threshold_count
    ).astype(int)

    if clean:
        df.drop(
            columns=[
                f'{side}1_p2p',
                f'{side}1_avg',
            ],
            inplace=True
        )
    gc.collect()


# Which percentile of the empty-window amplitude becomes the stored floor.
# Not the max: a five minute window is a few hundred samples, and one sensor
# glitch in it would otherwise set the floor for the whole day.
FLOOR_PERCENTILE = 95

_FLOOR_PERCENTILES = (50, 90, 95, 99)


def one_value_per_second(series: pd.Series) -> pd.Series:
    """Collapse the merge duplicates so each second contributes one sample.

    The calibration frame is an inner merge of the piezo frame (one row per
    second) with the capacitive frame (two rows per second, both genuine), so
    every piezo value appears twice. Duplicating every value leaves the
    percentiles where they were, but it doubles the sample count, and the
    quality score divides that count by seconds. A window with half its
    seconds missing therefore scored the same as a full one. Count seconds,
    not rows.
    """
    return series[~series.index.duplicated(keep='first')]


def summarize_empty_floor(p2p_values, percentile: int = FLOOR_PERCENTILE) -> dict:
    """Summarize the within-second piezo amplitude over a window believed empty.

    `p2p_values` is the `{side}1_p2p` column (see _calculate_p2p) restricted to
    the empty-bed window calibration already identifies. That column, not the
    `{side}1_range` one, is the quantity both presence detectors threshold, so
    it is the only one whose floor is comparable to their entry bar.

    The whole distribution is returned, not just the chosen percentile: the
    point of measuring before consuming is to find out whether this number is
    stable night to night, and a single stored scalar cannot answer that.
    `floor_percentile` travels with the value so a floor measured under one
    rule is never silently compared against one measured under another.
    """
    values = np.asarray(p2p_values, dtype=np.float64).ravel()
    # A rolling window or a merge gap leaves NaN, and one NaN makes every
    # numpy percentile NaN. That would store a null floor that still reads as
    # "measured" to anything looking at the row rather than the value.
    values = values[np.isfinite(values)]
    if values.size == 0:
        raise InsufficientDataError(
            'The empty-bed window held no usable piezo samples, so there is '
            'nothing to measure a floor from.'
        )

    percentiles = {
        f'p{p}': float(np.percentile(values, p)) for p in _FLOOR_PERCENTILES
    }
    # float()/int() rather than the numpy scalars: save_profile json.dumps()
    # this payload, and numpy scalars are not JSON serializable.
    return {
        'floor': float(np.percentile(values, percentile)),
        'floor_percentile': int(percentile),
        'percentiles': percentiles,
        'min': float(values.min()),
        'max': float(values.max()),
        'mean': float(values.mean()),
        'std': float(values.std()),
        'samples': int(values.size),
    }


def identify_baseline_period(merged_df: pd.DataFrame, side: str, threshold_range: int = 10_000, empty_minutes: int = 5,
                             occupied_lookup=None):
    """Find a stretch this side's sensors agree was empty.

    `occupied_lookup(start_ts, end_ts)` returns the epoch seconds when EITHER
    side of the bed recorded vitals, and any candidate window containing one is
    rejected. It takes a lookup rather than a ready-made list so the range is
    derived from the frame being searched: `load_raw_files` returns whole
    15-minute RAW files, so the frame reliably begins BEFORE the window that
    was requested, and the first candidates considered live in that margin. A
    list built from the requested range leaves exactly those unchecked, which
    is how a window holding two vitals rows was once accepted. Without it,
    the search reads only this side's own range and capacitive stability, so a
    side can learn its empty-bed baseline from a stretch where the partner was
    in bed and their movement was coupling through the mattress frame. The
    run-time occupancy guard does not cover this: it is whole-bed but asks
    about the present moment, while the window is chosen from hours of history.

    Finding nothing is a valid answer. Calibrating against an occupied bed is
    the failure this exists to prevent, so an entirely occupied load returns
    (None, None) rather than falling back to the least bad window.
    """
    logger.debug('Finding baseline period...')
    merged_df = merged_df.sort_index()  # Ensure the index is sorted

    range_column = f'{side.lower()}1_range'
    stability_columns = [f'{side.lower()}_out', f'{side.lower()}_cen', f'{side.lower()}_in']

    # Sorted once here rather than trusted from the caller: the lookup below
    # bisects, and an unsorted list would miss hits instead of erroring.
    occupied = []
    if occupied_lookup is not None and len(merged_df) > 0:
        occupied = sorted(occupied_lookup(
            int(merged_df.index[0].timestamp()),
            int(merged_df.index[-1].timestamp()),
        ))

    # Iterate over time chunks (efficient early exit)
    window_size = pd.Timedelta(f'{empty_minutes}min')

    for start_time in merged_df.index:
        end_time = start_time + window_size

        # Ensure non-overlapping window
        window_df = merged_df.loc[(merged_df.index >= start_time) & (merged_df.index < end_time)]

        if len(window_df) == 0:
            continue  # Skip if no data

        # Condition 0: nobody was in the bed, on either side, during this window
        if occupied:
            position = bisect.bisect_left(occupied, int(start_time.timestamp()))
            if position < len(occupied) and occupied[position] < int(end_time.timestamp()):
                continue

        # Condition 1: Max range values must be < threshold_range
        if window_df[range_column].max() >= threshold_range:
            continue

        # Condition 2: Std must be ≤ 5% of mean for stability columns
        rolling_std = window_df[stability_columns].std()
        rolling_mean = window_df[stability_columns].mean()

        # Handle division by zero
        ratio = np.where(rolling_mean != 0, rolling_std / rolling_mean, 0)

        if (ratio > 0.05).any():
            continue  # If any column exceeds the threshold, skip

        # If both conditions are met, return the first valid interval
        logger.debug(f"First valid interval: {start_time} to {end_time}")
        return start_time, end_time

    logger.debug("No valid baseline period found.")
    return None, None
