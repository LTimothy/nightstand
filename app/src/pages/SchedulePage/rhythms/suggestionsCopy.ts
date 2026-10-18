// Every sentence of Suggestions from your changes. Numbers come from the shared rules.
import moment from 'moment-timezone';
import type { Dismissed, NightLog, Rhythm, RhythmNights, SuggestionRow, ThenBack } from '@api/rhythmsSchema';
import { minutesAfterOn, temperatureInPowerWindow } from '@api/rhythmWake';
import { SUGGESTION_RULES, type SuggestionRules } from '@api/suggestionRules';
import { displayTemperature, fahrenheitToLevel, levelToFahrenheit, type TemperatureFormat } from '@lib/temperatureConversions';
import { clockAfterOn } from './nightsChartModel';
import type { Block } from './rhythmOverlay';
import { formatDate, type SuggestionStart } from './rhythmsModel';

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
export const SHOW_NIGHTS = 'Show the nights';
export const REVIEW = 'Review';
export const NIGHTS_HEADING = 'Your nights';
export const WITH_CHANGE_HEADING = 'With this change';
export const HIDDEN_HEADING = 'Hidden';
export const SHOW_AGAIN = 'Show again';
export const CARD_OVERLINE = 'Suggestion from your changes';
export const DONT_SUGGEST = "Don't suggest this";
export const DONT_SUGGEST_CHECKED = "Don't suggest the checked";
export const HIDE_ERROR = 'Could not hide this suggestion. Try again.';
export const SHOW_AGAIN_ERROR = 'Could not show it again. Try again.';
export const CHART_LEGEND = { change: 'With this change', night: 'A night', now: 'Now' } as const;

export const MATCH_SCHEDULE = 'Your nights match the schedule.';
export const MATCH_CURVE = 'Your nights match the curve.';

type ValueRow = Extract<SuggestionRow, { kind: 'step' | 'on' }>;

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
  'Notes your manual temperature changes during a rhythm and suggests the ones you repeat. '
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

const warmth = (direction: 'down' | 'up') => (direction === 'down' ? 'cooler' : 'warmer');
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const uncapitalized = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
const joinAnd = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

export const nightsSoFar = (nights: number) => `${count(nights, 'night')} so far.`;

// The sentence under a rhythm card's chart: what the typical night did where it left the schedule, in time order.
// A Smart rhythm's nights can differ from tonight's curve with no hand change, so the bed is the subject there.
export function typicalNightText(blocks: Block[], on: string, format: TemperatureFormat, smart: boolean): string {
  if (!blocks.length) return smart ? MATCH_CURVE : MATCH_SCHEDULE;
  const what = smart ? 'the curve' : 'the schedule';
  const round = SUGGESTION_RULES.TIME_ROUND_MIN;
  const clauses = blocks.map((block, index) => {
    const value = pairTemperatures(block.schedule[0].f, block.f, format)[1];
    if (!block.turned) {
      // Both printed values share a unit, so a level pair never mixes a level with °F.
      const [held, far] = pairTemperatures(block.f, block.farF, format);
      const [now, then] = held === value ? [held, far] : [block.f, block.farF].map(f => displayTemperature(f, 'fahrenheit'));
      return `${smart ? 'stayed' : 'kept it'} at ${now} while ${what} went ${block.farF < block.f ? 'down' : 'up'} to ${then}`;
    }
    const previous = blocks[index - 1];
    const verb = previous?.turned ? '' : smart ? (previous ? 'the bed went ' : 'went ') : 'turned it ';
    return `${verb}${block.turned} to ${value} around ${clockAfterOn(on, Math.round(block.from / round) * round)}`;
  });
  return `Most nights ${smart ? 'the bed' : 'you'} ${joinAnd(clauses)}.`;
}

// The value a row writes, read against the one it replaces.
const newValue = (row: ValueRow, format: TemperatureFormat) => pairTemperatures(row.plannedF, row.temperatureF, format)[1];
const backValue = (row: ValueRow, back: ThenBack, format: TemperatureFormat) =>
  pairTemperatures(row.temperatureF, back.temperatureF, format)[1];

export const reviewName = (name: string) => `Review suggestion for ${name}`;

// The count is in the label, so no note has to explain which rows Add takes.
export function addLabel(name: string, checked = 1, total = 1): string {
  if (total === 1 || checked === 0) return `Add to ${name}`;
  if (checked < total) return `Add ${checked} of ${total} to ${name}`;
  return total === 2 ? `Add both to ${name}` : `Add all ${total} to ${name}`;
}
export const dontSuggestLabel = (checked: number, total: number) => (checked < total ? DONT_SUGGEST_CHECKED : DONT_SUGGEST);
export const uncheckedNote = (unchecked: number) => (unchecked === 1
  ? 'The unchecked change starts counting again after you add.' : 'The unchecked changes start counting again after you add.');
export const showNightsLabel = (counted: number) => `Show the ${count(counted, 'night')}`;

function cardRow(row: SuggestionRow, format: TemperatureFormat): string {
  if (row.kind === 'base') return `base one step ${warmth(row.direction)}`;
  const value = row.kind === 'on' ? `starts at ${newValue(row, format)}` : `${newValue(row, format)} at ${clockOf(row.time)}`;
  return row.thenBack ? `${value}, back to ${backValue(row, row.thenBack, format)} at ${clockOf(row.thenBack.time)}` : value;
}

export const cardLine = (name: string, rows: SuggestionRow[], format: TemperatureFormat) =>
  `${name}: ${rows.map(row => cardRow(row, format)).join(', ')}`;

export const cardEvidence = (row: SuggestionRow, counted: number) => `From ${row.supporting} of ${counted} nights`;
// A card with two or three rows gives each its own count, on its own line.
export const cardRowLine = (row: SuggestionRow, counted: number, format: TemperatureFormat) =>
  `${cardRow(row, format)} · ${row.supporting} of ${counted} nights`;

export function nearLine(name: string, row: SuggestionRow, counted: number): string {
  const share = `on ${row.supporting} of ${counted} nights`;
  if (row.kind === 'step') return `${name}: ${warmth(row.direction)} around ${clockOf(row.time)} ${share}`;
  if (row.kind === 'on') return `${name}: a ${warmth(row.direction)} start ${share}`;
  return `${name}: ${warmth(row.direction)} than the night temperature ${share}`;
}

export const hiddenForLine = (name: string, nightsLeft: number) => `${name}: hidden for ${count(nightsLeft, 'more night')}`;
export const sheetOverline = (name: string, side: 'left' | 'right') => `${name}, ${side} side`;

function rowHeading(row: SuggestionRow): string {
  if (row.kind === 'step') return `${capitalized(warmth(row.direction))} around ${clockOf(row.time)}`;
  if (row.kind === 'on') return `${capitalized(warmth(row.direction))} start`;
  return `Base one step ${warmth(row.direction)}`;
}

export const sheetHeading = (rows: SuggestionRow[]) =>
  rows.map((row, index) => (index === 0 ? rowHeading(row) : uncapitalized(rowHeading(row)))).join(', ');

export function evidenceSentence(
  row: SuggestionRow, counted: number, format: TemperatureFormat, rules: SuggestionRules = SUGGESTION_RULES,
): string {
  const nights = `${row.supporting} of ${counted} nights`;
  if (row.kind === 'base') {
    return `${nights}: ${warmth(row.direction)} than the night temperature. The whole curve moves, warm start included.`;
  }
  const [before, after] = pairTemperatures(row.plannedF, row.temperatureF, format);
  let first: string;
  if (row.kind === 'on') first = `${nights}: about ${after} within ${rules.ON_WINDOW_MIN} minutes of turning on, instead of ${before}.`;
  else if (row.replaces) first = `${nights}: about ${after} instead of ${before} at ${clockOf(row.time)}.`;
  else first = `${nights}: ${before} to about ${after} around ${clockOf(row.time)}.`;
  if (!row.thenBack) return first;
  return `${first} ${row.thenBack.supporting} of those: back to ${backValue(row, row.thenBack, format)} around ${clockOf(row.thenBack.time)}.`;
}

// The night as text, so nothing is shown only in the chart.
export function withChangeRows(before: Rhythm, after: Rhythm, format: TemperatureFormat): string[] {
  if (before.temperatureMode === 'smart') {
    const now = displayTemperature(levelToFahrenheit(before.smart.baseLevel), format);
    const next = displayTemperature(levelToFahrenheit(after.smart.baseLevel), format);
    return [`Base: ${now} now, ${next} with this change`];
  }
  const { power, temperatures } = after.night;
  const changed = (was: number, value: number) => {
    const [old, shown] = pairTemperatures(was, value, format);
    return `${shown} | changed, was ${old}`;
  };
  const onText = power.onTemperature === before.night.power.onTemperature
    ? displayTemperature(power.onTemperature, format) : changed(before.night.power.onTemperature, power.onTemperature);
  const steps = Object.entries(temperatures)
    .filter(([time]) => temperatureInPowerWindow(time, power))
    .sort(([a], [b]) => minutesAfterOn(a, power.on) - minutesAfterOn(b, power.on))
    .map(([time, value]) => {
      const was = before.night.temperatures[time];
      const text = was === undefined ? `${displayTemperature(value, format)} | new`
        : was === value ? displayTemperature(value, format) : changed(was, value);
      return `${clockOf(time)} | ${text}`;
    });
  return [`${clockOf(power.on)} | On, ${onText}`, ...steps, `${clockOf(power.off)} | Off`];
}

export const provenance = (name: string) => `Middle values of those nights, rounded. Counted since you last changed ${name}.`;

export function startsLine(start: SuggestionStart, name: string): string {
  if (start.kind === 'tonight') return 'Starts tonight.';
  if (start.kind === 'today') return `Starts at ${clockOf(start.at)} today.`;
  if (start.kind === 'paused') return 'Starts after the pause.';
  if (start.kind === 'date') return `Starts ${formatDate(start.date)}.`;
  return `Starts next time ${name} runs.`;
}

export function undoAddMessage(name: string, rows: SuggestionRow[], format: TemperatureFormat): string {
  const base = rows.find(row => row.kind === 'base');
  if (base) return `${name} base is now one step ${warmth(base.direction)}`;
  const values = rows.filter((row): row is ValueRow => row.kind !== 'base');
  const starts = values.filter(row => row.kind === 'on').map(row => `starts at ${newValue(row, format)}`);
  const sets = values.flatMap(row => [
    ...(row.kind === 'step' ? [`${newValue(row, format)} at ${clockOf(row.time)}`] : []),
    ...(row.thenBack ? [`${backValue(row, row.thenBack, format)} at ${clockOf(row.thenBack.time)}`] : []),
  ]);
  return `${name} now ${joinAnd([...starts, ...(sets.length ? [`sets ${joinAnd(sets)}`] : [])])}`;
}

export const undoHideMessage = (name: string) => `${name}: suggestion hidden`;

export const hiddenIntro = (name: string) => `Not suggested again until you change ${name}, or press Show again.`;

function hiddenWhat(entry: Dismissed): string {
  if (entry.scope === 'later') return `all suggestions hidden for ${count(entry.nightsLeft, 'more night')}`;
  const [kind, direction] = (entry.key ?? '').split(':');
  const way = direction === 'up' ? 'warmer' : 'cooler';
  if (kind === 'step' && entry.time) return `${way} around ${clockOf(entry.time)}`;
  return kind === 'on' ? `a ${way} start` : `a ${way} base`;
}

export const hiddenRow = (entry: Dismissed) => (entry.scope === 'later' ? capitalized(hiddenWhat(entry)) : `Hidden: ${hiddenWhat(entry)}`);
export const showAgainName = (entry: Dismissed) => `Show again, ${entry.scope === 'later' ? 'all suggestions' : hiddenWhat(entry)}`;

export function chartCaption(nights: NightLog[], supportingDates: string[]): string {
  const quiet = nights.filter(logged => logged.changes.length === 0).length;
  const other = nights.filter(logged => logged.changes.length > 0 && !supportingDates.includes(logged.date)).length;
  return [
    'One line per night.',
    ...(quiet ? [quiet === 1 ? '1 had no change and sits on the dashed line.' : `${quiet} had no change and sit on the dashed line.`] : []),
    ...(other ? [`${other} had other changes.`] : []),
  ].join(' ');
}
