import moment from 'moment-timezone';
import type { DailySchedule, DayOfWeek } from '@api/schedulesSchema';
import {
  MAX_RHYTHMS_PER_SIDE, type DateChange, type Rhythm, type SideRhythms, type SmartSchedule, type SuggestionRow,
} from '@api/rhythmsSchema';
import { describeDays, fullDayName } from '@api/rhythmDays';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { minutesAfterOn } from '@api/rhythmWake';
import { isDaySleep } from '@api/smartCurve';
import { LOWERCASE_DAYS } from '../days';

export const MAX_NAME_LENGTH = 24;
export const MAX_CHANGE_DAYS_AHEAD = 60;
export const NO_SLEEP = 'No sleep scheduled';

export type DateChoice = { kind: 'rhythm'; id: string } | { kind: 'none' } | { kind: 'weekly' };
export type PickerOption = { choice: DateChoice; label: string; detail?: string };
export type SuggestionStart =
  { kind: 'tonight' } | { kind: 'today'; at: string } | { kind: 'date'; date: string } | { kind: 'paused' } | { kind: 'none' };
export type RhythmUsage = { days: DayOfWeek[]; dates: string[] };

// Stored only when on, so a rhythm without it saves exactly as before.
export function withOffWhenUp(smart: SmartSchedule, on: boolean): SmartSchedule {
  const next: SmartSchedule = { ...smart };
  delete next.offWhenUp;
  return on ? { ...next, offWhenUp: true } : next;
}

const DATE = 'YYYY-MM-DD';
// The app's TypeScript lib predates Object.hasOwn.
export const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const clock = (time: string) => moment(time, 'HH:mm').format('h:mm A');

export { MAX_RHYTHMS_PER_SIDE };
export { describeDays };

export const choiceKey = (choice: DateChoice) => choice.kind === 'rhythm' ? `rhythm:${choice.id}` : choice.kind;
export const weekdayOf = (date: string): DayOfWeek => LOWERCASE_DAYS[moment(date, DATE).day()];
export const formatDate = (date: string) => moment(date, DATE).format('ddd, MMM D');

export function dayLabel(date: string, today: string): string {
  const offset = moment(date, DATE).diff(moment(today, DATE), 'days');
  const short = moment(date, DATE).format('MMM D');
  if (offset === 0) return `Today, ${short}`;
  if (offset === 1) return `Tomorrow, ${short}`;
  if (offset === -1) return `Yesterday, ${short}`;
  return formatDate(date);
}

export function changeFor(side: SideRhythms, date: string) {
  return side.changes.find(change => change.date === date);
}

// A date change wins over Week; null means no sleep that date.
export function effectiveRhythmId(side: SideRhythms, date: string): string | null {
  const change = changeFor(side, date);
  return change ? change.rhythmId : side.week[weekdayOf(date)];
}

export function rhythmName(side: SideRhythms, id: string | null): string {
  return (id && hasOwn(side.rhythms, id) && side.rhythms[id].name) || NO_SLEEP;
}

export function rhythmTimes(night: DailySchedule): string {
  return night.power.enabled ? `${clock(night.power.on)} to ${clock(night.power.off)}` : 'Off';
}

// What sets a converted rhythm apart from the most similar other one on its side, for the rename step:
// "Alarm at 6:45 AM", "Alarm Double pulse, strength 3, 10 s".
export function conversionDifference(
  rhythm: Rhythm, others: Rhythm[], temperature: (fahrenheit: number) => string, risePattern = false,
): string {
  const facets = (item: Rhythm): Array<{ key: string; text: string }> => {
    const alarms = (item.night.alarms.length ? item.night.alarms : [item.night.alarm]).filter(alarm => alarm.enabled);
    const changes = Object.keys(item.night.temperatures).length;
    const vibration = alarms.map(alarm => `${alarm.vibrationPattern === 'rise' && risePattern ? 'Builds up' : 'Double pulse'}, `
      + `strength ${alarm.vibrationIntensity}, ${alarm.duration} s`).join('; ');
    return [
      { key: rhythmTimes(item.night), text: rhythmTimes(item.night) },
      { key: alarms.map(alarm => alarm.time).join(),
        text: alarms.length ? `alarm at ${alarms.map(alarm => clock(alarm.time)).join(' and ')}` : 'no alarm' },
      { key: String(item.night.power.onTemperature), text: `starts at ${temperature(item.night.power.onTemperature)}` },
      { key: JSON.stringify(Object.entries(item.night.temperatures).sort()),
        text: changes ? `other temperature changes (${changes})` : 'no temperature changes' },
      { key: vibration, text: vibration ? `alarm ${vibration}` : 'no alarm' },
    ];
  };
  const own = facets(rhythm);
  const same = (other: Rhythm) => facets(other).filter((facet, index) => facet.key === own[index].key).length;
  const closest = [...others].sort((first, second) => same(second) - same(first))[0];
  const differing = closest ? own.filter((facet, index) => facets(closest)[index].key !== facet.key).map(facet => facet.text)
    : own.slice(0, 2).map(facet => facet.text);
  const text = [...new Set(differing)].join(', ') || 'other alarm settings';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function rhythmDetail(rhythm: Rhythm): string {
  return `${rhythmTimes(rhythm.night)}${rhythm.temperatureMode === 'smart' ? ' · Smart Schedule' : ''}`;
}

// A Smart Schedule sleep starts warming before its bedtime; list the bedtime, as the rhythm card does.
export function sleepDetail(sleep: ResolvedSleepResponse, timeZone: string): string {
  const time = (value: string) => moment.tz(value, timeZone).format('h:mm A');
  const start = sleep.mode === 'smart' ? clock(sleep.night.power.on) : time(sleep.start);
  return `${start} to ${time(sleep.end)}${sleep.mode === 'smart' ? ' · Smart Schedule' : ''}`;
}

export function rhythmOptions(side: SideRhythms): PickerOption[] {
  return [
    ...Object.values(side.rhythms).map((rhythm): PickerOption => ({
      choice: { kind: 'rhythm', id: rhythm.id }, label: rhythm.name, detail: rhythmDetail(rhythm),
    })),
    { choice: { kind: 'none' }, label: NO_SLEEP },
  ];
}

export function rhythmUsage(side: SideRhythms, id: string, today: string): RhythmUsage {
  return {
    days: LOWERCASE_DAYS.filter(day => side.week[day] === id),
    dates: side.changes.filter(change => change.rhythmId === id && change.date >= today).map(change => change.date).sort(),
  };
}

export function isRhythmInUse(side: SideRhythms, id: string, today: string): boolean {
  const usage = rhythmUsage(side, id, today);
  return usage.days.length > 0 || usage.dates.length > 0;
}

export function describeUsage(usage: RhythmUsage): string {
  if (!usage.days.length && !usage.dates.length) return 'Not used yet';
  // Dates listed together drop their inner comma so the list stays readable.
  const dates = usage.dates.map(date => usage.dates.length > 1 ? moment(date, DATE).format('ddd MMM D') : formatDate(date));
  const datesText = dates.length > 1 ? `${dates.slice(0, -1).join(', ')} and ${dates[dates.length - 1]}` : dates[0];
  return `Used on ${[usage.days.length ? describeDays(usage.days) : '', datesText].filter(Boolean).join(', plus ')}`;
}

export function newRhythmId(name: string, existing: string[]): string {
  const slug = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    .replace(/-+$/g, '');
  const base = slug || 'rhythm';
  let id = base;
  for (let copy = 2; existing.includes(id); copy++) id = `${base}-${copy}`;
  return id;
}

export const DEFAULT_WAKE = '07:00';

export function defaultNight(): DailySchedule {
  const alarm = { time: '07:00', vibrationIntensity: 30, vibrationPattern: 'rise' as const, duration: 10, enabled: true, alarmTemperature: 83 };
  return { power: { enabled: true, on: '22:00', off: '07:00', onTemperature: 83 }, temperatures: {}, alarm, alarms: [alarm] };
}

export function setWeekDays(side: SideRhythms, days: DayOfWeek[], id: string | null): SideRhythms {
  return { ...side, week: { ...side.week, ...Object.fromEntries(days.map(day => [day, id])) } };
}

// Undo puts back only what a pick changed, so a later edit elsewhere survives.
export function restoreWeekDays(side: SideRhythms, before: SideRhythms, days: DayOfWeek[]): SideRhythms {
  return { ...side, week: { ...side.week, ...Object.fromEntries(days.map(day => [day, before.week[day]])) } };
}

export function restoreDate(side: SideRhythms, before: SideRhythms, date: string): SideRhythms {
  const previous = changeFor(before, date);
  const others = side.changes.filter(change => change.date !== date);
  return { ...side, changes: previous ? [...others, previous].sort((first, second) => first.date.localeCompare(second.date)) : others };
}

export type WeekRun = { days: DayOfWeek[]; id: string | null };

// Consecutive days with the same rhythm, Sunday first. A run that wraps past Saturday joins the Sunday run
// when describeDays can word it as one: 3 days or fewer, or 6 ("Every day but Fri").
export function weekRuns(side: SideRhythms): WeekRun[] {
  const known = (day: DayOfWeek) => {
    const id = side.week[day];
    return id && hasOwn(side.rhythms, id) ? id : null;
  };
  const runs: WeekRun[] = [];
  for (const day of LOWERCASE_DAYS) {
    const id = known(day);
    const last = runs[runs.length - 1];
    if (last?.id === id) last.days.push(day);
    else runs.push({ days: [day], id });
  }
  const joined = runs[0].days.length + runs[runs.length - 1].days.length;
  const wrapped = runs.length > 2 && runs[0].id === runs[runs.length - 1].id && (joined <= 3 || joined === 6);
  if (wrapped) {
    const first = runs.shift()!;
    runs[runs.length - 1].days.push(...first.days);
  }
  return runs;
}

export const dayName = fullDayName;

export function weekPickMessage(side: SideRhythms, days: DayOfWeek[], id: string | null): string {
  const plural = days.length > 1;
  const label = describeDays(days);
  if (!id) return `${label} now ${plural ? 'have' : 'has'} no sleep scheduled`;
  return `${label} now ${plural ? 'use' : 'uses'} ${rhythmName(side, id)}`;
}

// "Week" is the Rhythms weekday choice; "weekly schedule" is only the one that comes back when Rhythms is off.
export function weekLabel(side: SideRhythms, date: string): string {
  return `Week: ${rhythmName(side, side.week[weekdayOf(date)])}`;
}

export function datePickMessage(side: SideRhythms, date: string, choice: DateChoice, today: string): string {
  const label = dayLabel(date, today);
  if (choice.kind === 'weekly') return `${label} is back to ${weekLabel(side, date)}`;
  if (choice.kind === 'none') return `${label} now has no sleep scheduled`;
  return `${label} now uses ${rhythmName(side, choice.id)}`;
}

// Every date change from the first shown date on, including those past Coming up.
export function upcomingChanges(side: SideRhythms, from: string): DateChange[] {
  return side.changes.filter(change => change.date >= from).sort((first, second) => first.date.localeCompare(second.date));
}

export function setDateChange(side: SideRhythms, date: string, choice: DateChoice): SideRhythms {
  const others = side.changes.filter(change => change.date !== date);
  const rhythmId = choice.kind === 'rhythm' ? choice.id : null;
  if (choice.kind === 'weekly' || rhythmId === side.week[weekdayOf(date)]) return { ...side, changes: others };
  return { ...side, changes: [...others, { date, rhythmId }].sort((first, second) => first.date.localeCompare(second.date)) };
}

// Several dates picked on the calendar are saved in one write, with one undo.
export function setDateChanges(side: SideRhythms, dates: string[], choice: DateChoice): SideRhythms {
  return dates.reduce((next, date) => setDateChange(next, date, choice), side);
}

export function restoreDates(side: SideRhythms, before: SideRhythms, dates: string[]): SideRhythms {
  return dates.reduce((next, date) => restoreDate(next, before, date), side);
}

export function datesPickMessage(side: SideRhythms, dates: string[], choice: DateChoice, today: string): string {
  if (dates.length === 1) return datePickMessage(side, dates[0], choice, today);
  const label = `${dates.length} dates`;
  if (choice.kind === 'weekly') return `${label} are back to Week`;
  if (choice.kind === 'none') return `${label} now have no sleep scheduled`;
  return `${label} now use ${rhythmName(side, choice.id)}`;
}

// "Sun to Thu, plus 1 date", for the delete dialog and its undo line.
export function usageSubject(usage: RhythmUsage): string {
  const dates = usage.dates.length ? `${usage.dates.length} ${usage.dates.length === 1 ? 'date' : 'dates'}` : '';
  return [usage.days.length ? describeDays(usage.days) : '', dates].filter(Boolean).join(', plus ');
}

export function deleteMessage(side: SideRhythms, id: string, replacement: string | null, today: string): string {
  const usage = rhythmUsage(side, id, today);
  const name = rhythmName(side, id);
  if (!usage.days.length && !usage.dates.length) return `${name} deleted`;
  const plural = usage.days.length + usage.dates.length > 1;
  const result = replacement ? `${plural ? 'use' : 'uses'} ${rhythmName(side, replacement)}` : `${plural ? 'have' : 'has'} no sleep scheduled`;
  return `${name} deleted. ${usageSubject(usage)} now ${result}`;
}

// Undo a delete: the rhythm comes back with the days and dates it had.
export function restoreDeleted(side: SideRhythms, before: SideRhythms, id: string): SideRhythms {
  const rhythm = before.rhythms[id];
  // Refuse rather than overwrite a rhythm that took the freed id, or pass the per-side limit.
  if (!rhythm || hasOwn(side.rhythms, id) || Object.keys(side.rhythms).length >= MAX_RHYTHMS_PER_SIDE) return side;
  const week = { ...side.week };
  for (const day of LOWERCASE_DAYS) if (before.week[day] === id) week[day] = id;
  const moved = new Set(before.changes.filter(change => change.rhythmId === id).map(change => change.date));
  const changes = [...side.changes.filter(change => !moved.has(change.date)), ...before.changes.filter(change => moved.has(change.date))]
    .sort((first, second) => first.date.localeCompare(second.date));
  return { ...side, rhythms: { ...side.rhythms, [id]: rhythm }, week, changes };
}

export function deleteRhythm(side: SideRhythms, id: string, replacement: string | null, today: string): SideRhythms {
  const rhythms = { ...side.rhythms };
  delete rhythms[id];
  const week = { ...side.week };
  for (const day of LOWERCASE_DAYS) if (week[day] === id) week[day] = replacement;
  const changes = side.changes.flatMap(change => change.rhythmId !== id ? [change]
    : change.date < today ? [] : [{ ...change, rhythmId: replacement }]);
  return { ...side, rhythms, week, changes };
}

export function comingUpDates(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => moment(first, DATE).add(index, 'days').format(DATE));
}

// Start from a sleep still in progress so tonight's plan stays visible after midnight.
export function firstComingUpDate(sleeps: ResolvedSleepResponse[], now: Date, today: string): string {
  const current = sleeps.find(sleep => Date.parse(sleep.start) <= now.getTime() && now.getTime() < Date.parse(sleep.end));
  return current && current.date < today ? current.date : today;
}

export function rhythmsNotice(reason: string | undefined): string {
  switch (reason) {
  // Rhythms stays on here; the Schedule tab offers the weekly schedule or going back to Rhythms.
  case 'fingerprint-mismatch':
    return 'Your weekly schedule changed in another version, so it is running instead of your rhythms. Your rhythms are kept.';
  case 'unsupported-version':
    return 'Your rhythms were saved by a newer version of Nightstand, so the weekly schedule is running. Your rhythms are kept.';
  case 'invalid':
    return 'Your rhythms could not be read, so the weekly schedule is running. The file is kept as it is.';
  case 'absent':
    return 'Rhythms has no saved rhythms yet, so the weekly schedule is running. Turn Rhythms off and on again in Features.';
  default:
    return 'Rhythms is not running, so the weekly schedule is in use. Your rhythms are kept.';
  }
}

// Each row is an absolute write, so any subset of a suggestion is itself a valid change.
export function withRows(rhythm: Rhythm, rows: SuggestionRow[]): Rhythm {
  const next = structuredClone(rhythm);
  for (const row of rows) {
    if (row.kind === 'base') {
      next.smart.baseLevel = row.baseLevel;
      continue;
    }
    if (row.kind === 'on') next.night.power.onTemperature = row.temperatureF;
    else next.night.temperatures[row.time] = row.temperatureF;
    if (row.thenBack) next.night.temperatures[row.thenBack.time] = row.thenBack.temperatureF;
  }
  return next;
}

export function applySuggestion(side: SideRhythms, rhythmId: string, rows: SuggestionRow[]): SideRhythms {
  if (!hasOwn(side.rhythms, rhythmId)) return side;
  return { ...side, rhythms: { ...side.rhythms, [rhythmId]: withRows(side.rhythms[rhythmId], rows) } };
}

export function restoreRhythm(side: SideRhythms, before: SideRhythms, id: string): SideRhythms {
  if (!hasOwn(side.rhythms, id) || !hasOwn(before.rhythms, id)) return side;
  return { ...side, rhythms: { ...side.rhythms, [id]: before.rhythms[id] } };
}

// The first sleep of the rhythm whose earliest change is still ahead; the power-on for an on or base row.
// `pausedUntil` is the side's pause end: null for a pause with no end, undefined when the side is not paused.
export function suggestionStart(
  sleeps: ResolvedSleepResponse[], rhythm: Rhythm, rows: SuggestionRow[], now: Date, today: string, timeZone: string,
  pausedUntil?: Date | null,
): SuggestionStart {
  if (pausedUntil === null) return { kind: 'paused' };
  const lead = Math.min(...rows.map(row => (row.kind === 'step' ? minutesAfterOn(row.time, rhythm.night.power.on) : 0)));
  const sleep = sleeps.filter(candidate => candidate.rhythmId === rhythm.id)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .find(candidate => Date.parse(candidate.start) + lead * 60_000 > now.getTime());
  if (!sleep) return { kind: 'none' };
  const start = Date.parse(sleep.start);
  // The pause end is exclusive, as in isSchedulePaused: a change due exactly then runs.
  if (pausedUntil && start + lead * 60_000 < pausedUntil.getTime()) return { kind: 'paused' };
  const running = start <= now.getTime() && now.getTime() < Date.parse(sleep.end);
  if (sleep.date !== today && !running) return { kind: 'date', date: sleep.date };
  if (!isDaySleep(new Date(start), new Date(sleep.wake ?? sleep.end), timeZone)) return { kind: 'tonight' };
  // A daytime rhythm names its time: the power-on, or once it runs, the first change still ahead.
  return { kind: 'today', at: moment.tz(running ? start + lead * 60_000 : start, timeZone).format('HH:mm') };
}
