// One place that answers what the schedule says for either engine. Rhythms
// answers come from the data the last rebuild activated.
import moment from 'moment-timezone';
import settingsDB from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import type { Settings } from '../db/settingsSchema.js';
import type { Side } from '../db/schedulesSchema.js';
import { SCHEDULE_DAYS } from '../db/scheduleKeys.js';
import { compareTimes, isValidTime } from './utils.js';
import type { Activation } from './rhythms/activation.js';
import { resolveLegacySleeps, resolveSleeps, type ResolvedSleep, type RhythmEvent } from './rhythms/resolve.js';
import { smartResolveHooks } from './rhythms/curveController.js';
import { runningNight } from './nightBounds.js';

const HOUR_MS = 60 * 60 * 1000;
const CHANGE_LOOKAHEAD_MS = 48 * HOUR_MS;
const TEMPERATURE_LOOKAHEAD_MS = 7 * 24 * HOUR_MS;

let engine: Activation = { active: false, reason: 'flag-off' };

export function setEngineActivation(next: Activation): void {
  engine = next;
}

export function engineActivation(): Activation {
  return engine;
}

function otherSide(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

// An away side drives nothing; a present side next to an away side drives the whole bed.
export function effectiveSides(settings: Settings, side: Side): Side[] {
  if (settings[side].awayMode) return [];
  return settings[otherSide(side)].awayMode ? [side, otherSide(side)] : [side];
}

export function drivingSide(settings: Settings, side: Side): Side | null {
  if (!settings[side].awayMode) return side;
  return settings[otherSide(side)].awayMode ? null : otherSide(side);
}

function podTimeZone(): string {
  return settingsDB.data.timeZone || 'UTC';
}

// Weekly engine: yesterday's schedule is included because its after-midnight rows run today.
function legacyNextTempChange(side: Side, now: moment.Moment, timeZone: string): moment.Moment | null {
  const sideSchedule = schedulesDB.data[side];
  if (!sideSchedule) return null;
  let next: moment.Moment | null = null;
  for (let dayOffset = -1; dayOffset < 2; dayOffset++) {
    const candidateDay = now.clone().tz(timeZone).add(dayOffset, 'day');
    const daily = sideSchedule[SCHEDULE_DAYS[candidateDay.day()]];
    if (!daily?.power.enabled || !daily.temperatures) continue;
    // Power-on applies a temperature too, even when there are no later adjustments.
    const times = new Set([daily.power.on, ...Object.keys(daily.temperatures)]);
    for (const time of times) {
      if (!isValidTime(time)) continue;
      const [h, m] = time.split(':').map(Number);
      const candidate = candidateDay.clone().hour(h).minute(m).second(0).millisecond(0);
      if (compareTimes(time, daily.power.on) < 0) candidate.add(1, 'day');
      if (candidate.isAfter(now) && (!next || candidate.isBefore(next))) next = candidate;
    }
  }
  return next;
}

function rhythmSleeps(side: Side, from: Date, to: Date): ResolvedSleep[] | null {
  if (!engine.active) return null;
  const driver = drivingSide(settingsDB.data, side);
  if (!driver) return [];
  return resolveSleeps({ db: engine.db, side: driver, timeZone: podTimeZone(), from, to, ...smartResolveHooks });
}

function scheduledSleeps(side: Side, from: Date, to: Date): ResolvedSleep[] {
  return rhythmSleeps(side, from, to)
    ?? resolveLegacySleeps({ schedules: schedulesDB.data, side, timeZone: podTimeZone(), from, to });
}

function setsTemperature(event: RhythmEvent): event is Extract<RhythmEvent, { kind: 'power-on' | 'temperature' }> {
  return event.kind === 'power-on' || event.kind === 'temperature';
}

export function currentSleep(side: Side, now: Date): ResolvedSleep | null {
  const t = now.getTime();
  return scheduledSleeps(side, now, now).find(sleep => sleep.start.getTime() <= t && t < sleep.end.getTime()) ?? null;
}

// The sleep containing `at`, its end instant included; where one sleep ends
// as the next starts, the earlier one wins, as the weekly override lookup does.
export function sleepAround(side: Side, at: Date): ResolvedSleep | null {
  const t = at.getTime();
  return scheduledSleeps(side, at, at).find(sleep => sleep.start.getTime() <= t && t <= sleep.end.getTime()) ?? null;
}

export function isInScheduledSleep(side: Side, now: Date): boolean {
  if (!engine.active) return runningNight(schedulesDB.data, side, now, podTimeZone()) !== null;
  return currentSleep(side, now) !== null;
}

export function nextScheduledChange(side: Side, now: Date): Date | null {
  if (!engine.active) {
    const timeZone = podTimeZone();
    return legacyNextTempChange(side, moment.tz(now, timeZone), timeZone)?.toDate() ?? null;
  }
  let next: Date | null = null;
  for (const sleep of rhythmSleeps(side, now, new Date(now.getTime() + CHANGE_LOOKAHEAD_MS)) ?? []) {
    for (const event of sleep.events) {
      if (!setsTemperature(event) || event.at.getTime() <= now.getTime()) continue;
      if (!next || event.at.getTime() < next.getTime()) next = event.at;
    }
  }
  return next;
}

// The temperature the schedule has the side at now, or the next sleep's
// power-on temperature when no sleep is in progress.
export function scheduledTemperatureNow(side: Side, now: Date): number | null {
  const t = now.getTime();
  const upcoming = scheduledSleeps(side, now, new Date(t + TEMPERATURE_LOOKAHEAD_MS))
    .filter(sleep => t < sleep.end.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
  if (!upcoming) return null;
  const temperatureEvents = upcoming.events.filter(setsTemperature);
  if (temperatureEvents.length === 0) return upcoming.night.power.onTemperature;
  const applied = temperatureEvents.filter(event => event.at.getTime() <= t);
  return (applied[applied.length - 1] ?? temperatureEvents[0]).temperatureF;
}
