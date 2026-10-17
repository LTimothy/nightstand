import assert from 'node:assert/strict';
import { it } from 'node:test';
import { nightOf, rhythmOf } from './rhythmsTestData.js';
import { clusterEpisodes, coalesceEpisodes, learnSuggestions, rhythmEvidence, type ChangeLine, type Line } from './learn.js';

// 43 nights with hand changes on 23 of them, all between 23:00 and 01:00, on a
// hand-set rhythm that powers on at 22:30: the shape of the owner's July and
// August log. A fixed generator keeps it the same on every run.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FIRST = Date.parse('2026-07-01T05:30:00.000Z');
const KEY = 'cccccccccccc';
const RHYTHM = rhythmOf('right-nights', nightOf({ on: '22:30', off: '07:00', onTemperature: 82 }));
// mulberry32, as the app's demo data uses.
let state = 20260701;
const next = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let mixed = Math.imul(state ^ (state >>> 15), state | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};
const order = Array.from({ length: 43 }, (_, night) => ({ night, key: next() })).sort((a, b) => a.key - b.key);
const changed = new Set(order.slice(0, 23).map(entry => entry.night));
const sleep = (night: number) => ({
  side: 'right' as const, rhythmId: RHYTHM.id, mode: 'manual' as const, planKey: KEY,
  date: new Date(FIRST + night * DAY).toISOString().slice(0, 10),
  sleepStart: new Date(FIRST + night * DAY).toISOString(),
  sleepEnd: new Date(FIRST + night * DAY + 8.5 * 60 * MINUTE).toISOString(),
});
const lines: Line[] = Array.from({ length: 43 }, (_, night) => ({
  v: 1 as const, kind: 'night' as const, at: sleep(night).sleepStart, ...sleep(night),
}));
const changes: ChangeLine[] = [...changed].map(night => {
  const offsetMin = 30 + Math.floor(next() * 120);
  return {
    v: 1, kind: 'change', ...sleep(night), at: new Date(FIRST + night * DAY + offsetMin * MINUTE).toISOString(), offsetMin,
    plannedF: 82, holdF: null, fromF: 82, targetF: next() < 0.5 ? 79 : 80, phase: null, held: false, source: 'api',
  };
});
const now = new Date(FIRST + 43 * DAY);

it('finds one habit in a month of changes spread from 23:00 to 01:00', () => {
  const episodes = [...changed].flatMap(night => coalesceEpisodes(changes.filter(line => line.date === sleep(night).date)));
  const clusters = clusterEpisodes(episodes);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].votes.length, 23);
});

it('counts the last 14 nights and answers for the rhythm', () => {
  const planned = { rhythm: RHYTHM, planKey: KEY };
  assert.equal(rhythmEvidence([...lines, ...changes], planned, now).counted.length, 14);
  const result = learnSuggestions([...lines, ...changes], [planned], now);
  assert.equal(result.nights[RHYTHM.id].counted, 14);
  assert.equal(result.nights[RHYTHM.id].reason, 'suggested');
  const [entry] = result.suggestions;
  assert.equal(entry.near, false);
  assert.deepEqual(entry.rows.map(row => row.kind === 'step' && [row.time, row.temperatureF, row.supporting]), [['23:30', 79, 7]]);
});
