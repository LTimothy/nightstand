// Every sentence of Suggestions from your changes. Numbers come from the shared rules.
import moment from 'moment-timezone';
import type { NightLog, RhythmNights } from '@api/rhythmsSchema';
import { SUGGESTION_RULES, type SuggestionRules } from '@api/suggestionRules';
import { displayTemperature, fahrenheitToLevel, type TemperatureFormat } from '@lib/temperatureConversions';
import { formatDate } from './rhythmsModel';

export const SECTION_TITLE = 'Suggestions';
export const FEATURE_TITLE = 'Suggestions from your changes';
export const AWAY_LINE = 'Away. Counting resumes when this side is back.';
export const LOAD_ERROR = 'Could not load suggestions.';
export const EXCLUDE_ERROR = 'Could not save that night. Try again.';
export const DELETE_NOTES = 'Delete notes';
export const DELETE_NOTES_QUESTION = 'Delete notes for both sides? Counting restarts tonight.';
export const DELETE_NOTES_ERROR = 'Could not delete notes. Try again.';

const inTen = (share: number) => `${Math.round(share * 10)} in 10`;
const atLeast = (share: number) => (share === 0.5 ? 'half or more' : `${inTen(share)} or more`);
const count = (value: number, noun: string) => `${value} ${value === 1 ? noun : `${noun}s`}`;
const hours = (minutes: number) => count(minutes / 60, 'hour');

export const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
export const clockTime = (at: string | Date, timeZone: string) => moment.tz(at, timeZone).format('h:mm A');
export const clockOf = (time: string) => moment(time, 'HH:mm').format('h:mm A');

// In level format two Fahrenheit values can share a level; then both show in °F so a change never reads as "0 to 0".
export function pairTemperatures(fromF: number, toF: number, format: TemperatureFormat): [string, string] {
  const shared = format === 'level' && fromF !== toF && fahrenheitToLevel(fromF) === fahrenheitToLevel(toF);
  const shown: TemperatureFormat = shared ? 'fahrenheit' : format;
  return [displayTemperature(fromF, shown), displayTemperature(toF, shown)];
}

export const featureDescription = (rules: SuggestionRules = SUGGESTION_RULES) =>
  'Notes when and how you change the temperature by hand during a rhythm, from any app or the cover. '
  + `A change you repeat on ${atLeast(rules.MIN_SHARE)} of your nights is suggested on Schedule. Nothing changes until you add it. `
  + `Notes stay on this Pod for ${rules.NOTE_DAYS} days, not in backups.`;

export const sectionCaption = (rules: SuggestionRules = SUGGESTION_RULES) =>
  `Nightstand notes changes you make by hand during a rhythm. One you repeat on ${atLeast(rules.MIN_SHARE)} of your nights `
  + `is suggested on this page after ${rules.MIN_NIGHTS} nights.`;

export const howSuggestionsWork = (rules: SuggestionRules = SUGGESTION_RULES) =>
  `After ${rules.MIN_NIGHTS} nights, a change in the same direction, within about ${hours(rules.CLUSTER_MIN)}, on `
  + `${atLeast(rules.MIN_SHARE)} of the last ${rules.WINDOW_NIGHTS} nights is suggested. It stays until fewer than `
  + `${inTen(rules.HIDE_SHARE)} agree. From ${rules.NEAR_MIN_NIGHTS} nights, one on ${inTen(rules.NEAR_SHARE)} nights, and at least `
  + `${rules.NEAR_MIN_SUPPORT}, is shown under Suggestions to review. Times and temperatures are middle values. On a Smart Schedule `
  + 'rhythm it suggests the base, one step at a time. Nothing changes until you add it.';

export const whatCounts = (rules: SuggestionRules = SUGGESTION_RULES) =>
  'Only hand changes count: in this app, on the cover, or from other apps on your network. Sleep data and presence are not used, '
  + `so a night counts even if nobody slept. Changes during a pause, or undone within ${rules.COALESCE_MIN} minutes, are left out. `
  + 'On a Smart Schedule rhythm, only changes at the night temperature, or cooler during the cool-down, of half a level or more. '
  + `Notes stay on this Pod for ${rules.NOTE_DAYS} days, not in backups. Turn this off in Settings, Features.`;

// The line under Suggestions for a rhythm; null when its card says it.
export function reasonLine(name: string, nights: RhythmNights, mode: 'manual' | 'smart'): string | null {
  switch (nights.reason) {
  case 'few-nights':
    return nights.counted === 0 && nights.earlier
      ? `${name}: counting again from tonight` : `${name}: ${nights.counted} of ${nights.needed} nights so far`;
  case 'no-change':
    return mode === 'smart'
      ? `${name}: no night temperature changes in ${count(nights.counted, 'night')}`
      : `${name}: no changes in ${count(nights.counted, 'night')}`;
  case 'inconsistent':
    return `${name}: changes on ${nights.changed} of ${nights.counted} nights, but not the same one`;
  case 'too-small':
    return mode === 'smart' ? `${name}: changes too small to suggest` : `${name}: your changes match the plan`;
  case 'refused':
    return `${name}: no room for this change`;
  case 'dismissed':
    return `${name}: suggestion hidden`;
  default:
    return null;
  }
}

export const notesTitle = (name?: string) => (name ? `Notes for ${name}` : 'Notes');
export const notesCountLine = (name: string, counted: number) =>
  `${count(counted, 'night')} since ${possessive(name)} times or temperatures changed. Mark an unusual night as a one-off to leave it out.`;
export const nightLabel = (night: NightLog) => (night.tonight ? 'Tonight' : formatDate(night.date));
export const oneOffName = (night: NightLog) => `One-off, ${formatDate(night.date)}`;

function changeText(change: NightLog['changes'][number], format: TemperatureFormat, timeZone: string): string {
  const from = change.fromF ?? change.plannedF;
  const [before, after] = pairTemperatures(from, change.targetF, format);
  const tags = [
    change.plannedF !== from ? `(planned ${displayTemperature(change.plannedF, format)})` : '',
    change.held ? '(while holding)' : '',
    change.source === 'tap' ? '(cover)' : '',
  ].filter(Boolean);
  return [`${before} to ${after} at ${clockTime(change.at, timeZone)}`, ...tags].join(' ');
}

// One line per change, the night's name on the first; a night with none says so.
export function noteLines(night: NightLog, format: TemperatureFormat, timeZone: string): string[] {
  const label = nightLabel(night);
  if (!night.changes.length) return [`${label}: no change`];
  return night.changes.map((change, index) => (index === 0
    ? `${label}: ${changeText(change, format, timeZone)}` : changeText(change, format, timeZone)));
}
