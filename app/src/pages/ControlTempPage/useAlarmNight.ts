import moment from 'moment-timezone';
import type { Side } from '@state/appStore';
import { useSchedules } from '@api/schedules.ts';
import { useSettings } from '@api/settings.ts';
import { nextAlarmNight } from './AlarmNight';
import { alarmNightFromSleeps } from './sleepEvents';
import { useBedSleeps } from './useBedSleeps';

// The next night with a recurring alarm, once everything it depends on has loaded.
export function useAlarmNight(side: Side) {
  const { data: schedules } = useSchedules();
  const { data: settings } = useSettings();
  const bed = useBedSleeps(side);
  if (!settings) return { ready: false, night: undefined };
  if (settings[side].alarmsEnabled === false || settings[side].awayMode) return { ready: true, night: undefined };
  const override = settings[side].scheduleOverrides.alarm;
  const searchFrom = moment.tz(settings.timeZone);
  if (bed.state === 'rhythms') return { ready: true, night: alarmNightFromSleeps(bed.sleeps, settings.timeZone, searchFrom, override) };
  if (bed.state === 'legacy' && schedules) {
    return { ready: true, night: nextAlarmNight(schedules[side], settings.timeZone, searchFrom, override) };
  }
  return { ready: false, night: undefined };
}
