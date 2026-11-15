import moment from 'moment-timezone';
import { DEFAULT_SMART, RHYTHMS_FILE_VERSION, rhythmOffWhenUp, type Rhythm, type RhythmsDB, type SideRhythms } from '@api/rhythmsSchema';
import { MAX_TEMPERATURES_PER_DAY, type AlarmSchedule, type DailySchedule, type DayOfWeek, type Schedules } from '@api/schedulesSchema';
import type { HandoffReport, ResolvedSleepResponse, RhythmsLive, RhythmsResponse, SleepEvent } from '@api/rhythmsResponse';
import type { RhythmsUpdate } from '@api/rhythms';
import { conversionName } from '@api/rhythmDays';
import { wakeFromNight } from '@api/rhythmWake';
import { addDays, rhythmSleepBounds, wallClock } from '@api/rhythmTimes';
import { buildCurve, isDaySleep, phaseAt } from '@api/smartCurve';
import { latestOff } from '@api/smartOff';
import { levelToFahrenheit } from '@lib/temperatureConversions';
import { getDeviceStatus, getSchedules, getSettings, updateSettings } from './mockData';
import { demoRhythmsDefault } from './demoPreferences';

type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];
const DAYS: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const FINGERPRINT = '0'.repeat(64);
const KIND_ORDER: Record<SleepEvent['kind'], number> = { 'power-on': 0, temperature: 1, alarm: 2, 'power-off': 3 };

const alarm = (time: string): AlarmSchedule => ({
  time, enabled: true, vibrationIntensity: 30, vibrationPattern: 'rise', duration: 30, alarmTemperature: 83,
});
const night = (on: string, off: string, onTemperature: number, temperatures: Record<string, number>, wake: string): DailySchedule => ({
  power: { on, off, onTemperature, enabled: true }, temperatures, alarm: alarm(wake), alarms: [alarm(wake)],
});
const rhythm = (id: string, name: string, value: DailySchedule, smart?: Partial<Rhythm['smart']>): Rhythm => ({
  id, name, night: value, wake: wakeFromNight(value), temperatureMode: smart ? 'smart' : 'manual', smart: { ...DEFAULT_SMART, ...smart },
});

export function createDemoRhythms(now = new Date()): RhythmsDB {
  const timeZone = getSettings().timeZone;
  const dateIn = (days: number) => moment.tz(now, timeZone).add(days, 'days').format('YYYY-MM-DD');
  // The right side's change must differ from its Week whatever weekday the demo opens on.
  const rightChange = dateIn(3);
  const rightChangeIsOffDay = [0, 5, 6].includes(moment(rightChange, 'YYYY-MM-DD').day());
  return {
    version: RHYTHMS_FILE_VERSION,
    legacyFingerprint: FINGERPRINT,
    left: {
      rhythms: {
        workday: rhythm('workday', 'Workday', night('22:30', '06:45', 83, {}, '06:30'), { baseLevel: -1 }),
        weekend: rhythm('weekend', 'Weekend', night('23:30', '08:45', 80, { '02:00': 77, '08:00': 85 }, '08:30')),
      },
      week: {
        sunday: 'workday', monday: 'workday', tuesday: 'workday', wednesday: 'workday', thursday: 'workday',
        friday: 'weekend', saturday: 'weekend',
      },
      changes: [{ date: dateIn(2), rhythmId: null }],
    },
    right: {
      rhythms: {
        'night-shift': rhythm('night-shift', 'Night shift', night('08:00', '15:30', 83, {}, '15:15'), { intensity: 'gentle' }),
        'off-days': rhythm('off-days', 'Off days', night('23:00', '07:00', 82, { '03:00': 79 }, '07:00')),
      },
      week: {
        sunday: 'off-days', monday: null, tuesday: 'night-shift', wednesday: 'night-shift', thursday: 'night-shift',
        friday: 'off-days', saturday: 'off-days',
      },
      changes: [{ date: rightChange, rhythmId: rightChangeIsOffDay ? 'night-shift' : 'off-days' }],
    },
  };
}

let rhythms: RhythmsDB | null = demoRhythmsDefault() ? createDemoRhythms() : null;

export const getMockRhythms = () => rhythms;

export function resetMockRhythms(db: RhythmsDB | null = demoRhythmsDefault() ? createDemoRhythms() : null, enabled = demoRhythmsDefault()) {
  rhythms = db;
  updateSettings({ features: { ...getSettings().features, rhythms: enabled } });
}

export function getMockRhythmsResponse(): RhythmsResponse {
  const enabled = !!getSettings().features.rhythms;
  const reason = !enabled ? 'flag-off' : !rhythms ? 'absent' : undefined;
  return { status: { enabled, active: enabled && !!rhythms, ...(reason ? { reason } : {}) }, data: rhythms };
}

export function resolveMockSleeps(db: RhythmsDB, side: Side, timeZone: string, from: Date, to: Date): ResolvedSleepResponse[] {
  const sleeps: ResolvedSleepResponse[] = [];
  const cursor = moment.tz(from, timeZone).startOf('day').subtract(1, 'day');
  while (cursor.isBefore(to)) {
    const date = cursor.format('YYYY-MM-DD');
    cursor.add(1, 'day');
    const change = db[side].changes.find(item => item.date === date);
    const id = change ? change.rhythmId : db[side].week[DAYS[moment(date, 'YYYY-MM-DD').day()]];
    const chosen = id ? db[side].rhythms[id] : undefined;
    if (!chosen?.night.power.enabled) continue;
    const { power } = chosen.night;
    const at = (time: string) => moment.tz(wallClock(time < power.on ? addDays(date, 1) : date, time, timeZone), timeZone);
    const bounds = rhythmSleepBounds(date, power, chosen.wake, timeZone);
    const start = moment.tz(bounds.start, timeZone);
    const end = moment.tz(bounds.end, timeZone);
    if (!end.isAfter(start) || !end.isAfter(from) || start.isAfter(to)) continue;
    const alarms = (chosen.night.alarms.length ? chosen.night.alarms : [chosen.night.alarm])
      .map((item, index) => ({ alarm: item, index, when: at(item.time) }))
      .filter(({ alarm: item, when }) => item.enabled && !when.isBefore(start) && !when.isAfter(end));
    let onTemperature = power.onTemperature;
    // Like the Pod, a Smart Schedule sleep powers on at the pre-warm, before its bedtime.
    let powerOn = start;
    let temperatures: Array<{ when: moment.Moment; temperatureF: number }>;
    let smartCurve: ResolvedSleepResponse['smartCurve'];
    // Like the Pod: the rhythm's own wake time, held inside the sleep.
    const wakeAt = moment.tz(bounds.wake, timeZone);
    if (chosen.temperatureMode === 'smart') {
      const points = buildCurve({
        smart: chosen.smart, bedtime: start.toDate(), coolStart: start.toDate(), wake: wakeAt.toDate(), powerOff: end.toDate(), timeZone,
      });
      smartCurve = {
        bedtime: start.toISOString(), coolStart: start.toISOString(), wake: wakeAt.toISOString(),
        daySleep: isDaySleep(start.toDate(), wakeAt.toDate(), timeZone),
        points: points.map(point => ({ ...point, at: point.at.toISOString() })),
      };
      const [first, ...rest] = points;
      if (first) {
        powerOn = moment.tz(first.at, timeZone);
        onTemperature = levelToFahrenheit(first.level);
      }
      temperatures = rest.map(point => ({ when: moment(point.at), temperatureF: levelToFahrenheit(point.level) }));
    } else {
      temperatures = Object.entries(chosen.night.temperatures).map(([time, temperatureF]) => ({ when: at(time), temperatureF }))
        .filter(({ when }) => when.isAfter(start) && when.isBefore(end));
    }
    const events: SleepEvent[] = [
      { kind: 'power-on', at: powerOn.toISOString(), temperatureF: onTemperature },
      ...temperatures.map(({ when, temperatureF }): SleepEvent => ({ kind: 'temperature', at: when.toISOString(), temperatureF })),
      ...alarms.map(({ alarm: item, index, when }): SleepEvent => ({ kind: 'alarm', at: when.toISOString(), alarm: item, index })),
      { kind: 'power-off', at: end.toISOString() },
    ];
    events.sort((first, second) => Date.parse(first.at) - Date.parse(second.at) || KIND_ORDER[first.kind] - KIND_ORDER[second.kind]);
    sleeps.push({
      side, date, rhythmId: chosen.id, start: powerOn.toISOString(), end: end.toISOString(), wake: wakeAt.toISOString(), night: chosen.night,
      mode: chosen.temperatureMode, ...(rhythmOffWhenUp(chosen) ? { offWhenUp: true } : {}),
      ...(chosen.temperatureMode === 'smart' ? { smart: chosen.smart, smartCurve } : {}), events,
    });
  }
  return sleeps;
}

export function listMockSleeps(side: Side, from: Date, to: Date) {
  return rhythms ? resolveMockSleeps(rhythms, side, getSettings().timeZone, from, to) : [];
}

// The demo has no controller and no presence stream, so it acts as if presence
// were fresh: only a "When I get up" sleep is live, to say when it turns off at
// the latest. The demo has no daily restart.
export function mockLive(side: Side, now = new Date()): RhythmsLive | null {
  const day = 24 * 60 * 60 * 1000;
  const sleeps = listMockSleeps(side, new Date(now.getTime() - day), new Date(now.getTime() + 2 * day));
  const index = sleeps.findIndex(sleep => Date.parse(sleep.start) <= now.getTime() && now.getTime() < Date.parse(sleep.end));
  const sleep = sleeps[index];
  if (!sleep?.offWhenUp) return null;
  const next = sleeps.slice(index + 1).find(item => Date.parse(item.start) >= Date.parse(sleep.end));
  const by = latestOff({ setOff: new Date(sleep.end), nextStart: next ? new Date(next.start) : null });
  const points = (sleep.smartCurve?.points ?? []).flatMap(({ at, level, phase }) => (phase ? [{ at: new Date(at), level, phase }] : []));
  return {
    side, date: sleep.date, phase: points.length ? phaseAt(points, now) : null, waiting: false,
    coolStart: sleep.smartCurve?.coolStart ?? sleep.start,
    hold: null, baseSince: null, nextChange: null, offWhenUp: { by: by.toISOString() },
  };
}

export function findMockOverlaps(db: RhythmsDB, side: Side, timeZone: string, from: Date, to: Date) {
  const sleeps = resolveMockSleeps(db, side, timeZone, from, to);
  const overlaps: Array<{ first: string; second: string }> = [];
  for (let index = 1; index < sleeps.length; index++) {
    if (Date.parse(sleeps[index].start) < Date.parse(sleeps[index - 1].end)) {
      overlaps.push({ first: sleeps[index - 1].date, second: sleeps[index].date });
    }
  }
  return overlaps;
}

export type MockSaveResult =
  | { ok: true; body: RhythmsResponse }
  | { ok: false; status: number; body: { error: string; details?: string[]; overlaps?: Array<{ side: Side; first: string; second: string }> } };

export function updateMockRhythms(update: RhythmsUpdate, now = new Date()): MockSaveResult {
  if (!rhythms) return { ok: false, status: 409, body: { error: 'Rhythms are not set up on this Pod' } };
  // Like the Pod: at most 48 set points a night, and a larger stored count may stay but not grow.
  for (const side of SIDES) {
    for (const item of Object.values(update[side]?.rhythms ?? {})) {
      const stored = Object.keys(rhythms[side].rhythms[item.id]?.night.temperatures ?? {}).length;
      if (Object.keys(item.night.temperatures).length > Math.max(MAX_TEMPERATURES_PER_DAY, stored)) {
        const detail = `${side}: Rhythm ${item.id} can have at most ${MAX_TEMPERATURES_PER_DAY} temperature changes`;
        return { ok: false, status: 400, body: { error: 'Invalid rhythms', details: [detail] } };
      }
    }
  }
  const next: RhythmsDB = { ...rhythms, ...update };
  const { timeZone } = getSettings();
  // Only sleeps that have not ended yet, so an overlap never names a past date.
  const from = now;
  const to = moment.tz(now, timeZone).startOf('day').add(69, 'days').toDate();
  for (const side of SIDES) {
    if (!update[side]) continue;
    const overlaps = findMockOverlaps(next, side, timeZone, from, to).map(pair => ({ side, ...pair }));
    if (overlaps.length) return { ok: false, status: 400, body: { error: 'Two sleeps would overlap', overlaps } };
  }
  rhythms = next;
  return { ok: true, body: getMockRhythmsResponse() };
}

// Nights that are the same share one rhythm, named after the days that use it.
function convertSide(schedule: Schedules['left']): SideRhythms {
  const byId: Record<string, Rhythm> = {};
  const idsByNight = new Map<string, string>();
  const week = {} as SideRhythms['week'];
  for (const day of DAYS) {
    const daily = schedule[day];
    if (!daily.power.enabled) {
      week[day] = null;
      continue;
    }
    const key = JSON.stringify(daily);
    let id = idsByNight.get(key);
    if (!id) {
      id = `night-${idsByNight.size + 1}`;
      idsByNight.set(key, id);
      byId[id] = {
        id, name: '', night: structuredClone(daily), wake: wakeFromNight(daily), temperatureMode: 'manual', smart: { ...DEFAULT_SMART },
      };
    }
    week[day] = id;
  }
  for (const item of Object.values(byId)) item.name = conversionName(DAYS.filter(day => week[day] === item.id));
  return { rhythms: byId, week, changes: [] };
}

// A running side's firmware timer: the time until its next scheduled turn-off.
export function scheduledSecondsRemaining(side: Side, now = new Date()): number | undefined {
  const { timeZone, features } = getSettings();
  const schedules = getSchedules();
  const db: RhythmsDB = features.rhythms && rhythms ? rhythms
    : { version: RHYTHMS_FILE_VERSION, legacyFingerprint: FINGERPRINT, left: convertSide(schedules.left), right: convertSide(schedules.right) };
  const off = resolveMockSleeps(db, side, timeZone, now, new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000))
    .flatMap(sleep => sleep.events.flatMap(event => event.kind === 'power-off' ? [Date.parse(event.at)] : []))
    .filter(at => at > now.getTime())
    .sort((first, second) => first - second)[0];
  return off === undefined ? undefined : Math.round((off - now.getTime()) / 1000);
}

export function enableMockRhythms() {
  const converted = !rhythms;
  if (!rhythms) {
    const schedules = getSchedules();
    rhythms = {
      version: RHYTHMS_FILE_VERSION, legacyFingerprint: FINGERPRINT,
      left: convertSide(schedules.left), right: convertSide(schedules.right),
    };
  }
  updateSettings({ features: { ...getSettings().features, rhythms: true } });
  return { converted };
}

export function disableMockRhythms(body: { powerOffNow?: boolean }, now = new Date()): HandoffReport {
  const { timeZone } = getSettings();
  const at = now.getTime();
  const running = (db: RhythmsDB | null, side: Side) => db && resolveMockSleeps(db, side, timeZone, now, now)
    .find(sleep => Date.parse(sleep.start) <= at && at < Date.parse(sleep.end));
  const schedules = getSchedules();
  const weekly: RhythmsDB | null = rhythms && { ...rhythms, left: convertSide(schedules.left), right: convertSide(schedules.right) };
  const sides = SIDES.map((side): HandoffReport['sides'][number] => {
    const sleep = getDeviceStatus()[side].isOn ? running(rhythms, side) : null;
    if (!sleep) return { side, action: 'none', alarmOverrideSet: false };
    if (body.powerOffNow) return { side, action: 'powered-off', alarmOverrideSet: false };
    const legacy = running(weekly, side);
    return legacy
      ? { side, action: 'legacy-takes-over', until: legacy.end, alarmOverrideSet: false }
      : { side, action: 'kept-on-until', until: sleep.end, alarmOverrideSet: false };
  });
  updateSettings({ features: { ...getSettings().features, rhythms: false } });
  return { sides };
}
