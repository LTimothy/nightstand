import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SMART, RhythmSchema, type Rhythm, type SuggestionRow } from '@api/rhythmsSchema';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { LOWERCASE_DAYS } from '../days';
import {
  comingUpDates, dayLabel, deleteRhythm, describeDays, describeUsage, effectiveRhythmId, firstComingUpDate, isRhythmInUse,
  newRhythmId, rhythmDetail, rhythmOptions, rhythmsNotice, rhythmTimes, rhythmUsage, setDateChange, setWeekDays,
  MAX_CHANGE_DAYS_AHEAD, MAX_NAME_LENGTH, MAX_RHYTHMS_PER_SIDE, conversionDifference, datePickMessage, datesPickMessage,
  deleteMessage, restoreDates, restoreDeleted, restoreWeekDays, rhythmName, setDateChanges, upcomingChanges, usageSubject,
  weekLabel, weekPickMessage, weekRuns, withOffWhenUp, applySuggestion, restoreRhythm, suggestionStart, withRows,
} from './rhythmsModel';

const left = createDemoRhythms(new Date('2026-09-28T19:00:00Z')).left;

it('uses a date change before the weekly plan', () => {
  expect(effectiveRhythmId(left, '2026-09-29')).toBe('workday');
  expect(effectiveRhythmId(left, '2026-09-30')).toBeNull();
  expect(effectiveRhythmId(left, '2026-10-02')).toBe('weekend');
});

it('describes times, days and dates in plain words', () => {
  expect(rhythmTimes(left.rhythms.workday.night)).toBe('10:30 PM to 6:45 AM');
  expect(rhythmDetail(left.rhythms.workday)).toBe('10:30 PM to 6:45 AM · Smart Schedule');
  expect(rhythmDetail(left.rhythms.weekend)).toBe('11:30 PM to 8:45 AM');
  expect(describeDays(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'])).toBe('Sun to Thu');
  expect(describeDays(['friday', 'saturday'])).toBe('Fri and Sat');
  expect(describeDays([...LOWERCASE_DAYS])).toBe('Every day');
  expect(describeUsage(rhythmUsage(left, 'weekend', '2026-09-28'))).toBe('Used on Fri and Sat');
  expect(describeUsage({ days: ['friday', 'saturday'], dates: ['2026-10-03'] })).toBe('Used on Fri and Sat, plus Sat, Oct 3');
  expect(describeUsage({ days: [], dates: [] })).toBe('Not used yet');
  expect(describeUsage({ days: [], dates: ['2026-10-03'] })).toBe('Used on Sat, Oct 3');
  const threeDates = ['2026-10-03', '2026-10-04', '2026-10-05'];
  expect(describeUsage({ days: [], dates: threeDates })).toBe('Used on Sat Oct 3, Sun Oct 4 and Mon Oct 5');
  expect(describeUsage({ days: ['friday'], dates: ['2026-10-03', '2026-10-04'] })).toBe('Used on Friday, plus Sat Oct 3 and Sun Oct 4');
  expect(dayLabel('2026-09-28', '2026-09-28')).toBe('Today, Sep 28');
  expect(dayLabel('2026-09-29', '2026-09-28')).toBe('Tomorrow, Sep 29');
  expect(dayLabel('2026-09-30', '2026-09-28')).toBe('Wed, Sep 30');
  expect(rhythmOptions(left).map(option => option.label)).toEqual(['Workday', 'Weekend', 'No sleep scheduled']);
});

it('treats past date changes as not in use', () => {
  const side = { ...left, week: { ...left.week, friday: null, saturday: null }, changes: [{ date: '2026-09-20', rhythmId: 'weekend' }] };
  expect(isRhythmInUse(side, 'weekend', '2026-09-28')).toBe(false);
  expect(isRhythmInUse(left, 'weekend', '2026-09-28')).toBe(true);
});

it('makes ids that match the stored format and never collide', () => {
  expect(newRhythmId('Night shift', [])).toBe('night-shift');
  expect(newRhythmId('Night shift', ['night-shift'])).toBe('night-shift-2');
  expect(newRhythmId('Café', [])).toBe('cafe');
  expect(newRhythmId('Señor', [])).toBe('senor');
  expect(newRhythmId('Jürgen', [])).toBe('jurgen');
  expect(newRhythmId('!!!', [])).toBe('rhythm');
  expect(newRhythmId('A'.repeat(40), [])).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
});

it('moves days and future dates to the replacement when deleting', () => {
  const side = { ...left, changes: [{ date: '2026-09-20', rhythmId: 'workday' }, { date: '2026-10-05', rhythmId: 'workday' }] };
  const next = deleteRhythm(side, 'workday', 'weekend', '2026-09-28');
  expect(next.rhythms.workday).toBeUndefined();
  expect(next.week.monday).toBe('weekend');
  expect(next.changes).toEqual([{ date: '2026-10-05', rhythmId: 'weekend' }]);
  expect(deleteRhythm(side, 'workday', null, '2026-09-28').week.monday).toBeNull();
});

it('stores a date change only when it differs from the weekly plan', () => {
  expect(setDateChange(left, '2026-10-01', { kind: 'none' }).changes).toContainEqual({ date: '2026-10-01', rhythmId: null });
  expect(setDateChange(left, '2026-10-01', { kind: 'rhythm', id: 'workday' }).changes.some(change => change.date === '2026-10-01'))
    .toBe(false);
  expect(setDateChange(left, '2026-09-30', { kind: 'weekly' }).changes).toEqual([]);
  expect(setDateChange(left, '2026-10-01', { kind: 'rhythm', id: 'weekend' }).changes.map(change => change.date))
    .toEqual(['2026-09-30', '2026-10-01']);
  expect(setWeekDays(left, ['saturday'], 'workday').week.saturday).toBe('workday');
});

it('lists 14 dates from an in-progress sleep or from today', () => {
  expect(comingUpDates('2026-09-28', 14)).toHaveLength(14);
  expect(comingUpDates('2026-09-30', 2)).toEqual(['2026-09-30', '2026-10-01']);
  const sleeps = [{ date: '2026-09-27', start: '2026-09-28T05:30:00Z', end: '2026-09-28T13:45:00Z' }] as unknown as ResolvedSleepResponse[];
  expect(firstComingUpDate(sleeps, new Date('2026-09-28T09:00:00Z'), '2026-09-28')).toBe('2026-09-27');
  expect(firstComingUpDate(sleeps, new Date('2026-09-28T19:00:00Z'), '2026-09-28')).toBe('2026-09-28');
});

it('explains why Rhythms is not running', () => {
  expect(rhythmsNotice('fingerprint-mismatch'))
    .toBe('Your weekly schedule changed in another version, so it is running instead of your rhythms. Your rhythms are kept.');
  expect(rhythmsNotice('unsupported-version')).toMatch(/newer version of Nightstand/);
  expect(rhythmsNotice('invalid')).toMatch(/could not be read/);
  expect(rhythmsNotice('absent')).toMatch(/no saved rhythms/);
  expect(rhythmsNotice(undefined)).toMatch(/weekly schedule is in use/);
});

it('uses one limit per side, the server\'s', () => {
  expect(MAX_RHYTHMS_PER_SIDE).toBe(12);
});

it('groups the week into runs and joins a wrapped run', () => {
  expect(weekRuns(left).map(run => [run.days.length, run.id])).toEqual([[5, 'workday'], [2, 'weekend']]);
  const wrapped = setWeekDays(left, ['sunday', 'saturday'], 'weekend');
  expect(weekRuns(wrapped).map(run => [run.days, run.id])).toEqual([
    [['monday', 'tuesday', 'wednesday', 'thursday'], 'workday'],
    [['friday', 'saturday', 'sunday'], 'weekend'],
  ]);
});

it('words the week and date picks and their undo lines', () => {
  expect(weekPickMessage(left, ['friday', 'saturday'], 'workday')).toBe('Fri and Sat now use Workday');
  expect(weekPickMessage(left, ['friday'], null)).toBe('Friday now has no sleep scheduled');
  expect(weekLabel(left, '2026-09-29')).toBe('Week: Workday');
  expect(datePickMessage(left, '2026-09-29', { kind: 'weekly' }, '2026-09-28')).toBe('Tomorrow, Sep 29 is back to Week: Workday');
  expect(datePickMessage(left, '2026-09-29', { kind: 'none' }, '2026-09-28')).toBe('Tomorrow, Sep 29 now has no sleep scheduled');
  expect(datePickMessage(left, '2026-09-29', { kind: 'rhythm', id: 'weekend' }, '2026-09-28')).toBe('Tomorrow, Sep 29 now uses Weekend');
  const dates = ['2026-10-01', '2026-10-02'];
  expect(datesPickMessage(left, dates, { kind: 'rhythm', id: 'weekend' }, '2026-09-28')).toBe('2 dates now use Weekend');
  expect(datesPickMessage(left, dates, { kind: 'weekly' }, '2026-09-28')).toBe('2 dates are back to Week');
  expect(datesPickMessage(left, dates, { kind: 'none' }, '2026-09-28')).toBe('2 dates now have no sleep scheduled');
  expect(datesPickMessage(left, [dates[0]], { kind: 'none' }, '2026-09-28')).toBe('Thu, Oct 1 now has no sleep scheduled');
});

it('undoes a week pick and a date pick without touching other edits', () => {
  const picked = setWeekDays(left, ['friday', 'saturday'], 'workday');
  const edited = { ...picked, week: { ...picked.week, sunday: null } };
  const undone = restoreWeekDays(edited, left, ['friday', 'saturday']);
  expect(undone.week.friday).toBe('weekend');
  expect(undone.week.sunday).toBeNull();

  const dates = ['2026-10-01', '2026-10-02'];
  const changed = setDateChanges(left, dates, { kind: 'none' });
  expect(changed.changes.map(change => change.date)).toEqual(['2026-09-30', ...dates]);
  const later = { ...changed, changes: [...changed.changes, { date: '2026-10-10', rhythmId: null }] };
  expect(restoreDates(later, left, dates).changes).toEqual([{ date: '2026-09-30', rhythmId: null }, { date: '2026-10-10', rhythmId: null }]);
  expect(restoreDates(changed, left, ['2026-10-01']).changes.map(change => change.date)).toEqual(['2026-09-30', '2026-10-02']);
});

it('lists date changes from the first shown date, past Coming up included', () => {
  const changes = ['2026-12-01', '2026-09-20', '2026-09-30'].map(date => ({ date, rhythmId: null }));
  const side = { ...left, changes };
  expect(upcomingChanges(side, '2026-09-28').map(change => change.date)).toEqual(['2026-09-30', '2026-12-01']);
});

it('says what deleting a rhythm changes, and undoes it', () => {
  const usage = { days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'] as const, dates: ['2026-10-05'] };
  expect(usageSubject({ days: [...usage.days], dates: usage.dates })).toBe('Sun to Thu, plus 1 date');
  expect(usageSubject({ days: [], dates: ['2026-10-05', '2026-10-06'] })).toBe('2 dates');
  expect(usageSubject({ days: ['friday', 'saturday'], dates: [] })).toBe('Fri and Sat');

  const side = { ...left, changes: [{ date: '2026-10-05', rhythmId: 'workday' }] };
  expect(deleteMessage(side, 'workday', 'weekend', '2026-09-28')).toBe('Workday deleted. Sun to Thu, plus 1 date now use Weekend');
  expect(deleteMessage(side, 'workday', null, '2026-09-28')).toBe('Workday deleted. Sun to Thu, plus 1 date now have no sleep scheduled');
  expect(deleteMessage({ ...left, week: { ...left.week, friday: null, saturday: null } }, 'weekend', null, '2026-09-28'))
    .toBe('Weekend deleted');

  const after = deleteRhythm(side, 'workday', 'weekend', '2026-09-28');
  const restored = restoreDeleted(after, side, 'workday');
  expect(restored.rhythms.workday).toEqual(left.rhythms.workday);
  expect(restored.week).toEqual(side.week);
  expect(restored.changes).toEqual(side.changes);
  expect(restoreDeleted(after, side, 'missing')).toBe(after);
});

it('names what sets a converted rhythm apart', () => {
  const base = left.rhythms.workday;
  const temperature = (fahrenheit: number) => `${fahrenheit} F`;
  const later: Rhythm = { ...base, id: 'other', night: { ...base.night, alarm: { ...base.night.alarm, time: '07:15' },
    alarms: [{ ...base.night.alarms[0], time: '07:15' }] } };
  expect(conversionDifference(later, [base], temperature)).toBe('Alarm at 7:15 AM');

  const pulse = { ...base.night.alarms[0], vibrationPattern: 'double' as const, vibrationIntensity: 3, duration: 10 };
  const vibrating: Rhythm = { ...base, id: 'pulse', night: { ...base.night, alarm: pulse, alarms: [pulse] } };
  expect(conversionDifference(vibrating, [base], temperature)).toBe('Alarm Double pulse, strength 3, 10 s');

  expect(conversionDifference({ ...base, id: 'copy' }, [base], temperature)).toBe('Other alarm settings');

  const builds = { ...pulse, vibrationPattern: 'rise' as const };
  const rising: Rhythm = { ...base, id: 'rise', night: { ...base.night, alarm: builds, alarms: [builds] } };
  expect(conversionDifference(rising, [base], temperature, true)).toBe('Alarm Builds up, strength 3, 10 s');
  expect(conversionDifference(rising, [base], temperature)).toBe('Alarm Double pulse, strength 3, 10 s');
});

it('does not resolve ids that only exist on the prototype', () => {
  const week = { ...left.week, monday: 'constructor' };
  const side = { ...left, week };
  expect(rhythmName(side, 'constructor')).toBe('No sleep scheduled');
  expect(weekRuns(side).find(run => run.days.includes('monday'))?.id).toBeNull();
});

it('keeps a wrapped run of four days as separate runs, as describeDays words it', () => {
  const side = setWeekDays(left, ['friday', 'saturday', 'sunday', 'monday'], 'weekend');
  expect(weekRuns(side).map(run => [run.days.length, run.id])).toEqual([[2, 'weekend'], [3, 'workday'], [2, 'weekend']]);
  expect(describeDays(['sunday', 'monday', 'friday', 'saturday'])).toBe('Sun, Mon, Fri and Sat');
});

it('joins a wrapped run of six days, which describeDays words as every day but one', () => {
  const side = setWeekDays(left, ['saturday'], 'workday');
  expect(weekRuns(side).map(run => [run.days, run.id])).toEqual([
    [['friday'], 'weekend'],
    [['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday'], 'workday'],
  ]);
  expect(describeDays(weekRuns(side)[1].days)).toBe('Every day but Fri');
});

it('does not undo a delete over a rhythm that took the freed id or past the limit', () => {
  const deleted = deleteRhythm(left, 'workday', 'weekend', '2026-09-28');
  const reused = { ...deleted, rhythms: { ...deleted.rhythms, workday: { ...left.rhythms.workday, name: 'New' } } };
  expect(restoreDeleted(reused, left, 'workday')).toBe(reused);
  const full = { ...deleted, rhythms: Object.fromEntries(Array.from({ length: MAX_RHYTHMS_PER_SIDE }, (_, index) => [
    `r${index}`, { ...left.rhythms.weekend, id: `r${index}` },
  ])) };
  expect(restoreDeleted(full, left, 'workday')).toBe(full);
});

it('keeps the limits the server enforces', () => {
  const rhythm = left.rhythms.workday;
  expect(RhythmSchema.safeParse({ ...rhythm, name: 'a'.repeat(MAX_NAME_LENGTH) }).success).toBe(true);
  expect(RhythmSchema.safeParse({ ...rhythm, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }).success).toBe(false);
  const validate = readFileSync('../server/src/jobs/rhythms/validate.ts', 'utf8');
  expect(validate).toContain(`export const MAX_CHANGE_DAYS_AHEAD = ${MAX_CHANGE_DAYS_AHEAD};`);
});

it('stores "When I get up" only when on', () => {
  const on = withOffWhenUp(DEFAULT_SMART, true);
  expect(on).toEqual({ ...DEFAULT_SMART, offWhenUp: true });
  const off = withOffWhenUp(on, false);
  expect(off).toEqual(DEFAULT_SMART);
  expect('offWhenUp' in off).toBe(false);
});

const right = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right;
const offDays = right.rhythms['off-days'];
const evidence = { supporting: 9, firstNight: '2026-10-01', lastNight: '2026-10-11', supportingDates: ['2026-10-01', '2026-10-11'] };
const onRow: SuggestionRow = {
  kind: 'on', key: 'on:down', direction: 'down', ...evidence, temperatureF: 80, plannedF: 82,
  thenBack: { time: '01:00', temperatureF: 82, supporting: 7 },
};
const replaceRow: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', ...evidence, time: '03:00', replaces: '03:00', temperatureF: 77, plannedF: 79,
};
const lateRow: SuggestionRow = { kind: 'step', key: 'step:up', direction: 'up', ...evidence, time: '05:00', temperatureF: 84, plannedF: 79 };

it('writes each kind of row, the return included', () => {
  expect(withRows(offDays, [onRow]).night).toMatchObject({ power: { onTemperature: 80 }, temperatures: { '01:00': 82, '03:00': 79 } });
  expect(withRows(offDays, [replaceRow]).night.temperatures).toEqual({ '03:00': 77 });
  const workday = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).left.rhythms.workday;
  const base: SuggestionRow = { kind: 'base', key: 'base:down', direction: 'down', ...evidence, baseLevel: -2, currentBaseLevel: -1 };
  expect(withRows(workday, [base]).smart.baseLevel).toBe(-2);
  expect(offDays.night.temperatures).toEqual({ '03:00': 79 });
});

it('adds any subset of a three-row suggestion as one valid side', () => {
  const rows = [onRow, replaceRow, lateRow];
  for (let mask = 1; mask < 8; mask++) {
    const picked = rows.filter((_, index) => mask & (1 << index));
    const side = applySuggestion(right, 'off-days', picked);
    const next = side.rhythms['off-days'];
    expect(RhythmSchema.safeParse(next).success).toBe(true);
    expect(next.night.power.onTemperature).toBe(picked.includes(onRow) ? 80 : 82);
    expect(next.night.temperatures).toEqual({
      '03:00': picked.includes(replaceRow) ? 77 : 79,
      ...(picked.includes(onRow) ? { '01:00': 82 } : {}),
      ...(picked.includes(lateRow) ? { '05:00': 84 } : {}),
    });
    expect(side.rhythms['night-shift']).toBe(right.rhythms['night-shift']);
  }
  expect(applySuggestion(right, 'gone', rows)).toBe(right);
});

it('puts a rhythm back as it was, unless it is gone', () => {
  const changed = applySuggestion(right, 'off-days', [lateRow]);
  expect(restoreRhythm(changed, right, 'off-days').rhythms['off-days']).toEqual(offDays);
  const deleted = { ...changed, rhythms: Object.fromEntries(Object.entries(changed.rhythms).filter(([id]) => id !== 'off-days')) };
  expect(restoreRhythm(deleted, right, 'off-days')).toBe(deleted);
});

it('finds the night a suggestion starts', () => {
  const sleep = (date: string, start: string, end: string) => ({ rhythmId: 'off-days', date, start, end }) as ResolvedSleepResponse;
  const sleeps = [
    sleep('2026-10-16', '2026-10-16T23:00:00Z', '2026-10-17T07:00:00Z'),
    sleep('2026-10-18', '2026-10-18T23:00:00Z', '2026-10-19T07:00:00Z'),
  ];
  const now = new Date('2026-10-17T01:00:00Z');
  const early: SuggestionRow = { ...lateRow, time: '23:45' };
  expect(suggestionStart(sleeps, offDays, [early, lateRow], now, '2026-10-17', 'UTC')).toEqual({ kind: 'date', date: '2026-10-18' });
  expect(suggestionStart(sleeps, offDays, [lateRow], now, '2026-10-17', 'UTC')).toEqual({ kind: 'tonight' });
  expect(suggestionStart(sleeps, offDays, [onRow], new Date('2026-10-18T12:00:00Z'), '2026-10-18', 'UTC')).toEqual({ kind: 'tonight' });
  expect(suggestionStart([], offDays, [lateRow], now, '2026-10-17', 'UTC')).toEqual({ kind: 'none' });
});

it('names the time for a daytime rhythm', () => {
  const shift = right.rhythms['night-shift'];
  const day = [
    { rhythmId: 'night-shift', date: '2026-10-17', start: '2026-10-17T08:00:00Z', end: '2026-10-17T15:30:00Z' },
  ] as ResolvedSleepResponse[];
  const noon: SuggestionRow = { ...lateRow, time: '12:00' };
  expect(suggestionStart(day, shift, [noon], new Date('2026-10-17T06:00:00Z'), '2026-10-17', 'UTC')).toEqual({ kind: 'today', at: '08:00' });
  expect(suggestionStart(day, shift, [noon], new Date('2026-10-17T09:00:00Z'), '2026-10-17', 'UTC')).toEqual({ kind: 'today', at: '12:00' });
});

it('waits for a pause the change would fall in', () => {
  const sleeps = [
    { rhythmId: 'off-days', date: '2026-10-16', start: '2026-10-16T23:00:00Z', end: '2026-10-17T07:00:00Z' },
  ] as ResolvedSleepResponse[];
  const startWith = (pause?: Date | null) =>
    suggestionStart(sleeps, offDays, [lateRow], new Date('2026-10-17T01:00:00Z'), '2026-10-17', 'UTC', pause);
  expect(startWith(new Date('2026-10-17T07:00:00Z'))).toEqual({ kind: 'paused' });
  expect(startWith(null)).toEqual({ kind: 'paused' });
  expect(startWith(new Date('2026-10-17T02:00:00Z'))).toEqual({ kind: 'tonight' });
  expect(startWith()).toEqual({ kind: 'tonight' });
});
