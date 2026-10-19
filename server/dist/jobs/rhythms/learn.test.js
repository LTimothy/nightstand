import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SMART } from '../../db/rhythmsSchema.js';
import { temperatureInPowerWindow } from '../../db/rhythmWake.js';
import { nightOf, rhythmOf } from './rhythmsTestData.js';
import { clusterEpisodes, coalesceEpisodes, collapseNights, learnSuggestions, majority, parseLine, placeManual, placeSmart, rhythmEvidence, suggestedTime, } from './learn.js';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Night 0 powers on at 22:00 UTC on 2026-09-01 and ends 8 hours later.
const FIRST = Date.parse('2026-09-01T22:00:00.000Z');
const KEY = 'aaaaaaaaaaaa';
const OTHER_KEY = 'bbbbbbbbbbbb';
const HAND = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82 }));
const dateOf = (night) => new Date(FIRST + night * DAY).toISOString().slice(0, 10);
const sleepOf = (night, rhythm = HAND, planKey = KEY) => ({
    side: 'right', rhythmId: rhythm.id, mode: rhythm.temperatureMode, planKey, date: dateOf(night),
    sleepStart: new Date(FIRST + night * DAY).toISOString(),
    sleepEnd: new Date(FIRST + night * DAY + 8 * HOUR).toISOString(),
});
const nightLine = (night, rhythm = HAND, planKey = KEY) => ({
    v: 1, kind: 'night', at: sleepOf(night, rhythm, planKey).sleepStart, ...sleepOf(night, rhythm, planKey),
});
const change = (night, offsetMin, fromF, targetF, over = {}) => ({
    v: 1, kind: 'change', ...sleepOf(night), at: new Date(FIRST + night * DAY + offsetMin * MINUTE).toISOString(),
    offsetMin, plannedF: 82, holdF: null, fromF, targetF, phase: null, held: false, source: 'api', ...over,
});
const nights = (count, rhythm = HAND, planKey = KEY) => Array.from({ length: count }, (_, night) => nightLine(night, rhythm, planKey));
// One minute after night `night` ended.
const afterNight = (night) => new Date(FIRST + night * DAY + 8 * HOUR + MINUTE);
const planned = (rhythm = HAND, planKey = KEY) => ({ rhythm, planKey });
const exclude = (night, excluded, order = 0) => ({
    v: 1, kind: 'exclude', at: new Date(FIRST + 30 * DAY + order * MINUTE).toISOString(),
    side: 'right', rhythmId: HAND.id, date: dateOf(night), excluded,
});
describe('note lines', () => {
    it('reads a line and drops keys it does not know', () => {
        const parsed = parseLine(JSON.stringify({ ...change(0, 60, 82, 79), extra: true }));
        assert.equal(parsed?.kind, 'change');
        assert.equal(parsed.extra, undefined);
    });
    it('skips unreadable lines, other versions and unknown kinds', () => {
        assert.equal(parseLine('not json'), null);
        assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), v: 2 })), null);
        assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), kind: 'mood' })), null);
        assert.equal(parseLine(JSON.stringify({ ...change(0, 60, 82, 79), targetF: 'cold' })), null);
    });
});
describe('note lines', () => {
    it('reads what the scheduler set, with null for a power-off and any reason', () => {
        const set = {
            v: 1, kind: 'set', at: '2026-09-02T02:00:00.000Z', side: 'right', rhythmId: 'off-days', planKey: KEY, date: dateOf(0),
            targetF: 79, reason: 'step',
        };
        assert.deepEqual(parseLine(JSON.stringify(set)), set);
        assert.equal(parseLine(JSON.stringify({ ...set, targetF: null, reason: 'off' }))?.kind, 'set');
        assert.equal(parseLine(JSON.stringify({ ...set, reason: 'a-later-one' }))?.kind, 'set');
        assert.equal(parseLine(JSON.stringify({ ...set, targetF: 120 })), null);
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
    const run = (lines, now, rhythms = [planned()]) => learnSuggestions(lines, rhythms, now);
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
    it('says inconsistent when 5 nights hold changes that do not repeat', () => {
        const lines = [...nights(5), change(0, 60, 82, 79), change(1, 300, 82, 85)];
        assert.equal(run(lines, afterNight(4)).nights[HAND.id].reason, 'inconsistent');
    });
    it('restarts the count under a new plan and says it counted before', () => {
        const result = run([...nights(6)], afterNight(5), [planned(HAND, OTHER_KEY)]);
        assert.deepEqual(result.nights[HAND.id], { counted: 0, needed: 5, changed: 0, earlier: true, reason: 'few-nights' });
    });
    it('restarts the count when the rhythm switches to Smart Schedule', () => {
        const smart = { ...HAND, temperatureMode: 'smart' };
        const result = run(nights(6), afterNight(5), [planned(smart)]);
        assert.equal(result.nights[HAND.id].counted, 0);
        assert.equal(result.nights[HAND.id].earlier, true);
    });
    it('logs every counted night newest first, quiet nights included, and tonight last to vote', () => {
        const lines = [
            ...nights(3), nightLine(3), change(1, 61, 82, 79, { held: true, source: 'tap' }), change(2, 30, 82, 81), change(2, 33, 81, 82),
        ];
        const { log } = run(lines, afterNight(2));
        assert.deepEqual(log.map(night => [night.date, night.tonight]), [[dateOf(3), true], [dateOf(2), false], [dateOf(1), false], [dateOf(0), false]]);
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
const range = (from, to) => Array.from({ length: to - from }, (_, index) => from + index);
const episodesOf = (changes) => [...new Set(changes.map(line => line.date))]
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
        const vote = (direction, date) => ({ date, direction, value: 80, offset: 60, from: 82 });
        assert.equal(majority([vote('down', dateOf(0)), vote('up', dateOf(1))]), null);
        assert.equal(majority([vote('down', dateOf(0)), vote('up', dateOf(1)), vote('down', dateOf(2))])?.supporting.length, 2);
    });
});
const FULL = { kind: 'full', shown: [] };
const place = (rhythm, lines, counted, gate = FULL) => placeManual(rhythm, clusterEpisodes(episodesOf(lines)), counted, gate);
const down = (count, offset = 90) => range(0, count).map(night => change(night, offset, 82, 79));
const STEPPED = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82, temperatures: { '00:30': 79 } }));
const clock = (minute) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
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
        assert.equal(rows[0].row.thenBack, undefined);
    });
    it('makes "down, then up to a third value" two rows in night order, each valid on its own', () => {
        const lines = [...down(9, 150), ...range(0, 7).map(night => change(night, 360, 79, 84))];
        const rows = place(HAND, lines, 14).rows.map(placed => placed.row);
        assert.deepEqual(rows.map(row => (row.kind === 'step' ? [row.time, row.key, row.temperatureF, row.plannedF] : null)), [
            ['00:30', 'step:down', 79, 82], ['04:00', 'step:up', 84, 82],
        ]);
        for (const row of rows)
            assert.equal(row.kind === 'step' && temperatureInPowerWindow(row.time, HAND.night.power), true);
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
    it('refuses a step past the power-off or past the step limit', () => {
        assert.deepEqual(place(HAND, range(0, 9).map(night => change(night, 520, 82, 85)), 14), { rows: [], stages: ['refused'] });
        const crowded = rhythmOf('off-days', nightOf({
            on: '22:00', off: '06:00', onTemperature: 82,
            temperatures: Object.fromEntries(range(1, 49).map(minute => [clock(22 * 60 + minute), 82])),
        }));
        assert.deepEqual(place(crowded, down(9, 300), 14), { rows: [], stages: ['refused'] });
    });
    it('rounds a time that lands on the power-off inward to the last mark inside the night', () => {
        const late = rhythmOf('off-days', nightOf({ on: '22:07', off: '06:00', onTemperature: 82 }));
        const [{ row }] = place(late, range(0, 9).map(night => change(night, 466, 82, 85)), 14).rows;
        assert.deepEqual(row.kind === 'step' && [row.time, row.temperatureF], ['05:45', 85]);
    });
    it('pulls a habit at or just past the power-off back to the last mark inside the night', () => {
        const night = nightOf({ on: '22:00', off: '06:00', onTemperature: 82 });
        assert.deepEqual(suggestedTime(night, 480), { time: '05:45' });
        assert.deepEqual(suggestedTime(night, 485), { time: '05:45' });
        assert.equal(temperatureInPowerWindow(suggestedTime(night, 520).time, night.power), false);
    });
    // Guards the function only: a placed step is always at least 15 minutes in.
    it('rounds a time that lands on the power-on inward to the first mark inside the night', () => {
        const night = nightOf({ on: '22:05', off: '06:00', onTemperature: 82 });
        assert.deepEqual(suggestedTime(night, 1), { time: '22:15' });
    });
    it('refuses when no 15 minute mark fits inside the night', () => {
        const short = nightOf({ on: '22:01', off: '22:14', onTemperature: 82 });
        assert.equal(temperatureInPowerWindow(suggestedTime(short, 10).time, short.power), false);
    });
    it('rounds the time to 15 minutes and a half-degree middle value toward the plan', () => {
        const lines = [...range(0, 4).map(night => change(night, 97, 82, 79)), ...range(4, 8).map(night => change(night, 97, 82, 80))];
        const [{ row }] = place(HAND, lines, 8).rows;
        assert.deepEqual(row.kind === 'step' && [row.time, row.temperatureF], ['23:30', 80]);
    });
    it('rounds a half-degree middle value up when the plan is below it', () => {
        const lines = [...range(0, 4).map(night => change(night, 90, 82, 83)), ...range(4, 8).map(night => change(night, 90, 82, 84))];
        const [{ row }] = place(HAND, lines, 8).rows;
        assert.equal(row.kind === 'step' && row.temperatureF, 83);
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
const SMART = rhythmOf('workday', nightOf({ on: '22:00', off: '06:00' }), { temperatureMode: 'smart', smart: { ...DEFAULT_SMART } });
// The night level is 77 °F (level -2) in these fixtures.
const smartChange = (night, phase, targetF) => change(night, 120, 77, targetF, {
    rhythmId: SMART.id, mode: 'smart', phase, holdF: 77, plannedF: 77,
});
const smartPlace = (lines, count, rhythm = SMART, gate = FULL) => placeSmart(rhythm, rhythmEvidence(lines, planned(rhythm), afterNight(count - 1)), gate);
describe('Smart Schedule votes', () => {
    it('moves the base one step from changes at the night level', () => {
        const result = smartPlace([...nights(9, SMART), ...range(0, 7).map(night => smartChange(night, 'hold', 74))], 9);
        assert.equal(result.changed, 7);
        assert.deepEqual(result.rows.map(placed => placed.row), [{
                kind: 'base', key: 'base:down', direction: 'down', supporting: 7, firstNight: dateOf(0), lastNight: dateOf(6),
                supportingDates: range(0, 7).map(dateOf), baseLevel: -1, currentBaseLevel: 0,
            }]);
    });
    it('counts a cooler cool-down change, and a warmer night-level one', () => {
        assert.equal(smartPlace([...nights(5, SMART), ...range(0, 3).map(night => smartChange(night, 'cooldown', 74))], 5).rows.length, 1);
        const warmer = smartPlace([...nights(5, SMART), ...range(0, 3).map(night => smartChange(night, 'hold', 80))], 5);
        assert.equal(warmer.rows[0].row.kind === 'base' && warmer.rows[0].row.baseLevel, 1);
    });
    it('does not count a cool-down change at or warmer than the night level', () => {
        for (const targetF of [77, 79]) {
            // The curve is still warmer than the night level during the cool-down.
            const lines = range(0, 5).map(night => ({ ...smartChange(night, 'cooldown', targetF), fromF: 80 }));
            const result = smartPlace([...nights(5, SMART), ...lines], 5);
            assert.deepEqual({ rows: result.rows, stages: result.stages, changed: result.changed }, { rows: [], stages: ['too-small'], changed: 0 });
        }
    });
    it('does not count a change under half a level', () => {
        assert.deepEqual(smartPlace([...nights(5, SMART), ...range(0, 5).map(night => smartChange(night, 'hold', 76))], 5).stages, ['too-small']);
    });
    it('learns nothing from the warm-up', () => {
        assert.deepEqual(smartPlace([...nights(5, SMART), ...range(0, 5).map(night => smartChange(night, 'warmup', 85))], 5).stages, ['no-change']);
    });
    it('stays at the coldest base', () => {
        const coldest = { ...SMART, smart: { ...SMART.smart, baseLevel: -10 } };
        const lines = [...nights(5, SMART), ...range(0, 5).map(night => smartChange(night, 'hold', 74))];
        assert.deepEqual(smartPlace(lines, 5, coldest).stages, ['too-small']);
    });
    it('needs 5 counted nights for a full row even when all of them vote', () => {
        const lines = [...nights(4, SMART), ...range(0, 4).map(night => smartChange(night, 'hold', 74))];
        const result = smartPlace(lines, 4);
        assert.deepEqual({ rows: result.rows, stages: result.stages }, { rows: [], stages: ['inconsistent'] });
    });
    it('rounds each change to a level before taking the night\'s median', () => {
        const later = (night) => ({
            ...smartChange(night, 'hold', 74), offsetMin: 180, at: new Date(FIRST + night * DAY + 180 * MINUTE).toISOString(),
        });
        const lines = [...nights(5, SMART), ...range(0, 5).flatMap(night => [smartChange(night, 'hold', 78), later(night)])];
        const [placed] = smartPlace(lines, 5).rows;
        assert.equal(placed?.row.kind === 'base' && placed.row.baseLevel, -1);
    });
    it('needs the gate, or the floor for a near miss', () => {
        const lines = [...nights(7, SMART), ...[2, 4, 6].map(night => smartChange(night, 'hold', 74))];
        assert.deepEqual(smartPlace(lines, 7).stages, ['inconsistent']);
        assert.equal(smartPlace(lines, 7, SMART, { kind: 'near', floor: 3 }).rows.length, 1);
    });
});
const learn = (lines, now, rhythms = [planned()]) => learnSuggestions(lines, rhythms, now);
const entryOf = (result, id = HAND.id) => result.suggestions.find(entry => entry.rhythmId === id);
// `count` nights, with a 23:30 change to 79 on the listed nights.
const habit = (count, on) => [...nights(count), ...on.map(night => change(night, 90, 82, 79))];
describe('learning over nights', () => {
    it('waits for 5 nights and half or more of them', () => {
        assert.equal(entryOf(learn(habit(4, range(0, 4)), afterNight(3))), undefined);
        assert.equal(entryOf(learn(habit(5, [1, 3]), afterNight(4))), undefined);
        assert.equal(entryOf(learn(habit(5, [0, 1, 2]), afterNight(4)))?.rows.length, 1);
        assert.equal(entryOf(learn(habit(7, [3, 4, 5, 6]), afterNight(6)))?.rows.length, 1);
    });
    it('suggests a habit spread over two hours at its middle time', () => {
        const offsets = [60, 80, 100, 120, 140, 160, 180, 90, 110];
        const lines = [...nights(14), ...offsets.map((offset, night) => change(night, offset, 82, 79))];
        const entry = entryOf(learn(lines, afterNight(13)));
        assert.equal(entry?.near, false);
        assert.deepEqual(entry?.rows.map(row => row.kind === 'step' && [row.time, row.temperatureF]), [['23:45', 79]]);
    });
    it('counts only the last 14 nights', () => {
        const result = learn(habit(20, range(0, 8)), afterNight(19));
        assert.equal(entryOf(result), undefined);
        assert.deepEqual(result.nights[HAND.id], { counted: 14, needed: 5, changed: 2, earlier: false, reason: 'inconsistent' });
    });
    it('never lets the night in progress vote, and still logs it', () => {
        const lines = [...habit(5, [0, 1]), nightLine(5), change(5, 90, 82, 79)];
        const result = learn(lines, afterNight(4));
        assert.equal(entryOf(result), undefined);
        assert.equal(result.log[0].tonight, true);
        assert.equal(result.log[0].changes.length, 1);
    });
    it('restarts after the suggested change is added, and comes back on undo', () => {
        const lines = habit(9, range(0, 9));
        assert.equal(entryOf(learn(lines, afterNight(8)))?.rows.length, 1);
        const added = learn(lines, afterNight(8), [planned(STEPPED, OTHER_KEY)]);
        assert.equal(entryOf(added), undefined);
        assert.deepEqual(added.nights[HAND.id], { counted: 0, needed: 5, changed: 0, earlier: true, reason: 'few-nights' });
        assert.equal(entryOf(learn(lines, afterNight(8)))?.rows.length, 1);
    });
    it('keeps a row on show at 6 of 14 once it showed, and hides it at 5 of 14', () => {
        assert.equal(entryOf(learn(habit(15, range(0, 7)), afterNight(14)))?.near, false);
        const hidden = learn(habit(16, range(0, 7)), afterNight(15));
        assert.equal(hidden.suggestions.find(entry => !entry.near), undefined);
        assert.equal(hidden.nights[HAND.id].reason, 'inconsistent');
    });
    it('keeps a row that first showed before the last 14 nights while 6 of 14 still agree', () => {
        const on = [3, ...range(0, 45).filter(night => night % 7 <= 2)];
        for (let night = 17; night < 45; night++) {
            assert.equal(entryOf(learn(habit(night + 1, on.filter(change => change <= night)), afterNight(night)))?.near, false, `night ${night}`);
        }
    });
    it('does not give a full row at 6 of 14 to a pattern that never showed', () => {
        const result = learn(habit(14, [2, 4, 7, 9, 11, 13]), afterNight(13));
        assert.equal(result.suggestions.find(entry => !entry.near), undefined);
    });
    it('replays the same way every time', () => {
        const lines = habit(16, [0, 2, 3, 5, 8, 9, 12, 15]);
        assert.deepEqual(learn(lines, afterNight(15)), learn(lines, afterNight(15)));
    });
    it('lists exactly the supporting nights and counts the nights that voted', () => {
        const lines = [...habit(10, range(0, 7)), change(8, 90, 82, 85), change(9, 95, 82, 86)];
        const result = learn(lines, afterNight(9));
        const [row] = entryOf(result)?.rows ?? [];
        assert.deepEqual(row.supportingDates, range(0, 7).map(dateOf));
        assert.equal(result.nights[HAND.id].changed, 9);
    });
    it('gives the furthest reason a rhythm reached', () => {
        const reasonOf = (lines, count, rhythm = HAND) => learn(lines, afterNight(count - 1), [planned(rhythm)]).nights[rhythm.id].reason;
        assert.equal(reasonOf(nights(3), 3), 'few-nights');
        assert.equal(reasonOf(nights(5), 5), 'no-change');
        assert.equal(reasonOf(habit(5, [1, 3]), 5), 'inconsistent');
        assert.equal(reasonOf([...nights(9), ...down(9, 130)], 9, STEPPED), 'too-small');
        assert.equal(reasonOf([...nights(9), ...range(0, 9).map(night => change(night, 520, 82, 85))], 9), 'refused');
        assert.equal(reasonOf(habit(9, range(0, 9)), 9), 'suggested');
        assert.equal(reasonOf([...nights(5, SMART), ...range(0, 5).map(night => smartChange(night, 'warmup', 85))], 5, SMART), 'no-change');
    });
    it('says the changes match the plan when every night nets to zero', () => {
        const lines = [...nights(5), ...range(0, 5).flatMap(night => [change(night, 60, 82, 79), change(night, 90, 79, 82)])];
        assert.deepEqual(learn(lines, afterNight(4)).nights[HAND.id], { counted: 5, needed: 5, changed: 0, earlier: false, reason: 'too-small' });
    });
    it('suggests a Smart base through the same replay', () => {
        const lines = [...nights(9, SMART), ...range(0, 7).map(night => smartChange(night, 'hold', 74))];
        const entry = entryOf(learn(lines, afterNight(8), [planned(SMART)]), SMART.id);
        assert.deepEqual(entry?.rows.map(row => row.kind === 'base' && row.baseLevel), [-1]);
    });
});
describe('both sides written at once', () => {
    it('reads an away-mode write for both sides as one change', () => {
        const twice = [change(0, 90, 82, 79), change(0, 90, 82, 79)];
        assert.equal(coalesceEpisodes(twice).length, 1);
        const result = learnSuggestions([...nights(5), ...range(0, 3).flatMap(night => [change(night, 90, 82, 79), change(night, 90, 82, 79)])], [planned()], afterNight(4));
        assert.equal(result.nights[HAND.id].changed, 3);
        assert.equal(result.suggestions[0]?.rows[0]?.supporting, 3);
    });
});
const dismissal = (id, scope, key, time, atNight, planKey = KEY) => ({
    v: 1, kind: 'dismiss', id, at: afterNight(atNight).toISOString(), side: 'right', rhythmId: HAND.id, planKey, key, time, scope,
});
const restoring = (ids, atNight) => ({
    v: 1, kind: 'restore', at: new Date(afterNight(atNight).getTime() + 60_000).toISOString(), side: 'right', rhythmId: HAND.id, ids,
});
describe('hiding suggestions', () => {
    const every = habit(10, range(0, 10));
    it('hides everything for 14 nights of the rhythm, under any plan', () => {
        const later = dismissal('aaaaaaaaaaa1', 'later', null, null, 9);
        const hidden = learn([...every, later], afterNight(9));
        assert.equal(entryOf(hidden), undefined);
        assert.equal(hidden.nights[HAND.id].reason, 'dismissed');
        assert.deepEqual(hidden.dismissed, [{ id: 'aaaaaaaaaaa1', rhythmId: HAND.id, key: null, time: null, scope: 'later', nightsLeft: 14 }]);
        const otherPlan = range(10, 23).map(night => nightLine(night, HAND, OTHER_KEY));
        assert.equal(learn([...every, later, ...otherPlan], afterNight(22)).dismissed[0]?.nightsLeft, 1);
        const expired = learn([...every, later, ...otherPlan, nightLine(23, HAND, OTHER_KEY)], afterNight(23));
        assert.equal(entryOf(expired)?.rows.length, 1);
        assert.deepEqual(expired.dismissed, []);
    });
    it('ends a hide for 14 nights by age when a rare rhythm never counts them, as the notes are pruned', () => {
        const later = dismissal('aaaaaaaaaaa1', 'later', null, null, 9);
        const stillHidden = learn([...every, later], new Date(afterNight(9).getTime() + 89 * DAY));
        assert.equal(stillHidden.dismissed.length, 1);
        const aged = learn([...every, later], new Date(afterNight(9).getTime() + 91 * DAY));
        assert.deepEqual(aged.dismissed, []);
    });
    it('hides a row for this plan by kind, direction and a time within two hours', () => {
        assert.equal(entryOf(learn([...every, dismissal('aaaaaaaaaaa2', 'plan', 'step:down', '01:00', 9)], afterNight(9))), undefined);
        assert.equal(entryOf(learn([...every, dismissal('aaaaaaaaaaa2', 'plan', 'step:down', '02:00', 9)], afterNight(9)))?.rows.length, 1);
        assert.equal(entryOf(learn([...every, dismissal('aaaaaaaaaaa2', 'plan', 'step:up', '23:30', 9)], afterNight(9)))?.rows.length, 1);
        const otherKey = dismissal('aaaaaaaaaaa2', 'plan', 'step:down', '23:30', 9, OTHER_KEY);
        const result = learn([...every, otherKey], afterNight(9));
        assert.equal(entryOf(result)?.rows.length, 1);
        assert.deepEqual(result.dismissed, []);
    });
    it('lists a per-plan hide and brings the row back once it is restored', () => {
        const line = dismissal('aaaaaaaaaaa3', 'plan', 'step:down', '23:30', 9);
        assert.deepEqual(learn([...every, line], afterNight(9)).dismissed, [{ id: 'aaaaaaaaaaa3', rhythmId: HAND.id, key: 'step:down', time: '23:30', scope: 'plan', nightsLeft: 0 }]);
        const restored = learn([...every, line, restoring(['aaaaaaaaaaa3'], 9)], afterNight(9));
        assert.equal(entryOf(restored)?.rows.length, 1);
        assert.deepEqual(restored.dismissed, []);
    });
    it('caps the rows at 3 after hiding', () => {
        const four = range(0, 10).flatMap(night => [
            change(night, 30, 82, 79), change(night, 160, 79, 84), change(night, 290, 84, 80), change(night, 420, 80, 83),
        ]);
        const times = (lines) => entryOf(learn([...nights(10), ...lines], afterNight(9)))?.rows.map(row => row.kind === 'step' && row.time);
        assert.deepEqual(times(four), ['22:30', '00:45', '02:45']);
        assert.deepEqual(times([...four, dismissal('aaaaaaaaaaa4', 'plan', 'step:down', '22:30', 9)]), ['00:45', '02:45', '05:00']);
    });
});
describe('near misses', () => {
    const nearOf = (lines, count, rhythm = HAND) => learn(lines, afterNight(count - 1), [planned(rhythm)]).suggestions.find(entry => entry.rhythmId === rhythm.id && entry.near);
    it('starts at 7 counted nights with at least 3 behind it', () => {
        assert.equal(nearOf(habit(4, [0, 1, 2]), 4), undefined);
        assert.equal(nearOf(habit(7, [2, 4, 6]), 7)?.rows.length, 1);
        assert.equal(nearOf(habit(7, [2, 6]), 7), undefined);
    });
    it('needs about 4 in 10 of 14 nights, and has no band at 8 nights', () => {
        assert.equal(nearOf(habit(14, [2, 4, 7, 9, 11]), 14), undefined);
        const near = nearOf(habit(14, [2, 4, 7, 9, 11, 13]), 14);
        assert.deepEqual(near?.rows.map(row => [row.kind, row.supporting]), [['step', 6]]);
        assert.equal(nearOf(habit(8, [2, 4, 6]), 8), undefined);
    });
    it('keeps one per rhythm, the earliest on a tie, and leaves the reason alone', () => {
        const lines = [...habit(7, [2, 4, 6]), ...[1, 3, 6].map(night => change(night, 360, 82, 85))];
        const result = learn(lines, afterNight(6));
        const near = result.suggestions.filter(entry => entry.near);
        assert.equal(near.length, 1);
        assert.deepEqual(near[0].rows.map(row => row.kind === 'step' && row.time), ['23:30']);
        assert.equal(result.nights[HAND.id].reason, 'inconsistent');
    });
    it('is not offered beside a full suggestion', () => {
        const lines = [...habit(14, range(0, 9)), ...[1, 3, 5, 8, 10, 12].map(night => change(night, 360, 79, 85))];
        assert.deepEqual(learn(lines, afterNight(13)).suggestions.map(entry => entry.near), [false]);
    });
    it('can carry a return', () => {
        const lines = [...habit(14, [2, 4, 7, 9, 11, 13]), ...[2, 4, 7, 9, 11].map(night => change(night, 360, 79, 82))];
        const [row] = nearOf(lines, 14)?.rows ?? [];
        assert.deepEqual(row.kind === 'step' && row.thenBack, { time: '04:00', temperatureF: 82, supporting: 5 });
    });
    it('is never a change the plan makes or the editor refuses', () => {
        assert.equal(nearOf([...nights(14), ...[2, 4, 7, 9, 11, 13].map(night => change(night, 520, 82, 85))], 14), undefined);
        assert.equal(nearOf([...nights(14), ...[2, 4, 7, 9, 11, 13].map(night => change(night, 130, 82, 79))], 14, STEPPED), undefined);
    });
    it('stays hidden by Don\'t suggest this, even after it reaches the gate under the same plan', () => {
        const hide = dismissal('aaaaaaaaaaa5', 'plan', 'step:down', '23:30', 6);
        assert.equal(nearOf([...habit(7, [2, 4, 6]), hide], 7), undefined);
        const later = learn([...habit(14, [2, 4, 6, 7, 8, 9, 10, 11, 12]), hide], afterNight(13));
        assert.deepEqual(later.suggestions, []);
        assert.equal(later.nights[HAND.id].reason, 'dismissed');
    });
    it('is hidden by Hide for 14 nights', () => {
        assert.equal(nearOf([...habit(7, [2, 4, 6]), dismissal('aaaaaaaaaaa6', 'later', null, null, 6)], 7), undefined);
    });
    it('can be a Smart base', () => {
        const lines = [...nights(7, SMART), ...[2, 4, 6].map(night => smartChange(night, 'hold', 74))];
        assert.deepEqual(nearOf(lines, 7, SMART)?.rows.map(row => row.kind === 'base' && row.baseLevel), [-1]);
    });
});
describe('the nights a rhythm card draws', () => {
    const set = (night, offsetMin, targetF, reason = 'step', planKey = KEY) => ({
        v: 1, kind: 'set', at: new Date(FIRST + night * DAY + offsetMin * MINUTE).toISOString(), side: 'right', rhythmId: HAND.id,
        planKey, date: dateOf(night), targetF, reason,
    });
    it('lists the last 14 ended nights under any plan beside the counted ones, and marks which ran the saved plan', () => {
        const lines = [...nights(10, HAND, OTHER_KEY), ...Array.from({ length: 6 }, (_, k) => nightLine(10 + k))];
        const { log, nights: counts } = learnSuggestions(lines, [planned()], afterNight(15));
        assert.equal(counts[HAND.id].counted, 6);
        assert.deepEqual(log.map(night => night.date), range(2, 16).map(dateOf).reverse());
        assert.deepEqual(log.map(night => night.samePlan), [...Array(6).fill(true), ...Array(8).fill(false)]);
        assert.deepEqual(log.at(-1)?.plan, []);
        assert.equal(log.at(-1)?.changes.length, 0);
    });
    it('keeps a counted night older than the last 14 ended nights when left out nights pushed it back', () => {
        const lines = [...nights(16), exclude(14, true), exclude(15, true)];
        const { log } = learnSuggestions(lines, [planned()], afterNight(15));
        assert.deepEqual(log.map(night => night.date), range(0, 16).map(dateOf).reverse());
        assert.deepEqual(log.filter(night => night.excluded).map(night => night.date), [dateOf(15), dateOf(14)]);
    });
    it('gives a night its start and what the scheduler set, in time order, and a night under another plan its changes', () => {
        const lines = [
            nightLine(0), set(0, 240, 79), set(0, 0, 82, 'on'), set(0, 480, null, 'off'),
            nightLine(1, HAND, OTHER_KEY), change(1, 60, 82, 79, { planKey: OTHER_KEY }), set(1, 0, 82, 'on', OTHER_KEY),
        ];
        const { log } = learnSuggestions(lines, [planned()], afterNight(1));
        const [other, first] = log;
        assert.equal(first.start, sleepOf(0).sleepStart);
        assert.deepEqual(first.sets, [
            { at: set(0, 0, 82).at, temperatureF: 82 }, { at: set(0, 240, 79).at, temperatureF: 79 }, { at: set(0, 480, null).at, temperatureF: null },
        ]);
        assert.equal(other.samePlan, false);
        assert.equal(other.changes.length, 1);
        assert.deepEqual(other.sets, [{ at: set(1, 0, 82).at, temperatureF: 82 }]);
        assert.equal(log.find(night => night.sets === undefined), undefined);
    });
    it('describes a night edited mid-way by the current plan when both plans wrote the same end', () => {
        const lines = [nightLine(0, HAND, OTHER_KEY), nightLine(0)];
        const { log } = learnSuggestions(lines, [planned()], afterNight(0));
        assert.equal(log[0].samePlan, true);
        assert.equal(log[0].plan[0].temperatureF, 82);
    });
    it('leaves sets out of a night without any', () => {
        const [night] = learnSuggestions(nights(1), [planned()], afterNight(0)).log;
        assert.equal(night.sets, undefined);
        assert.equal(night.samePlan, true);
    });
});
//# sourceMappingURL=learn.test.js.map