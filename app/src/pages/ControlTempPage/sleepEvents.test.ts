import { expect, it } from 'vitest';
import moment from 'moment-timezone';
import type { ResolvedSleepResponse, SleepEvent } from '@api/rhythmsResponse';
import { buildCurve } from '@api/smartCurve';
import {
  alarmNightFromSleeps, currentSleep, isEveningSleep, nextSleepEvent, pauseOptionLabel, scheduledTemperatureFromSleeps, skipLine,
  preWarms, skippedFromSleeps, sleepAt, warmStartBedtime, withArticle,
} from './sleepEvents';

const TZ = 'UTC';
const alarm = { time: '06:30', enabled: true, vibrationIntensity: 30, vibrationPattern: 'rise' as const, duration: 30, alarmTemperature: 83 };
const sleep = (date: string, start: string, end: string, extra: SleepEvent[] = []): ResolvedSleepResponse => ({
  side: 'left', date, rhythmId: 'workday', start, end, mode: 'manual',
  night: { power: { on: '22:00', off: '07:00', onTemperature: 80, enabled: true }, temperatures: {}, alarm, alarms: [alarm] },
  events: [{ kind: 'power-on', at: start, temperatureF: 80 }, ...extra, { kind: 'power-off', at: end }],
});
const sleeps = [
  sleep('2026-09-28', '2026-09-28T22:00:00.000Z', '2026-09-29T07:00:00.000Z', [
    { kind: 'temperature', at: '2026-09-29T01:00:00.000Z', temperatureF: 75 },
    { kind: 'alarm', at: '2026-09-29T06:30:00.000Z', alarm, index: 0 },
    { kind: 'alarm', at: '2026-09-29T06:45:00.000Z', alarm: { ...alarm, time: '06:45', enabled: false }, index: 1 },
  ]),
  sleep('2026-09-30', '2026-09-30T22:00:00.000Z', '2026-10-01T07:00:00.000Z'),
];
const at = (iso: string) => moment.tz(iso, TZ);

it('finds the next power or temperature change', () => {
  expect(nextSleepEvent(sleeps, TZ, at('2026-09-28T12:00:00Z'))).toMatchObject({ kind: 'on', temperature: 80 });
  expect(nextSleepEvent(sleeps, TZ, at('2026-09-28T12:00:00Z'), 'off')?.at.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  expect(nextSleepEvent(sleeps, TZ, at('2026-09-29T00:00:00Z'))).toMatchObject({ kind: 'temperature', temperature: 75 });
  expect(nextSleepEvent(sleeps, TZ, at('2026-09-29T02:00:00Z'))?.kind).toBe('off');
  expect(nextSleepEvent(sleeps, TZ, at('2026-10-02T00:00:00Z'))).toBeUndefined();
});

it('knows the sleep in progress', () => {
  expect(currentSleep(sleeps, new Date('2026-09-29T02:00:00Z'))?.date).toBe('2026-09-28');
  expect(currentSleep(sleeps, new Date('2026-09-29T12:00:00Z'))).toBeUndefined();
});

it('starts a manual power-on at the temperature the sleep has now', () => {
  expect(scheduledTemperatureFromSleeps(sleeps, new Date('2026-09-28T12:00:00Z'))).toBe(80);
  expect(scheduledTemperatureFromSleeps(sleeps, new Date('2026-09-29T02:00:00Z'))).toBe(75);
  expect(scheduledTemperatureFromSleeps(sleeps, new Date('2026-10-02T00:00:00Z'))).toBeUndefined();
});

it('finds the next night with an enabled alarm and keeps a night with a per-night override', () => {
  const night = alarmNightFromSleeps(sleeps, TZ, at('2026-09-28T12:00:00Z'));
  expect(night?.start.toISOString()).toBe('2026-09-28T22:00:00.000Z');
  expect(night?.alarms.map(item => item.at.toISOString())).toEqual(['2026-09-29T06:30:00.000Z']);
  expect(alarmNightFromSleeps(sleeps, TZ, at('2026-09-29T06:40:00Z'))).toBeUndefined();
  const overridden = alarmNightFromSleeps(sleeps, TZ, at('2026-09-29T06:40:00Z'), { expiresAt: '2026-09-29T06:50:00Z' });
  expect(overridden?.alarms[0].alarm.time).toBe('06:30');
});

it('skips a Smart Schedule step that repeats the level', () => {
  const repeated = { events: [
    { kind: 'power-on', at: '2026-09-29T05:00:00.000Z', temperatureF: 88 },
    { kind: 'temperature', at: '2026-09-29T05:30:00.000Z', temperatureF: 88 },
    { kind: 'temperature', at: '2026-09-29T05:40:00.000Z', temperatureF: 88 },
    { kind: 'temperature', at: '2026-09-29T05:55:00.000Z', temperatureF: 85 },
    { kind: 'power-off', at: '2026-09-29T13:45:00.000Z' },
  ] } as unknown as ResolvedSleepResponse;
  const next = nextSleepEvent([repeated], 'UTC', moment.utc('2026-09-29T05:10:00Z'));
  expect(next?.at.toISOString()).toBe('2026-09-29T05:55:00.000Z');
  expect(next?.temperature).toBe(85);
});

it('finds the sleep an instant belongs to, its end included', () => {
  expect(sleepAt(sleeps, new Date('2026-09-29T07:00:00Z'))?.date).toBe('2026-09-28');
  expect(sleepAt(sleeps, new Date('2026-09-29T07:00:01Z'))).toBeUndefined();
});

const smartSleep = (baseLevel: number, warmStart: boolean, points?: unknown[]): ResolvedSleepResponse => {
  const smart = { baseLevel, intensity: 'standard' as const, warmStart, warmUp: true, upEarly: false };
  const bedtime = new Date('2026-09-28T22:30:00Z');
  const wake = new Date('2026-09-29T06:30:00Z');
  const powerOff = new Date('2026-09-29T06:45:00Z');
  const curve = buildCurve({ smart, bedtime, coolStart: bedtime, wake, powerOff, timeZone: TZ });
  return {
    ...sleep('2026-09-28', curve[0].at.toISOString(), powerOff.toISOString()), mode: 'smart', smart,
    smartCurve: {
      bedtime: bedtime.toISOString(), coolStart: bedtime.toISOString(), wake: wake.toISOString(), daySleep: false,
      points: points ?? curve.map(point => ({ at: point.at.toISOString(), level: point.level, phase: point.phase })),
    },
  } as ResolvedSleepResponse;
};

it('names the bedtime for any pre-warm and flags warming only above neutral', () => {
  expect(warmStartBedtime(smartSleep(0, true), TZ)?.toISOString()).toBe('2026-09-28T22:30:00.000Z');
  expect(warmStartBedtime(smartSleep(-7, true), TZ)?.toISOString()).toBe('2026-09-28T22:30:00.000Z');
  expect(preWarms(smartSleep(0, true))).toBe(true);
  expect(preWarms(smartSleep(-7, true))).toBe(false);
  expect(preWarms(undefined)).toBe(false);
  expect(warmStartBedtime(smartSleep(0, false), TZ)?.toISOString()).toBe('2026-09-28T22:30:00.000Z');
  expect(preWarms(smartSleep(0, false))).toBe(false);
  expect(warmStartBedtime(sleeps[0], TZ)).toBeUndefined();
  expect(warmStartBedtime(undefined, TZ)).toBeUndefined();
});

it('reads a curve with an unknown phase without guessing', () => {
  const known = smartSleep(0, true);
  const points = known.smartCurve!.points;
  const withUnknownLater = points.map((point, index) => index === 2 ? { ...point, phase: null } : point);
  expect(warmStartBedtime(smartSleep(0, true, withUnknownLater), TZ)?.toISOString()).toBe('2026-09-28T22:30:00.000Z');
  const withUnknownFirst = points.map((point, index) => index === 0 ? { ...point, phase: null } : point);
  expect(warmStartBedtime(smartSleep(0, true, withUnknownFirst), TZ)).toBeUndefined();
});

it('words a bedtime with the right article', () => {
  expect(withArticle('10:30 PM')).toBe('a 10:30 PM');
  expect(withArticle('8:00 AM')).toBe('an 8:00 AM');
  expect(withArticle('11:15 PM')).toBe('an 11:15 PM');
});

it('tells an evening sleep from a day sleep', () => {
  expect(isEveningSleep(sleeps[0], TZ)).toBe(true);
  expect(isEveningSleep(sleep('2026-09-28', '2026-09-28T02:00:00.000Z', '2026-09-28T09:00:00.000Z'), TZ)).toBe(true);
  const day = sleep('2026-09-28', '2026-09-28T09:00:00.000Z', '2026-09-28T16:00:00.000Z');
  expect(isEveningSleep(day, TZ)).toBe(false);
  expect(pauseOptionLabel(day, TZ)).toBe('This sleep only');
  expect(pauseOptionLabel(sleeps[0], TZ)).toBe('Tonight only');
  expect(pauseOptionLabel(undefined, TZ)).toBe('Tonight only');
});

it('lists what a pause skips: an alarm at the end counts, a power-off at the end does not', () => {
  const now = at('2026-09-28T12:00:00Z');
  const through = skippedFromSleeps(sleeps, TZ, now, at('2026-09-29T06:30:00Z'));
  expect(through.map(skip => skip.kind)).toEqual(['start', 'temperature', 'alarm']);
  const atOff = skippedFromSleeps(sleeps, TZ, now, at('2026-09-29T07:00:00Z'));
  expect(atOff.map(skip => skip.kind)).toEqual(['start', 'temperature', 'alarm']);
  expect(skippedFromSleeps(sleeps, TZ, now, at('2026-09-29T07:00:01Z')).map(skip => skip.kind)).toContain('turn off');
  expect(skippedFromSleeps(sleeps, TZ, at('2026-09-28T12:00:00Z'), at('2026-09-28T22:00:00Z'))).toEqual([]);
});

it('words the skipped list, folding temperature steps and capping at three items', () => {
  const now = at('2026-09-28T12:00:00Z');
  expect(skipLine([], now)).toBe('Nothing scheduled is skipped.');
  const items = skippedFromSleeps(sleeps, TZ, now, at('2026-09-29T07:00:00Z'));
  expect(skipLine(items, now)).toBe('Skips: 10:00 PM start, temperature changes, 6:30 AM alarm');
  const many = skippedFromSleeps(sleeps, TZ, now, at('2026-10-01T08:00:00Z'));
  expect(skipLine(many, now)).toBe('Skips: 10:00 PM start, temperature changes, 6:30 AM alarm and 3 more');
});
