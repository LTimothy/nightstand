import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rhythm } from '../../db/rhythmsSchema.js';
import { nightOf, rhythmOf } from './rhythmsTestData.js';
import {
  coalesceEpisodes, collapseNights, learnSuggestions, parseLine,
  type ChangeLine, type ExcludeLine, type Line, type NightLine, type PlannedRhythm,
} from './learn.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Night 0 powers on at 22:00 UTC on 2026-09-01 and ends 8 hours later.
const FIRST = Date.parse('2026-09-01T22:00:00.000Z');
const KEY = 'aaaaaaaaaaaa';
const OTHER_KEY = 'bbbbbbbbbbbb';
const HAND = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82 }));

const dateOf = (night: number) => new Date(FIRST + night * DAY).toISOString().slice(0, 10);
const sleepOf = (night: number, rhythm: Rhythm = HAND, planKey = KEY) => ({
  side: 'right' as const, rhythmId: rhythm.id, mode: rhythm.temperatureMode, planKey, date: dateOf(night),
  sleepStart: new Date(FIRST + night * DAY).toISOString(),
  sleepEnd: new Date(FIRST + night * DAY + 8 * HOUR).toISOString(),
});
const nightLine = (night: number, rhythm: Rhythm = HAND, planKey = KEY): NightLine => ({
  v: 1, kind: 'night', at: sleepOf(night, rhythm, planKey).sleepStart, ...sleepOf(night, rhythm, planKey),
});
const change = (night: number, offsetMin: number, fromF: number | null, targetF: number, over: Partial<ChangeLine> = {}): ChangeLine => ({
  v: 1, kind: 'change', ...sleepOf(night), at: new Date(FIRST + night * DAY + offsetMin * MINUTE).toISOString(),
  offsetMin, plannedF: 82, holdF: null, fromF, targetF, phase: null, held: false, source: 'api', ...over,
});
const nights = (count: number, rhythm: Rhythm = HAND, planKey = KEY) =>
  Array.from({ length: count }, (_, night) => nightLine(night, rhythm, planKey));
// One minute after night `night` ended.
const afterNight = (night: number) => new Date(FIRST + night * DAY + 8 * HOUR + MINUTE);
const planned = (rhythm: Rhythm = HAND, planKey = KEY): PlannedRhythm => ({ rhythm, planKey });
const exclude = (night: number, excluded: boolean, order = 0): ExcludeLine => ({
  v: 1, kind: 'exclude', at: new Date(FIRST + 30 * DAY + order * MINUTE).toISOString(),
  side: 'right', rhythmId: HAND.id, date: dateOf(night), excluded,
});

describe('note lines', () => {
  it('reads a line and drops keys it does not know', () => {
    const parsed = parseLine(JSON.stringify({ ...change(0, 60, 82, 79), extra: true }));
    assert.equal(parsed?.kind, 'change');
    assert.equal((parsed as Record<string, unknown>).extra, undefined);
  });

  it('skips unreadable lines, other versions and unknown kinds', () => {
    assert.equal(parseLine('not json'), null);
    assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), v: 2 })), null);
    assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), kind: 'mood' })), null);
    assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), targetF: 'cold' })), null);
  });
});

describe('note line bounds', () => {
  it('skips a change line with a temperature outside 55 to 110', () => {
    assert.equal(parseLine(JSON.stringify(change(0, 60, 82, 200))), null);
    assert.equal(parseLine(JSON.stringify(change(0, 60, 40, 79))), null);
    assert.equal(parseLine(JSON.stringify(change(0, 60, 82, 79, { holdF: 120 }))), null);
    assert.equal(parseLine(JSON.stringify(change(0, 60, 82, 79, { plannedF: 0 }))), null);
    assert.equal(parseLine(JSON.stringify(change(0, 60, 82, 79)))?.kind, 'change');
  });
});

describe('nights', () => {
  it('takes the latest end of a night written twice and leaves the night in progress uncounted', () => {
    const resumed = { ...nightLine(1), sleepEnd: new Date(FIRST + DAY + 9 * HOUR).toISOString() };
    const result = collapseNights([nightLine(0), nightLine(1), resumed, nightLine(2)], [], afterNight(1));
    assert.deepEqual(result.counted.map(night => night.date), [dateOf(0)]);
    assert.equal(result.tonight?.date, dateOf(2));
    const later = collapseNights([nightLine(0), nightLine(1), resumed], [], new Date(FIRST + DAY + 9 * HOUR));
    assert.deepEqual(later.counted.map(night => night.date), [dateOf(0), dateOf(1)]);
  });

  it('counts the most recent 14 ended nights', () => {
    const result = collapseNights(nights(20), [], afterNight(19));
    assert.equal(result.counted.length, 14);
    assert.equal(result.counted[0].date, dateOf(6));
    assert.equal(result.tonight, null);
  });

  it('leaves out a one-off night, lists it, and counts it again once marked back', () => {
    const excluded = collapseNights(nights(5), [exclude(2, true)], afterNight(4));
    assert.deepEqual(excluded.counted.map(night => night.date), [dateOf(0), dateOf(1), dateOf(3), dateOf(4)]);
    assert.deepEqual(excluded.excluded.map(night => night.date), [dateOf(2)]);
    const back = collapseNights(nights(5), [exclude(2, true, 0), exclude(2, false, 1)], afterNight(4));
    assert.equal(back.counted.length, 5);
    assert.deepEqual(back.excluded, []);
  });

  it('lists only one-off nights inside the counted window', () => {
    const result = collapseNights(nights(20), [exclude(1, true), exclude(10, true)], afterNight(19));
    assert.deepEqual(result.excluded.map(night => night.date), [dateOf(10)]);
  });
});

describe('episodes', () => {
  it('merges changes within 10 minutes of the first, keeping its from value and the last value', () => {
    const episodes = coalesceEpisodes([change(0, 60, 82, 80), change(0, 66, 80, 78), change(0, 72, 78, 77)]);
    assert.deepEqual(episodes.map(episode => [episode.offsetMin, episode.from, episode.targetF]), [[60, 82, 78], [72, 78, 77]]);
  });

  it('drops a press and undo', () => {
    assert.deepEqual(coalesceEpisodes([change(0, 60, 82, 80), change(0, 65, 80, 82)]), []);
  });

  it('keeps two changes 40 minutes apart, the second starting from the first one\'s value', () => {
    const episodes = coalesceEpisodes([change(0, 60, 82, 79), change(0, 100, 79, 82)]);
    assert.deepEqual(episodes.map(episode => [episode.from, episode.targetF]), [[82, 79], [79, 82]]);
  });

  it('falls back to the planned value when the bed\'s target was not known', () => {
    const [episode] = coalesceEpisodes([change(0, 60, null, 79, { plannedF: 81 })]);
    assert.equal(episode.from, 81);
    assert.equal(episode.fromF, null);
  });
});

describe('notes', () => {
  const run = (lines: Line[], now: Date, rhythms = [planned()]) => learnSuggestions(lines, rhythms, now);

  it('counts nights so far and needs 5', () => {
    const result = run(nights(4), afterNight(3));
    assert.deepEqual(result.nights[HAND.id], { counted: 4, needed: 5, changed: 0, earlier: false, reason: 'few-nights' });
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.dismissed, []);
  });

  it('says no change after 5 quiet nights', () => {
    assert.equal(run(nights(5), afterNight(4)).nights[HAND.id].reason, 'no-change');
  });

  it('counts nights with a kept change and ignores press and undo', () => {
    const lines = [...nights(5), change(0, 60, 82, 79), change(1, 60, 82, 80), change(1, 64, 80, 82)];
    assert.equal(run(lines, afterNight(4)).nights[HAND.id].changed, 1);
  });

  it('claims nothing about 5 nights with changes until the rules decide', () => {
    const lines = [...nights(5), change(0, 60, 82, 79), change(1, 300, 82, 85)];
    assert.equal(run(lines, afterNight(4)).nights[HAND.id].reason, 'suggested');
  });

  it('restarts the count under a new plan and says it counted before', () => {
    const result = run([...nights(6)], afterNight(5), [planned(HAND, OTHER_KEY)]);
    assert.deepEqual(result.nights[HAND.id], { counted: 0, needed: 5, changed: 0, earlier: true, reason: 'few-nights' });
  });

  it('restarts the count when the rhythm switches to Smart Schedule', () => {
    const smart = { ...HAND, temperatureMode: 'smart' as const };
    const result = run(nights(6), afterNight(5), [planned(smart)]);
    assert.equal(result.nights[HAND.id].counted, 0);
    assert.equal(result.nights[HAND.id].earlier, true);
  });

  it('logs every counted night newest first, quiet nights included, and tonight last to vote', () => {
    const lines = [
      ...nights(3), nightLine(3), change(1, 61, 82, 79, { held: true, source: 'tap' }), change(2, 30, 82, 81), change(2, 33, 81, 82),
    ];
    const { log } = run(lines, afterNight(2));
    assert.deepEqual(
      log.map(night => [night.date, night.tonight]),
      [[dateOf(3), true], [dateOf(2), false], [dateOf(1), false], [dateOf(0), false]],
    );
    assert.deepEqual(log[2].changes, [{ at: change(1, 61, 82, 79).at, fromF: 82, targetF: 79, plannedF: 82, held: true, source: 'tap' }]);
    assert.deepEqual(log[1].changes, []);
    assert.deepEqual(log[0].plan, [{ offsetMin: 0, temperatureF: 82 }]);
    assert.equal(log[0].endMin, 480);
  });

  it('logs the plan\'s steps in night order across midnight', () => {
    const stepped = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82, temperatures: { '03:00': 79, '23:30': 80 } }));
    const { log } = run(nights(1), afterNight(0), [planned(stepped)]);
    assert.deepEqual(log[0].plan, [
      { offsetMin: 0, temperatureF: 82 }, { offsetMin: 90, temperatureF: 80 }, { offsetMin: 300, temperatureF: 79 },
    ]);
  });

  it('marks a one-off night in the log', () => {
    const { log, nights: counts } = run([...nights(5), exclude(1, true)], afterNight(4));
    assert.equal(counts[HAND.id].counted, 4);
    assert.equal(log.find(night => night.date === dateOf(1))?.excluded, true);
  });

  it('keeps each rhythm to its own lines', () => {
    const weekend = rhythmOf('weekend', nightOf({ on: '23:00', off: '07:00', onTemperature: 80 }));
    const result = run([...nights(5), nightLine(5, weekend)], afterNight(5), [planned(), planned(weekend)]);
    assert.equal(result.nights[HAND.id].counted, 5);
    assert.equal(result.nights.weekend.counted, 1);
  });
});
