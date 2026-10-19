import moment from 'moment-timezone';
import { MAX_ON_DURATION_SECONDS } from '../routes/deviceStatus/deviceStatusSchema.js';
import type { DayOfWeek, Side } from '../db/schedulesSchema.js';
import { ALARM_LATE_LIMIT_MS, alarmDueBetween } from './alarmActivity.js';

// Same margin Rhythms gives the firmware: the scheduled power-off normally
// runs first, and the firmware's own timer is the backstop if it cannot.
export const WEEKLY_FIRMWARE_MARGIN_SECONDS = 300;

// The next `off` (HH:mm in timeZone) after `now`.
export function nextScheduledOff(now: Date, off: string, timeZone: string): Date {
  const [hour, minute] = off.split(':').map(Number);
  const local = moment.tz(now, timeZone);
  let at = local.clone().set({ hour, minute, second: 0, millisecond: 0 });
  if (!at.isAfter(local)) at = at.add(1, 'day');
  return at.toDate();
}

// Whole seconds of on time from `now` to `until`, between 1 and the firmware
// maximum. An end that is not a time gets the maximum.
export function firmwareSecondsUntil(until: Date, now: Date): number {
  const seconds = Math.ceil((until.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return MAX_ON_DURATION_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_ON_DURATION_SECONDS);
}

// An alarm due just before the off can start up to ALARM_LATE_LIMIT_MS late
// and ring for up to 300 s, so the firmware waits that long for it.
export const ALARM_FIRMWARE_MARGIN_SECONDS = ALARM_LATE_LIMIT_MS / 1000 + 300;

// When the firmware should end a weekly night that the schedule ends at offAt.
export function weeklyFirmwareEnd(side: Side, offAt: Date): Date {
  const alarmNear = alarmDueBetween(side, new Date(offAt.getTime() - ALARM_LATE_LIMIT_MS), offAt);
  const margin = alarmNear ? ALARM_FIRMWARE_MARGIN_SECONDS : WEEKLY_FIRMWARE_MARGIN_SECONDS;
  return new Date(offAt.getTime() + margin * 1000);
}

export type Night = { day: DayOfWeek; start: Date };

// The weekly night whose end this process last gave each side's firmware.
const armedNights = new Map<Side, Night & { until: number }>();

export const armedNight = (side: Side) => armedNights.get(side);
export const forgetWeeklyArmed = (side: Side) => armedNights.delete(side);
// Test isolation only.
export const resetWeeklyArmed = () => armedNights.clear();

export function noteWeeklyArmed(side: Side, day: DayOfWeek, start: Date, until: Date): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(until.getTime())) return;
  armedNights.set(side, { day, start, until: until.getTime() });
}
