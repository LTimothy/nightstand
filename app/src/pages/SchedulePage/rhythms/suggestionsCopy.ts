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
export const LEAVE_OUT = 'Leave out';
export const LEFT_OUT = ', left out';
export const LEAVE_OUT_HINT = 'Press Leave out on a night that should not count, such as a night away.';
export const HOW_THIS_WORKS = 'How this works';
export const HOW_TITLE = 'How suggestions work';
export const WHAT_COUNTS_TITLE = 'What counts';

const inTen = (share: number) => `${Math.round(share * 10)} in 10`;
const atLeast = (share: number) => (share === 0.5 ? 'half or more' : `${inTen(share)} or more`);
const count = (value: number, noun: string) => `${value} ${value === 1 ? noun : `${noun}s`}`;
const hours = (minutes: number) => count(minutes / 60, 'hour');

export const clockTime = (at: string | Date, timeZone: string) => moment.tz(at, timeZone).format('h:mm A');
export const clockOf = (time: string) => moment(time, 'HH:mm').format('h:mm A');

// In level format two Fahrenheit values can share a level; then both show in °F so a change never reads as "0 to 0".
export function pairTemperatures(fromF: number, toF: number, format: TemperatureFormat): [string, string] {
  const shared = format === 'level' && fromF !== toF && fahrenheitToLevel(fromF) === fahrenheitToLevel(toF);
  const shown: TemperatureFormat = shared ? 'fahrenheit' : format;
  return [displayTemperature(fromF, shown), displayTemperature(toF, shown)];
}

export const featureDescription = (rules: SuggestionRules = SUGGESTION_RULES) =>
  'Writes down when and how you change the temperature by hand during a rhythm, from any app or the cover. '
  + `A change you repeat on ${atLeast(rules.MIN_SHARE)} of your nights is suggested on Schedule. Nothing changes until you add it. `
  + `Notes stay on this Pod for ${rules.NOTE_DAYS} days, not in backups.`;

export const sectionCaption = (rules: SuggestionRules = SUGGESTION_RULES) =>
  `Nightstand writes down changes you make by hand during a rhythm. One you repeat on ${atLeast(rules.MIN_SHARE)} of your nights `
  + `is suggested here after ${rules.MIN_NIGHTS} nights.`;

// The rest of the rule (how a suggestion stays, the near miss floor) is in docs/VALIDATION.md.
export const howSuggestionsWork = (rules: SuggestionRules = SUGGESTION_RULES) =>
  `A change you make the same way, within about ${hours(rules.CLUSTER_MIN)}, on ${atLeast(rules.MIN_SHARE)} of your last `
  + `${rules.WINDOW_NIGHTS} nights is suggested after ${rules.MIN_NIGHTS} nights. The suggested time and temperature are the middle `
  + 'of those nights. On a Smart Schedule rhythm it suggests the base, one step at a time. Nothing changes until you add it.';

export const whatCounts = (smart: boolean, rules: SuggestionRules = SUGGESTION_RULES) =>
  'Changes you make by hand in this app, on the cover, or from another app on your network. '
  + 'Nightstand does not check whether anyone was in bed, so leave out a night you were away. '
  + `A change undone within ${rules.COALESCE_MIN} minutes, or made during a pause, is not noted.`
  + (smart ? ' On a Smart Schedule rhythm, only changes during the night count, of half a level or more.' : '');

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
    return mode === 'smart' ? `${name}: changes too small to suggest` : `${name}: already does what you set`;
  case 'refused':
    return `${name}: no room for this change`;
  case 'dismissed':
    return `${name}: suggestion hidden`;
  default:
    return null;
  }
}

export const notesTitle = (name?: string) => (name ? `Notes for ${name}` : 'Notes');
export const notesCountLine = (name: string, counted: number, earlier: boolean, rules: SuggestionRules = SUGGESTION_RULES) => {
  if (counted >= rules.WINDOW_NIGHTS) return `Your last ${rules.WINDOW_NIGHTS} nights.`;
  return earlier ? `${count(counted, 'night')} since you changed ${name}.` : `${count(counted, 'night')} so far.`;
};
export const nightLabel = (night: NightLog, leftOut = false) =>
  (night.tonight ? 'Tonight' : `${formatDate(night.date)}${leftOut ? LEFT_OUT : ''}`);
export const leaveOutName = (night: NightLog) => `${LEAVE_OUT}, ${formatDate(night.date)}`;

function changeText(change: NightLog['changes'][number], format: TemperatureFormat, timeZone: string): string {
  const from = change.fromF ?? change.plannedF;
  const [before, after] = pairTemperatures(from, change.targetF, format);
  // Only tags that explain a surprise: a planned value unlike both ends, and the cover. `held` stays in the log.
  const tags = [
    change.plannedF !== from && change.plannedF !== change.targetF ? `(planned ${displayTemperature(change.plannedF, format)})` : '',
    change.source === 'tap' ? '(cover)' : '',
  ].filter(Boolean);
  return [`${before} to ${after} at ${clockTime(change.at, timeZone)}`, ...tags].join(' ');
}

// One line per change. An ended night's date is its own line beside the toggle; tonight has none, so it leads the first line.
export function noteLines(night: NightLog, format: TemperatureFormat, timeZone: string): string[] {
  const lines = night.changes.length ? night.changes.map(change => changeText(change, format, timeZone)) : ['no change'];
  return night.tonight ? [`${nightLabel(night)}: ${lines[0]}`, ...lines.slice(1)] : lines;
}
