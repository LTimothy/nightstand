"""Quality has to be able to see a thin calibration window.

The merged calibration frame carries the capacitive sensor's two rows per
second, so the inner merge duplicates every piezo row. That doubled every
sample count, and compute_quality's density term, which divides samples by
seconds, saturated at 1.0 for any window with more than 300 rows. A 397-row
window scored the same 0.167 as a 591-row one. The one input a consumer was
promised for refusing a bad profile did not vary.

Run on the pod (venv has numpy/pandas; the local Mac python may lack them):
    python3 -m unittest __tests__.test_floor_sample_density -v
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

import numpy as np
import pandas as pd

import calibration
from piezo_data import one_value_per_second, summarize_empty_floor


def _doubled(values, start='2026-09-05 19:15:00'):
    """A series shaped like the merged frame: each second's value twice."""
    idx = pd.date_range(start, periods=len(values), freq='1s', name='ts').repeat(2)
    return pd.Series(np.repeat(np.asarray(values, dtype=float), 2), index=idx)


class TestOneValuePerSecond(unittest.TestCase):
    def test_it_collapses_the_merge_duplicates(self):
        s = one_value_per_second(_doubled([10.0, 20.0, 30.0]))
        self.assertEqual(len(s), 3)
        self.assertEqual(list(s.values), [10.0, 20.0, 30.0])

    def test_it_leaves_an_already_unique_series_alone(self):
        idx = pd.date_range('2026-09-05 19:15:00', periods=3, freq='1s', name='ts')
        s = pd.Series([1.0, 2.0, 3.0], index=idx)
        out = one_value_per_second(s)
        self.assertEqual(len(out), 3)
        self.assertTrue(out.index.equals(idx))

    def test_it_keeps_the_index_so_the_window_can_still_be_sliced(self):
        s = one_value_per_second(_doubled([5.0, 6.0]))
        self.assertIsInstance(s.index, pd.DatetimeIndex)


class TestDuplicationDoesNotMoveTheFloor(unittest.TestCase):
    def test_summary_is_the_same_whether_or_not_rows_are_doubled(self):
        # Duplicating every value preserves the distribution, so collapsing the
        # duplicates must change the sample count and nothing else. If this
        # ever fails, stored floors from before and after the fix are not
        # comparable and the retained series has a step in it.
        rng = np.random.default_rng(7)
        values = rng.lognormal(mean=10.5, sigma=0.4, size=300)
        doubled = _doubled(values)
        single = one_value_per_second(doubled)

        a = summarize_empty_floor(doubled)
        b = summarize_empty_floor(single)

        self.assertEqual(a['samples'], 600)
        self.assertEqual(b['samples'], 300)
        for key in ('floor', 'min', 'max', 'mean'):
            self.assertAlmostEqual(a[key], b[key], delta=abs(b[key]) * 0.002, msg=key)
        for pct, val in b['percentiles'].items():
            self.assertAlmostEqual(a['percentiles'][pct], val, delta=abs(val) * 0.002, msg=pct)


class TestQualityCanSeeAThinWindow(unittest.TestCase):
    def test_a_full_window_scores_the_window_term_alone(self):
        # 300 distinct seconds in a 300s window: density 1.0, so quality is
        # exactly the window term (300 / 1800).
        q = calibration.compute_quality(300, 300, 300)
        self.assertAlmostEqual(q, 300 / calibration.TARGET_WINDOW_SECONDS)

    def test_a_thin_window_scores_lower_once_samples_are_distinct_seconds(self):
        # The 397-row night: 397 merged rows are about 199 distinct seconds.
        full = calibration.compute_quality(300, 300, 300)
        thin = calibration.compute_quality(300, 199, 300)
        self.assertLess(thin, full)
        self.assertAlmostEqual(thin / full, 199 / 300, places=3)

    def test_the_old_doubled_count_could_not_see_it(self):
        # Documents the defect: with doubled rows both nights saturate.
        self.assertEqual(
            calibration.compute_quality(300, 591, 300),
            calibration.compute_quality(300, 397, 300),
        )


if __name__ == '__main__':
    unittest.main()
