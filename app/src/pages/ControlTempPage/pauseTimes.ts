import moment from 'moment-timezone';
import type { DayOfWeek } from '@api/schedulesSchema';
import { rhythmNightBounds } from '@api/rhythmTimes';
import { nightBounds } from '@lib/nightBounds';
import { nextBedEvent, type BedSchedule } from './bedEvents';
import { currentSleep } from './sleepEvents';
import type { BedSleeps } from './useBedSleeps';

export const MAX_PAUSE_DAYS = 14;
// Same fallback as the rest of the app when the Pod's time zone is unset.
const UNSET_ZONE = 'UTC';
const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors PAUSE_RESUME_DELAY_MS in server/src/jobs/pauseResume.ts.
const PAUSE_RESUME_DELAY_MS = 60 * 1000;

// When the side next powers on or off after a moment: from the weekly
// schedule, or from the resolved sleeps while Rhythms runs.
export type NextBedTime = (after: moment.Moment, kind: 'on' | 'off') => moment.Moment | undefined;

export const weeklyTimes = (schedule: BedSchedule, timeZone: string): NextBedTime =>
  (after, kind) => nextBedEvent(schedule, timeZone, after, kind)?.at;

// Predict the pause end only when the delayed resume stays inside the night.
export function pauseResumeAt(
  bed: BedSleeps, schedule: BedSchedule | undefined, timeZone: string, end: moment.Moment,
): moment.Moment | undefined {
  if (!timeZone) return undefined;
  const local = end.clone().tz(timeZone);
  const resume = local.clone().add(PAUSE_RESUME_DELAY_MS, 'ms');
  if (bed.state === 'rhythms') {
    const sleep = currentSleep(bed.sleeps, resume.toDate());
    if (!sleep?.events.some(event => event.kind === 'power-on') || local.isBefore(moment(sleep.start))) return undefined;
    // When I get up can extend a sleep, but resume stops at its scheduled off.
    if (sleep.offWhenUp && !resume.isBefore(rhythmNightBounds(sleep.date, sleep.night.power, timeZone).end)) return undefined;
    return local;
  }
  if (bed.state !== 'legacy' || !schedule) return undefined;
  for (const daysAgo of [1, 0]) {
    const date = resume.clone().subtract(daysAgo, 'day');
    const power = schedule[date.format('dddd').toLowerCase() as DayOfWeek]?.power;
    if (!power?.enabled) continue;
    const bounds = nightBounds(date, power);
    if (local.isSameOrAfter(bounds.start) && resume.isBefore(bounds.end)) return local;
  }
  return undefined;
}

// Tonight's power off when one is due within a day. Otherwise noon: today
// before 6 AM, when tonight is still going, and tomorrow after that.
export function tonightOnlyEndWith(next: NextBedTime, timeZone: string, now = moment.tz(timeZone || UNSET_ZONE)): moment.Moment {
  const zone = timeZone || UNSET_ZONE;
  const local = now.clone().tz(zone);
  const off = next(local, 'off');
  if (off && off.diff(local) <= DAY_MS) return off;
  const noon = local.clone().startOf('day').hour(12);
  return local.hour() < 6 ? noon : noon.add(1, 'day');
}

// The side's next bedtime after a "Tonight only" pause would end.
export function setTimeDefaultWith(next: NextBedTime, timeZone: string, now = moment.tz(timeZone || UNSET_ZONE)): moment.Moment {
  const tonight = tonightOnlyEndWith(next, timeZone, now);
  return next(tonight, 'on') ?? tonight.clone().add(1, 'day');
}

export function tonightOnlyEnd(schedule: BedSchedule, timeZone: string, now = moment.tz(timeZone || UNSET_ZONE)): moment.Moment {
  return tonightOnlyEndWith(weeklyTimes(schedule, timeZone || UNSET_ZONE), timeZone, now);
}

export function setTimeDefault(schedule: BedSchedule, timeZone: string, now = moment.tz(timeZone || UNSET_ZONE)): moment.Moment {
  return setTimeDefaultWith(weeklyTimes(schedule, timeZone || UNSET_ZONE), timeZone, now);
}

export function formatPauseEnd(end: moment.Moment, timeZone: string, now = moment.tz(timeZone || UNSET_ZONE)): string {
  const zone = timeZone || UNSET_ZONE;
  const local = end.clone().tz(zone);
  const today = now.clone().tz(zone);
  const time = local.format('h:mm A');
  if (local.isSame(today, 'day')) return `${time} today`;
  if (local.isSame(today.clone().add(1, 'day'), 'day')) return `${time} tomorrow`;
  return local.format('ddd, MMM D [at] h:mm A');
}

export function pauseEndError(end: moment.Moment, now: moment.Moment): string | null {
  if (!end.isAfter(now)) return 'Pick a time in the future';
  if (end.diff(now) > MAX_PAUSE_DAYS * DAY_MS) return 'Pick a time within 14 days';
  return null;
}
