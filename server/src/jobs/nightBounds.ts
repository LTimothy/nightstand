import moment from 'moment-timezone';
import type { Schedules, Side } from '../db/schedulesSchema.js';
import { SCHEDULE_DAYS } from '../db/scheduleKeys.js';
import type { Night } from './firmwareTimer.js';
import { scheduleWrapsToNextDay } from './utils.js';

export function nightBounds(date: moment.Moment, power: { on: string; off: string }) {
  const [onHour, onMinute] = power.on.split(':').map(Number);
  const [offHour, offMinute] = power.off.split(':').map(Number);
  const start = date.clone().startOf('day').hour(onHour).minute(onMinute);
  const end = date.clone().startOf('day');
  if (scheduleWrapsToNextDay(power)) end.add(1, 'day');
  end.hour(offHour).minute(offMinute);
  return { start, end };
}

// Today's night, or the one that began yesterday, if the schedule has it running now.
export function runningNight(schedules: Schedules, side: Side, now: Date, timeZone: string): Night | null {
  let found: Night | null = null;
  for (const daysAgo of [1, 0]) {
    const anchor = moment.tz(now, timeZone).subtract(daysAgo, 'day');
    const day = SCHEDULE_DAYS[anchor.day()];
    const power = schedules[side]?.[day]?.power;
    if (!power?.enabled) continue;
    const { start, end } = nightBounds(anchor, power);
    if (!start.isAfter(now) && end.isAfter(now)) found = { day, start: start.toDate() };
  }
  return found;
}
