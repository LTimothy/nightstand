import { useMemo } from 'react';
import moment from 'moment-timezone';

import { useAppStore } from '@state/appStore.tsx';
import { useSleepRecords } from '@api/sleep.ts';
import { useSettings } from '@api/settings.ts';
import { formatSleepDuration, recordForNight } from '../DataPage/SleepPage/sleepContext.ts';

export type LastNight = {
  // Such as "7h 12m in bed".
  duration: string;
};

// The selected side's last night's time in bed, or undefined while loading or
// when there is no night.
export function useLastNight(): LastNight | undefined {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  // Unset means UTC, as on the Sleep page; wait only while settings load.
  const timeZone = settings ? settings.timeZone ?? 'UTC' : undefined;

  // Fetch the most recent sleep record from the last 36 hours. Computed once
  // per mount, not on every render: useSleepRecords keys its query on this
  // params object, so recomputing "now" on every render would generate a
  // new query key (and a new network request) every single render.
  const { startTime, endTime } = useMemo(() => ({
    startTime: moment().subtract(36, 'hours').toISOString(),
    endTime: moment().toISOString(),
  }), []);
  const { data: records } = useSleepRecords({ side, startTime, endTime });
  // Same pick as the Sleep page: the longest record of the newest wake date.
  const last = useMemo(() => {
    if (!timeZone || !records) return undefined;
    const newest = [...records].sort((a, b) => Date.parse(b.left_bed_at) - Date.parse(a.left_bed_at))[0];
    return newest && recordForNight(records, moment.tz(newest.left_bed_at, timeZone).format('YYYY-MM-DD'), timeZone);
  }, [records, timeZone]);

  if (!last || last.sleep_period_seconds <= 0) return undefined;
  return { duration: `${formatSleepDuration(last.sleep_period_seconds)} in bed` };
}
