import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-hand-changes-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
// The Smart Schedule controller's answers, set per test.
const smart = {
    gate: 'run', holdUntil: null, coolStart: undefined,
};
mock.module(new URL('./curveController.js', import.meta.url).href, {
    namedExports: {
        smartResolveHooks: { coolStartFor: () => smart.coolStart, powerOffFor: () => undefined },
        smartTemperatureGate: () => smart.gate,
        smartCurveStatus: () => (smart.holdUntil ? { holdUntil: smart.holdUntil } : null),
        smartManualChange: () => 'not-smart',
    },
});
const { default: config } = await import('../../config.js');
const { default: settingsDB } = await import('../../db/settings.js');
const { DEFAULT_SMART } = await import('../../db/rhythmsSchema.js');
const { currentSleep, setEngineActivation } = await import('../scheduleQueries.js');
const { dbOf, nightOf, rhythmOf, sideOf } = await import('./rhythmsTestData.js');
const notes = await import('./handChanges.js');
const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HAND = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82, temperatures: { '02:00': 79 } }));
const SMART = rhythmOf('workday', nightOf({ on: '22:00', off: '06:00', onTemperature: 82 }), {
    temperatureMode: 'smart', smart: { ...DEFAULT_SMART, baseLevel: 0 },
});
const sideWith = (rhythm) => sideOf([rhythm], Object.fromEntries(WEEK.map(day => [day, rhythm.id])));
const IN_NIGHT = new Date('2026-10-01T23:30:00.000Z');
function useRhythm(rhythm) {
    const db = dbOf(sideWith(rhythm), sideWith(rhythm));
    setEngineActivation({ active: true, db });
    return db;
}
const sleepAt = (at) => {
    const sleep = currentSleep('left', at);
    assert.ok(sleep, 'no sleep at that time');
    return sleep;
};
const fileLines = () => (existsSync(notes.changesPath())
    ? readFileSync(notes.changesPath(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []);
beforeEach(async () => {
    await notes.forgetHandChanges();
    await settingsDB.read();
    settingsDB.data.timeZone = 'UTC';
    settingsDB.data.features.rhythmSuggestions = true;
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].scheduleOverrides = {
            temperatureSchedules: { disabled: false, expiresAt: '' },
            alarm: { disabled: false, timeOverride: '', expiresAt: '' },
            pause: { active: false, expiresAt: '' },
        };
    }
    await settingsDB.write();
    smart.gate = 'run';
    smart.holdUntil = null;
    smart.coolStart = undefined;
    useRhythm(HAND);
});
after(() => rmSync(folder, { recursive: true, force: true }));
describe('notes file', () => {
    it('lives in the data folder, outside the watched lowdb folder, with a name the scripts are kept away from', () => {
        assert.equal(notes.changesPath(), `${folder}/rhythms-changes.jsonl`);
        assert.ok(!notes.changesPath().startsWith(config.lowDbFolder));
        assert.match(notes.CHANGES_FILE_NAME, /rhythms/);
    });
    it('keys a plan by its bedtime, on temperature, steps and Smart base only', () => {
        const key = notes.rhythmPlanKey(HAND);
        assert.match(key, /^[0-9a-f]{12}$/);
        const same = structuredClone(HAND);
        same.name = 'Renamed';
        same.wake = '05:00';
        same.night.power.off = '07:00';
        same.night.alarms = [];
        same.smart.baseLevel = 4;
        assert.equal(notes.rhythmPlanKey(same), key);
        for (const edit of [
            (rhythm) => { rhythm.night.power.on = '22:30'; },
            (rhythm) => { rhythm.night.power.onTemperature = 80; },
            (rhythm) => { rhythm.night.temperatures['23:45'] = 79; },
        ]) {
            const changed = structuredClone(HAND);
            edit(changed);
            assert.notEqual(notes.rhythmPlanKey(changed), key);
        }
        const cooler = structuredClone(SMART);
        cooler.smart.baseLevel = -1;
        assert.notEqual(notes.rhythmPlanKey(cooler), notes.rhythmPlanKey(SMART));
    });
    it('writes appended lines in order and reads them back', async () => {
        const id = notes.noteId();
        assert.match(id, /^[0-9a-f]{12}$/);
        await notes.appendNoteLines([
            { v: 1, kind: 'exclude', at: '2026-10-02T15:00:00.000Z', side: 'left', rhythmId: 'off-days', date: '2026-10-01', excluded: true },
            { v: 1, kind: 'restore', at: '2026-10-02T15:01:00.000Z', side: 'left', rhythmId: 'off-days', ids: [id] },
        ]);
        assert.deepEqual((await notes.readChanges()).map(line => line.kind), ['exclude', 'restore']);
    });
    it('loses no line when 20 writes arrive at once', async () => {
        await Promise.all(Array.from({ length: 20 }, (_, index) => notes.appendNoteLines([{
                v: 1, kind: 'exclude', at: new Date(Date.UTC(2026, 9, 2, 15, index)).toISOString(), side: 'left',
                rhythmId: 'off-days', date: '2026-10-01', excluded: index % 2 === 0,
            }])));
        assert.equal((await notes.readChanges()).length, 20);
    });
    it('lands a prune rewrite and a concurrent append, and survives a failed write', async () => {
        const exclude = (minute) => ({
            v: 1, kind: 'exclude', at: new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString(), side: 'left',
            rhythmId: 'off-days', date: '2026-10-01', excluded: true,
        });
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        const appended = notes.appendNoteLines([exclude(1)]);
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await Promise.all([appended, notes.flushHandChanges()]);
        assert.deepEqual(fileLines().map(line => line.kind), ['night', 'exclude', 'night']);
        const tmp = `${notes.changesPath()}.tmp`;
        mkdirSync(tmp);
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        rmSync(tmp, { recursive: true });
        await notes.appendNoteLines([exclude(2)]);
        assert.equal(fileLines().filter(line => line.kind === 'exclude').length, 2);
    });
    it('skips a bad line and reads a missing file as empty', async () => {
        assert.deepEqual(await notes.readChanges(), []);
        writeFileSync(notes.changesPath(), `not json\n${JSON.stringify({
            v: 1, kind: 'exclude', at: '2026-10-02T15:00:00.000Z', side: 'left', rhythmId: 'off-days', date: '2026-10-01', excluded: true,
        })}\n`);
        assert.equal((await notes.readChanges()).length, 1);
    });
    it('forgets after the writes queued before it, and forgets a missing file without error', async () => {
        const queued = notes.appendNoteLines([
            { v: 1, kind: 'exclude', at: '2026-10-02T15:00:00.000Z', side: 'left', rhythmId: 'off-days', date: '2026-10-01', excluded: true },
        ]);
        const forgot = notes.forgetHandChanges();
        await Promise.all([queued, forgot]);
        assert.equal(existsSync(notes.changesPath()), false);
        await notes.forgetHandChanges();
    });
});
describe('night line', () => {
    it('prunes non-JSON lines but keeps JSON lines this version cannot read', async () => {
        const future = { v: 2, kind: 'night', at: '2020-01-01T00:00:00.000Z', side: 'left' };
        const unknown = { v: 1, kind: 'mood', at: '2020-01-01T00:00:00.000Z' };
        writeFileSync(notes.changesPath(), [JSON.stringify(future), JSON.stringify(unknown), 'garbage', '[1]'].join('\n'));
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        assert.deepEqual(fileLines().map(line => line.kind), ['night', 'mood', 'night']);
        assert.equal(fileLines()[0].v, 2);
    });
    it('writes one line per Rhythms power-on while the feature is on', async () => {
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        const [line] = fileLines();
        assert.deepEqual(line, {
            v: 1, kind: 'night', at: IN_NIGHT.toISOString(), side: 'left', rhythmId: 'off-days', mode: 'manual',
            planKey: notes.rhythmPlanKey(HAND), date: '2026-10-01',
            sleepStart: '2026-10-01T22:00:00.000Z', sleepEnd: '2026-10-02T06:00:00.000Z',
        });
    });
    it('writes nothing while the feature is off', async () => {
        settingsDB.data.features.rhythmSuggestions = false;
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        assert.equal(existsSync(notes.changesPath()), false);
    });
    it('keeps 90 days of notes and every dismissal of a rhythm that still exists', async () => {
        const day = 24 * 60 * 60 * 1000;
        const at = (daysAgo) => new Date(IN_NIGHT.getTime() - daysAgo * day).toISOString();
        const exclude = (daysAgo) => ({
            v: 1, kind: 'exclude', at: at(daysAgo), side: 'left', rhythmId: 'off-days', date: '2026-06-01', excluded: true,
        });
        const dismiss = (rhythmId) => ({
            v: 1, kind: 'dismiss', id: 'a1b2c3d4e5f6', at: at(200), side: 'left', rhythmId, planKey: 'aaaaaaaaaaaa',
            key: 'step:down', time: '23:45', scope: 'plan',
        });
        writeFileSync(notes.changesPath(), [exclude(91), exclude(89), dismiss('off-days'), dismiss('gone'), 'garbage'].map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        assert.deepEqual(fileLines().map(line => [line.kind, line.rhythmId, line.at]), [
            ['exclude', 'off-days', at(89)], ['dismiss', 'off-days', at(200)], ['night', 'off-days', IN_NIGHT.toISOString()],
        ]);
    });
    it('prunes set lines after 90 days, like changes', async () => {
        const line = (at) => ({
            v: 1, kind: 'set', at, side: 'left', rhythmId: 'off-days', planKey: 'aaaaaaaaaaaa', date: at.slice(0, 10), targetF: 80, reason: 'step',
        });
        const old = '2026-06-01T00:00:00.000Z';
        const recent = '2026-09-30T00:00:00.000Z';
        writeFileSync(notes.changesPath(), [line(old), line(recent)].map(entry => JSON.stringify(entry)).join('\n'));
        notes.recordNight('left', sleepAt(IN_NIGHT), IN_NIGHT);
        await notes.flushHandChanges();
        assert.deepEqual(fileLines().map(entry => [entry.kind, entry.at]), [['set', recent], ['night', IN_NIGHT.toISOString()]]);
    });
});
describe('what the scheduler set', () => {
    it('writes one set line with the sleep\'s plan key, whole degrees, and null for off', async () => {
        const sleep = sleepAt(IN_NIGHT);
        notes.recordSet('left', sleep, 78.6, 'step', IN_NIGHT);
        notes.recordSet('left', sleep, null, 'off', IN_NIGHT);
        notes.recordSet('left', null, 80, 'hold-end', IN_NIGHT);
        await notes.flushHandChanges();
        assert.deepEqual(fileLines(), [
            { v: 1, kind: 'set', at: IN_NIGHT.toISOString(), side: 'left', rhythmId: 'off-days', planKey: notes.rhythmPlanKey(HAND),
                date: sleep.date, targetF: 79, reason: 'step' },
            { v: 1, kind: 'set', at: IN_NIGHT.toISOString(), side: 'left', rhythmId: 'off-days', planKey: notes.rhythmPlanKey(HAND),
                date: sleep.date, targetF: null, reason: 'off' },
            { v: 1, kind: 'set', at: IN_NIGHT.toISOString(), side: 'left', rhythmId: 'off-days', planKey: notes.rhythmPlanKey(HAND),
                date: sleep.date, targetF: 80, reason: 'hold-end' },
        ]);
    });
    it('writes nothing with the feature off, while paused, or outside a Rhythms sleep', async () => {
        settingsDB.data.features.rhythmSuggestions = false;
        notes.recordSet('left', sleepAt(IN_NIGHT), 79, 'step', IN_NIGHT);
        settingsDB.data.features.rhythmSuggestions = true;
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        notes.recordSet('left', sleepAt(IN_NIGHT), 79, 'step', IN_NIGHT);
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        notes.recordSet('left', null, 79, 'base', new Date('2026-10-01T15:00:00.000Z'));
        await notes.flushHandChanges();
        assert.deepEqual(fileLines(), []);
    });
});
describe('hand change', () => {
    const change = (over = {}) => ({
        targetF: 79, fromF: 82, on: true, setsOn: false, source: 'api', ...over,
    });
    const record = async (side, over = {}, at = IN_NIGHT) => {
        notes.recordHandChange(side, change(over), at);
        await notes.flushHandChanges();
        return fileLines();
    };
    it('writes the plan, the change and where the night stood', async () => {
        const [line] = await record('left');
        assert.deepEqual(line, {
            v: 1, kind: 'change', at: IN_NIGHT.toISOString(), side: 'left', rhythmId: 'off-days', mode: 'manual',
            planKey: notes.rhythmPlanKey(HAND), date: '2026-10-01',
            sleepStart: '2026-10-01T22:00:00.000Z', sleepEnd: '2026-10-02T06:00:00.000Z',
            offsetMin: 90, plannedF: 82, holdF: null, fromF: 82, targetF: 79, phase: null, held: false, source: 'api',
        });
    });
    it('takes the plan in force at the change, after a step', async () => {
        const [line] = await record('left', {}, new Date('2026-10-02T03:10:00.000Z'));
        assert.equal(line.plannedF, 79);
        assert.equal(line.offsetMin, 310);
    });
    it('stores a converted target as a whole degree', async () => {
        const [line] = await record('left', { targetF: 78.8, fromF: 81.6 });
        assert.equal(line.targetF, 79);
        assert.equal(line.fromF, 82);
    });
    it('marks a change made while the 12 hour override holds', async () => {
        settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: true, expiresAt: '2099-01-01T00:00:00Z' };
        const [line] = await record('left');
        assert.equal(line.held, true);
    });
    it('records an away side\'s change under the side the bed follows, with that side\'s readings', async () => {
        settingsDB.data.left.awayMode = true;
        const [line] = await record('left', { fromF: 81 });
        assert.equal(line.side, 'right');
        assert.equal(line.fromF, 81);
    });
    for (const [name, setup, over] of [
        ['with the feature off', () => { settingsDB.data.features.rhythmSuggestions = false; }, {}],
        ['without a time zone', () => { settingsDB.data.timeZone = ''; }, {}],
        ['when both sides are away', () => { settingsDB.data.left.awayMode = true; settingsDB.data.right.awayMode = true; }, {}],
        ['while paused', () => { settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' }; }, {}],
        ['under the weekly engine', () => { setEngineActivation({ active: false, reason: 'flag-off' }); }, {}],
        ['for a side known to be off', () => { }, { on: false }],
        ['for the power button sending the plan with the power-on', () => { }, { targetF: 82, setsOn: true }],
    ]) {
        it(`writes nothing ${name}`, async () => {
            setup();
            assert.deepEqual(await record('left', over), []);
        });
    }
    it('writes nothing outside a Rhythms sleep', async () => {
        assert.deepEqual(await record('left', {}, new Date('2026-10-02T12:00:00.000Z')), []);
    });
    it('keeps a change back to the plan when it does not turn the side on', async () => {
        assert.equal((await record('left', { targetF: 82, fromF: 79 })).length, 1);
        assert.equal((await record('left', { targetF: 82, on: null })).length, 2);
    });
    describe('on a Smart Schedule night', () => {
        beforeEach(() => { useRhythm(SMART); });
        it('takes the curve level, the night level, the phase and the hold', async () => {
            const sleep = sleepAt(IN_NIGHT);
            const points = sleep.smartCurve.points;
            const { levelAt, levelToF, phaseAt } = await import('../../db/smartCurve.js');
            const night = points.find(point => point.phase === 'hold') ?? points.filter(point => point.phase === 'cooldown').at(-1);
            smart.holdUntil = new Date(IN_NIGHT.getTime() + 60_000);
            const [line] = await record('left', { targetF: 74 });
            assert.equal(line.mode, 'smart');
            assert.equal(line.plannedF, levelToF(levelAt(points, IN_NIGHT)));
            assert.equal(line.holdF, levelToF(night.level));
            assert.equal(line.phase, phaseAt(points, IN_NIGHT));
            assert.equal(line.held, true);
            assert.equal(line.planKey, notes.rhythmPlanKey(SMART));
        });
        it('measures against the base while the bed is held at the base', async () => {
            smart.gate = 'base';
            const [line] = await record('left', { targetF: 74 });
            assert.equal(line.plannedF, 83);
        });
        it('follows a cool-down the controller moved later', async () => {
            const early = new Date('2026-10-01T22:20:00.000Z');
            const { levelAt, levelToF } = await import('../../db/smartCurve.js');
            const [clock] = await record('left', { targetF: 70 }, early);
            smart.coolStart = new Date('2026-10-01T23:30:00.000Z');
            const moved = sleepAt(early);
            const [, delayed] = await record('left', { targetF: 70 }, early);
            assert.equal(delayed.plannedF, levelToF(levelAt(moved.smartCurve.points, early)));
            assert.ok(clock.plannedF !== delayed.plannedF || clock.phase !== delayed.phase, 'the moved cool-down changed nothing');
        });
        it('drops the power button\'s curve value even while the gate sends the base', async () => {
            smart.gate = 'base';
            const { levelAt, levelToF } = await import('../../db/smartCurve.js');
            const curveF = levelToF(levelAt(sleepAt(IN_NIGHT).smartCurve.points, IN_NIGHT));
            assert.notEqual(curveF, 83, 'pick a time when the curve is off the base');
            assert.deepEqual(await record('left', { targetF: curveF, setsOn: true }), []);
        });
    });
});
//# sourceMappingURL=handChanges.test.js.map