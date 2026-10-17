import moment from 'moment-timezone';
import type {
  Dismissed, NightExclude, NightLog, Rhythm, RhythmNights, SuggestionDismiss, SuggestionRow, SuggestionsResponse,
} from '@api/rhythmsSchema';
import { rhythmSleepBounds } from '@api/rhythmTimes';
import { minutesAfterOn } from '@api/rhythmWake';
import { buildCurve } from '@api/smartCurve';
import { levelToFahrenheit } from '@lib/temperatureConversions';
import { getSettings } from './mockData';
import { getMockRhythms, getMockRhythmsResponse } from './rhythmsMock';
import { DEMO_TIME_ZONE, hashSeed, mulberry32 } from './sampleNights';

type Side = 'left' | 'right';
type Hidden = Dismissed & { side: Side };
type Change = { minute: number; fromF: number; targetF: number; plannedF: number; held?: boolean; tap?: boolean };

// The app's TypeScript lib predates Object.hasOwn.
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

// Off days' last 14 nights, oldest first: which ones made each change. Night 6 starts left out.
const DOWN_NIGHTS = [1, 2, 4, 5, 6, 8, 9, 11, 13];
const BACK_NIGHTS = [1, 2, 4, 5, 6, 8, 9, 11];
const UP_NIGHTS = [0, 2, 5, 7, 9, 10, 12];
const ONE_OFF_NIGHT = 6;
const SEEDED_HIDE: Hidden = { id: 'a1b2c3d4e5f6', side: 'right', rhythmId: 'off-days', key: 'on:up', time: null, scope: 'plan', nightsLeft: 0 };

let hidden: Hidden[] = [{ ...SEEDED_HIDE }];
let oneOffs = new Map<string, boolean>();
let forgotten = false;
let nextId = 1;

export function resetMockSuggestions() {
  hidden = [{ ...SEEDED_HIDE }];
  oneOffs = new Map();
  forgotten = false;
  nextId = 1;
}

const OFF = (enabled: boolean): SuggestionsResponse => ({ enabled, nights: {}, suggestions: [], dismissed: [], log: [] });
const counting = (counted: number, reason: RhythmNights['reason'] = 'few-nights', changed = 0): RhythmNights =>
  ({ counted, needed: 5, changed, earlier: false, reason });
const evidence = (dates: string[]) =>
  ({ supporting: dates.length, firstNight: dates[0], lastNight: dates[dates.length - 1], supportingDates: dates });

// What the demo Pod set: the plan's steps until a hand change held the bed, then the power-off at the night's end.
function recording(start: moment.Moment, plan: NightLog['plan'], endMin: number, changes: Change[]): NightLog['sets'] {
  const firstChange = Math.min(...changes.map(change => change.minute));
  return [
    ...plan.filter(step => step.offsetMin === 0 || step.offsetMin < firstChange)
      .map(step => ({ at: start.clone().add(step.offsetMin, 'minutes').toISOString(), temperatureF: step.temperatureF as number | null })),
    { at: start.clone().add(endMin, 'minutes').toISOString(), temperatureF: null },
  ];
}

function nightLog(side: Side, rhythmId: string, date: string, on: string, plan: NightLog['plan'], endMin: number, changes: Change[],
  tonight = false, oneOff = false): NightLog {
  const start = moment.tz(`${date} ${on}`, 'YYYY-MM-DD HH:mm', DEMO_TIME_ZONE);
  const jitter = mulberry32(hashSeed(`suggestions|${side}|${rhythmId}|${date}`));
  return {
    date, rhythmId, tonight, excluded: !tonight && (oneOffs.get(`${side}|${rhythmId}|${date}`) ?? oneOff), plan, endMin,
    changes: changes.map(change => ({
      at: start.clone().add(change.minute + Math.round(jitter() * 10) - 5, 'minutes').toISOString(),
      fromF: change.fromF, targetF: change.targetF, plannedF: change.plannedF, held: change.held ?? false, source: change.tap ? 'tap' : 'api',
    })),
    start: start.toISOString(), samePlan: true, ...(tonight ? {} : { sets: recording(start, plan, endMin, changes) }),
  };
}

// A Smart night as the Pod writes it: the curve's points until a hand change held the bed, then the power-off.
function curveSets(rhythm: Rhythm, night: NightLog): NightLog['sets'] {
  const { start, end, wake } = rhythmSleepBounds(night.date, rhythm.night.power, rhythm.wake, DEMO_TIME_ZONE);
  const firstChange = Math.min(...night.changes.map(change => Date.parse(change.at)));
  const points = buildCurve({ smart: rhythm.smart, bedtime: start, coolStart: start, wake, powerOff: end, timeZone: DEMO_TIME_ZONE });
  return [
    ...points.filter((point, index) => index === 0 || point.at.getTime() < firstChange)
      .map(point => ({ at: point.at.toISOString(), temperatureF: levelToFahrenheit(point.level) as number | null })),
    { at: end.toISOString(), temperatureF: null },
  ];
}

// The 14 dates before today, oldest first, and today.
function nightDates(now: Date) {
  const today = moment.tz(now, DEMO_TIME_ZONE).startOf('day');
  const dates = Array.from({ length: 14 }, (_, index) => today.clone().subtract(14 - index, 'days').format('YYYY-MM-DD'));
  return { dates, today: today.format('YYYY-MM-DD') };
}

const newestFirst = (a: NightLog, b: NightLog) => b.date.localeCompare(a.date) || a.rhythmId.localeCompare(b.rhythmId);

function rightSample(now: Date): SuggestionsResponse {
  const { dates, today } = nightDates(now);
  const plan = [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }];
  const offDays = dates.map((date, index) => nightLog('right', 'off-days', date, '23:00', plan, 480, [
    ...(DOWN_NIGHTS.includes(index) ? [{ minute: 45, fromF: 82, targetF: 79, plannedF: 82, tap: index === 9 }] : []),
    ...(BACK_NIGHTS.includes(index) ? [{ minute: 180, fromF: 79, targetF: 82, plannedF: 82, held: index === 5 }] : []),
    ...(UP_NIGHTS.includes(index) ? [{ minute: 360, fromF: 79, targetF: 84, plannedF: 79 }] : []),
  ], false, index === ONE_OFF_NIGHT));
  const shift = dates.slice(-3).map(date => nightLog('right', 'night-shift', date, '08:00', [{ offsetMin: 0, temperatureF: 83 }], 450, []));
  const pick = (indexes: number[]) => indexes.map(index => dates[index]);
  const rows: SuggestionRow[] = [
    {
      kind: 'step', key: 'step:down', direction: 'down', ...evidence(pick(DOWN_NIGHTS)), time: '23:45', temperatureF: 79, plannedF: 82,
      thenBack: { time: '02:00', temperatureF: 82, supporting: BACK_NIGHTS.length },
    },
    { kind: 'step', key: 'step:up', direction: 'up', ...evidence(pick(UP_NIGHTS)), time: '05:00', temperatureF: 84, plannedF: 79 },
  ];
  const counted = offDays.filter(night => !night.excluded).length;
  return {
    enabled: true,
    nights: { 'off-days': counting(counted, 'suggested', 12), 'night-shift': counting(3) },
    suggestions: [{ rhythmId: 'off-days', near: false, rows }],
    dismissed: [],
    log: [nightLog('right', 'off-days', today, '23:00', plan, 480, [], true), ...offDays, ...shift].sort(newestFirst),
  };
}

function leftSample(now: Date): SuggestionsResponse {
  const { dates } = nightDates(now);
  const recent = dates.slice(-12);
  const workday = recent.map((date, index) => nightLog('left', 'workday', date, '22:30', [{ offsetMin: 0, temperatureF: 80 }], 495,
    index % 2 === 0 && index < 10 ? [{ minute: 150, fromF: 77, targetF: 74, plannedF: 77 }] : []));
  const weekend = dates.slice(-3).map(date => nightLog('left', 'weekend', date, '23:30', [{ offsetMin: 0, temperatureF: 80 }], 555, []));
  const supporting = recent.filter((_, index) => index % 2 === 0 && index < 10);
  return {
    enabled: true,
    nights: { workday: counting(12, 'inconsistent', 5), weekend: counting(3) },
    suggestions: [{
      rhythmId: 'workday', near: true,
      rows: [{ kind: 'base', key: 'base:down', direction: 'down', ...evidence(supporting), baseLevel: -2, currentBaseLevel: -1 }],
    }],
    dismissed: [],
    log: [...workday, ...weekend].sort(newestFirst),
  };
}

// The demo's hides, applied the way the Pod applies them.
function applyHidden(sample: SuggestionsResponse, side: Side, ons: Record<string, string>): SuggestionsResponse {
  const own = hidden.filter(entry => entry.side === side && hasOwn(ons, entry.rhythmId));
  const covers = (rhythmId: string, row: SuggestionRow) => own.some(entry => entry.rhythmId === rhythmId && (entry.scope === 'later'
    || (entry.key === row.key && (row.kind !== 'step' || (entry.time !== null
      && Math.abs(minutesAfterOn(entry.time, ons[rhythmId]) - minutesAfterOn(row.time, ons[rhythmId])) <= 120)))));
  const suggestions = sample.suggestions
    .map(entry => ({ ...entry, rows: entry.rows.filter(row => !covers(entry.rhythmId, row)) }))
    .filter(entry => entry.rows.length > 0);
  const nights = { ...sample.nights };
  for (const entry of sample.suggestions) {
    if (!entry.near && !suggestions.some(kept => kept.rhythmId === entry.rhythmId)) {
      nights[entry.rhythmId] = { ...nights[entry.rhythmId], reason: 'dismissed' };
    }
  }
  const dismissed = own.map(({ id, rhythmId, key, time, scope, nightsLeft }) => ({ id, rhythmId, key, time, scope, nightsLeft }));
  return { ...sample, nights, suggestions, dismissed };
}

export function getMockSuggestions(side: Side, now = new Date()): SuggestionsResponse {
  const db = getMockRhythms();
  if (!getSettings().features.rhythmSuggestions || !getMockRhythmsResponse().status.active || !db) return OFF(false);
  const rhythms = db[side].rhythms;
  const ons = Object.fromEntries(Object.values(rhythms).map(rhythm => [rhythm.id, rhythm.night.power.on]));
  if (forgotten) return { ...OFF(true), nights: Object.fromEntries(Object.keys(rhythms).map(id => [id, counting(0)])) };
  const sample = applyHidden(side === 'right' ? rightSample(now) : leftSample(now), side, ons);
  // A rhythm the person renamed away or deleted has no sample; one they added counts from zero.
  const known = (id: string) => hasOwn(rhythms, id);
  return {
    ...sample,
    nights: Object.fromEntries(Object.keys(rhythms).map(id => [id, sample.nights[id] ?? counting(0)])),
    suggestions: sample.suggestions.filter(entry => known(entry.rhythmId)),
    log: sample.log.filter(night => known(night.rhythmId)).map(night => {
      const rhythm = rhythms[night.rhythmId];
      return rhythm.temperatureMode === 'smart' && night.sets ? { ...night, sets: curveSets(rhythm, night) } : night;
    }),
  };
}

export function dismissMockSuggestion(body: SuggestionDismiss): string[] {
  const make = (key: string | null, time: string | null): Hidden => ({
    id: (0xd00000000000 + nextId++).toString(16), side: body.side, rhythmId: body.rhythmId, key, time, scope: body.scope,
    nightsLeft: body.scope === 'later' ? 14 : 0,
  });
  const added = body.scope === 'later' ? [make(null, null)] : body.rows.map(row => make(row.key, row.time));
  hidden.push(...added);
  return added.map(entry => entry.id);
}

export function restoreMockSuggestions(side: Side, ids: string[]): boolean {
  const before = hidden.length;
  hidden = hidden.filter(entry => entry.side !== side || !ids.includes(entry.id));
  return hidden.length < before;
}

export function excludeMockNight(body: NightExclude): void {
  oneOffs.set(`${body.side}|${body.rhythmId}|${body.date}`, body.excluded);
}

export function forgetMockSuggestions(): void {
  forgotten = true;
  hidden = [];
}
