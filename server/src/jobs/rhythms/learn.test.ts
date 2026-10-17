import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rhythm } from '../../db/rhythmsSchema.js';
import { temperatureInPowerWindow } from '../../db/rhythmWake.js';
import { nightOf, rhythmOf } from './rhythmsTestData.js';
import {
  clusterEpisodes, coalesceEpisodes, collapseNights, learnSuggestions, majority, parseLine, placeManual,
  type ChangeLine, type ExcludeLine, type Line, type NightLine, type Gate, type PlannedRhythm, type Vote,
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

// Helpers for the rules below.
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index);
const episodesOf = (changes: ChangeLine[]) => [...new Set(changes.map(line => line.date))]
  .flatMap(date => coalesceEpisodes(changes.filter(line => line.date === date)));

describe('clusters', () => {
  it('holds a habit spread over two hours as one cluster', () => {
    const offsets = [60, 80, 100, 120, 140, 160, 180, 90, 110];
    const clusters = clusterEpisodes(episodesOf(offsets.map((offset, night) => change(night, offset, 82, 79))));
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].votes.length, 9);
  });

  it('keeps a change after midnight apart from one before dawn', () => {
    const lines = range(0, 9).flatMap(night => [change(night, 150, 82, 79), change(night, 360, 79, 82)]);
    const clusters = clusterEpisodes(episodesOf(lines));
    assert.deepEqual(clusters.map(cluster => [cluster.votes.length, cluster.votes[0].direction]), [[9, 'down'], [9, 'up']]);
  });

  it('counts an overshoot and its correction as one vote with the corrected value', () => {
    const [cluster] = clusterEpisodes(episodesOf([change(0, 60, 82, 78), change(0, 80, 78, 80)]));
    assert.deepEqual(cluster.votes, [{ date: dateOf(0), direction: 'down', value: 80, offset: 60, from: 82 }]);
  });

  it('gives no vote to a press and undo more than 10 minutes apart', () => {
    const [cluster] = clusterEpisodes(episodesOf([change(0, 60, 82, 80), change(0, 75, 80, 82)]));
    assert.deepEqual(cluster.votes, []);
  });

  it('is the same whatever order the changes come in', () => {
    const lines = range(0, 6).flatMap(night => [change(night, 50 + night * 7, 82, 79), change(night, 300, 79, 83)]);
    assert.deepEqual(clusterEpisodes(episodesOf([...lines].reverse())), clusterEpisodes(episodesOf(lines)));
  });

  it('finds no majority in a tie', () => {
    const vote = (direction: Vote['direction'], date: string): Vote => ({ date, direction, value: 80, offset: 60, from: 82 });
    assert.equal(majority([vote('down', dateOf(0)), vote('up', dateOf(1))]), null);
    assert.equal(majority([vote('down', dateOf(0)), vote('up', dateOf(1)), vote('down', dateOf(2))])?.supporting.length, 2);
  });
});

const FULL: Gate = { kind: 'full', shown: [] };
const place = (rhythm: Rhythm, lines: ChangeLine[], counted: number, gate: Gate = FULL) =>
  placeManual(rhythm, clusterEpisodes(episodesOf(lines)), counted, gate);
const down = (count: number, offset = 90) => range(0, count).map(night => change(night, offset, 82, 79));
const STEPPED = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82, temperatures: { '00:30': 79 } }));
const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

describe('placing hand-set rows', () => {
  it('needs half or more of the counted nights', () => {
    assert.deepEqual(place(HAND, down(2), 5), { rows: [], stages: ['inconsistent'] });
    assert.equal(place(HAND, down(3), 5).rows.length, 1);
    assert.equal(place(HAND, down(4), 7).rows.length, 1);
    assert.deepEqual(place(HAND, down(3), 7).stages, ['inconsistent']);
  });

  it('makes "down after midnight, back before dawn" one row with a return', () => {
    const lines = [...down(9, 150), ...range(0, 8).map(night => change(night, 360, 79, 82))];
    assert.deepEqual(place(HAND, lines, 14).rows.map(placed => placed.row), [{
      kind: 'step', key: 'step:down', direction: 'down', supporting: 9, firstNight: dateOf(0), lastNight: dateOf(8),
      supportingDates: range(0, 9).map(dateOf), time: '00:30', temperatureF: 79, plannedF: 82,
      thenBack: { time: '04:00', temperatureF: 82, supporting: 8 },
    }]);
  });

  it('leaves the return off when it happened on too few of those nights', () => {
    const lines = [...down(9, 150), ...range(0, 4).map(night => change(night, 360, 79, 82))];
    const { rows } = place(HAND, lines, 14);
    assert.equal(rows.length, 1);
    assert.equal((rows[0].row as { thenBack?: unknown }).thenBack, undefined);
  });

  it('makes "down, then up to a third value" two rows in night order, each valid on its own', () => {
    const lines = [...down(9, 150), ...range(0, 7).map(night => change(night, 360, 79, 84))];
    const rows = place(HAND, lines, 14).rows.map(placed => placed.row);
    assert.deepEqual(rows.map(row => (row.kind === 'step' ? [row.time, row.key, row.temperatureF, row.plannedF] : null)), [
      ['00:30', 'step:down', 79, 82], ['04:00', 'step:up', 84, 82],
    ]);
    for (const row of rows) assert.equal(row.kind === 'step' && temperatureInPowerWindow(row.time, HAND.night.power), true);
  });

  it('drops a return to the plan with no change before it', () => {
    assert.deepEqual(place(HAND, range(0, 9).map(night => change(night, 300, 80, 82)), 14), { rows: [], stages: [] });
  });

  it('suggests the on temperature for a change soon after power-on, with its return', () => {
    const lines = [...range(0, 8).map(night => change(night, 5, 82, 80)), ...range(0, 7).map(night => change(night, 300, 80, 82))];
    assert.deepEqual(place(HAND, lines, 12).rows.map(placed => placed.row), [{
      kind: 'on', key: 'on:down', direction: 'down', supporting: 8, firstNight: dateOf(0), lastNight: dateOf(7),
      supportingDates: range(0, 8).map(dateOf), temperatureF: 80, plannedF: 82,
      thenBack: { time: '03:00', temperatureF: 82, supporting: 7 },
    }]);
  });

  it('replaces a saved step close to the suggested time', () => {
    const lines = range(0, 9).map(night => change(night, 165, 79, 77, { plannedF: 79 }));
    assert.deepEqual(place(STEPPED, lines, 14).rows.map(placed => placed.row), [{
      kind: 'step', key: 'step:down', direction: 'down', supporting: 9, firstNight: dateOf(0), lastNight: dateOf(8),
      supportingDates: range(0, 9).map(dateOf), time: '00:30', replaces: '00:30', temperatureF: 77, plannedF: 79,
    }]);
  });

  it('drops a change that only sets a saved step a little early', () => {
    assert.deepEqual(place(STEPPED, down(9, 130), 14), { rows: [], stages: ['too-small'] });
  });

  it('refuses a step at the power-off or past the step limit', () => {
    assert.deepEqual(place(HAND, range(0, 9).map(night => change(night, 475, 82, 85)), 14), { rows: [], stages: ['refused'] });
    const crowded = rhythmOf('off-days', nightOf({
      on: '22:00', off: '06:00', onTemperature: 82,
      temperatures: Object.fromEntries(range(1, 49).map(minute => [clock(22 * 60 + minute), 82])),
    }));
    assert.deepEqual(place(crowded, down(9, 300), 14), { rows: [], stages: ['refused'] });
  });

  it('rounds the time to 15 minutes and a half-degree middle value toward the plan', () => {
    const lines = [...range(0, 4).map(night => change(night, 97, 82, 79)), ...range(4, 8).map(night => change(night, 97, 82, 80))];
    const [{ row }] = place(HAND, lines, 8).rows;
    assert.deepEqual(row.kind === 'step' && [row.time, row.temperatureF], ['23:30', 80]);
  });

  it('suggests a 1 °F habit', () => {
    const [{ row }] = place(HAND, range(0, 9).map(night => change(night, 90, 82, 81)), 14).rows;
    assert.equal(row.kind === 'step' && row.temperatureF, 81);
  });

  it('keeps a row on show down to 4 in 10, and uses the floor for a near miss', () => {
    assert.deepEqual(place(HAND, down(6), 14).stages, ['inconsistent']);
    assert.equal(place(HAND, down(6), 14, { kind: 'full', shown: [{ key: 'step:down', at: 120 }] }).rows.length, 1);
    assert.deepEqual(place(HAND, down(5), 14, { kind: 'full', shown: [{ key: 'step:down', at: 120 }] }).stages, ['inconsistent']);
    assert.equal(place(HAND, down(3), 7, { kind: 'near', floor: 3 }).rows.length, 1);
  });

  it('gives a cluster with a tied vote no row', () => {
    const lines = [change(0, 90, 82, 79), change(1, 90, 82, 85), change(2, 90, 82, 79), change(3, 90, 82, 85)];
    assert.deepEqual(place(HAND, lines, 5), { rows: [], stages: ['inconsistent'] });
  });
});
