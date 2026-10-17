import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-suggestions-route-'));
const lowdb = path.join(folder, 'lowdb');
mkdirSync(lowdb);
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
writeFileSync(path.join(lowdb, 'settingsDB.json'), JSON.stringify({ timeZone: 'UTC', features: { rhythms: true, rhythmSuggestions: true } }));
const { dbOf, nightOf, rhythmOf, schedulesOf, sideOf } = await import('../../jobs/rhythms/rhythmsTestData.js');
writeFileSync(path.join(lowdb, 'schedulesDB.json'), JSON.stringify(schedulesOf()));
const { default: router } = await import('./rhythms.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { updateSettings } = await import('../../db/settings.js');
const { createRhythms } = await import('../../db/rhythms.js');
const { legacyFingerprint } = await import('../../jobs/rhythms/fingerprint.js');
const { changesPath, flushHandChanges, rhythmPlanKey } = await import('../../jobs/rhythms/handChanges.js');
const { SuggestionsResponseSchema } = await import('../../db/rhythmsSchema.js');
const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HAND = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82 }));
const everyDay = () => sideOf([HAND], Object.fromEntries(WEEK.map(day => [day, HAND.id])));
const DAY = 24 * 60 * 60 * 1000;
// Night k started k + 1 days ago at the same clock time and ended 8 hours later.
const start = (k) => Date.now() - (k + 1) * DAY;
const nightLine = (side, k) => {
    const date = new Date(start(k)).toISOString().slice(0, 10);
    return {
        v: 1, kind: 'night', at: new Date(start(k)).toISOString(), side, rhythmId: HAND.id, mode: 'manual', planKey: rhythmPlanKey(HAND),
        date, sleepStart: new Date(start(k)).toISOString(), sleepEnd: new Date(start(k) + 8 * 60 * 60 * 1000).toISOString(),
    };
};
const seed = (lines) => writeFileSync(changesPath(), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
let server;
let baseUrl;
before(async () => {
    await schedulesDB.read();
    await createRhythms(dbOf(everyDay(), everyDay(), legacyFingerprint(schedulesDB.data)));
    const app = express();
    app.use(express.json());
    app.use(router);
    server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    rmSync(folder, { recursive: true, force: true });
});
beforeEach(async () => {
    await flushHandChanges();
    rmSync(changesPath(), { force: true });
    await updateSettings(draft => { draft.features.rhythmSuggestions = true; });
});
const get = async (query) => {
    const response = await fetch(`${baseUrl}/rhythms/suggestions${query}`);
    return { status: response.status, body: await response.json() };
};
const post = async (route, body) => {
    const response = await fetch(`${baseUrl}/rhythms/suggestions/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
};
describe('GET /rhythms/suggestions', () => {
    it('answers with every key empty while the feature is off', async () => {
        await updateSettings(draft => { draft.features.rhythmSuggestions = false; });
        assert.deepEqual((await get('?side=left')).body, { enabled: false, nights: {}, suggestions: [], dismissed: [], log: [] });
    });
    it('needs a side', async () => {
        assert.equal((await get('')).status, 400);
        assert.equal((await get('?side=middle')).status, 400);
    });
    it('counts the side\'s own nights and lists them newest first', async () => {
        seed([nightLine('right', 2), nightLine('right', 1), nightLine('right', 0), nightLine('left', 0)]);
        const { status, body } = await get('?side=right');
        assert.equal(status, 200);
        assert.equal(SuggestionsResponseSchema.safeParse(body).success, true);
        assert.deepEqual(body.nights[HAND.id], { counted: 3, needed: 5, changed: 0, earlier: false, reason: 'few-nights' });
        assert.deepEqual(body.log.map((night) => night.date), [nightLine('right', 0).date, nightLine('right', 1).date, nightLine('right', 2).date]);
    });
});
describe('POST /rhythms/suggestions/exclude', () => {
    it('marks a night as a one-off and back', async () => {
        seed([nightLine('right', 1), nightLine('right', 0)]);
        const date = nightLine('right', 1).date;
        assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: true })).status, 204);
        let { body } = await get('?side=right');
        assert.equal(body.nights[HAND.id].counted, 1);
        assert.equal(body.log.find((night) => night.date === date).excluded, true);
        assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: false })).status, 204);
        ({ body } = await get('?side=right'));
        assert.equal(body.nights[HAND.id].counted, 2);
    });
    it('refuses while the feature is off, for an unknown rhythm, a night with no notes, or a bad body', async () => {
        seed([nightLine('right', 0)]);
        const date = nightLine('right', 0).date;
        assert.equal((await post('exclude', { side: 'right', rhythmId: 'nope', date, excluded: true })).status, 404);
        assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date: '2020-01-01', excluded: true })).status, 400);
        assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: 'yes' })).status, 400);
        await updateSettings(draft => { draft.features.rhythmSuggestions = false; });
        assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: true })).status, 409);
    });
});
describe('exclude while Rhythms is not active', () => {
    it('refuses with 409', async () => {
        seed([nightLine('right', 0)]);
        const date = nightLine('right', 0).date;
        await updateSettings(draft => { draft.features.rhythms = false; });
        try {
            assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: true })).status, 409);
        }
        finally {
            await updateSettings(draft => { draft.features.rhythms = true; });
        }
    });
});
describe('POST /rhythms/suggestions/forget', () => {
    it('deletes the notes, also while the feature is off, and leaves nothing behind', async () => {
        seed([nightLine('right', 0)]);
        await updateSettings(draft => { draft.features.rhythmSuggestions = false; });
        assert.equal((await post('forget', {})).status, 204);
        assert.equal(existsSync(changesPath()), false);
        assert.equal(existsSync(`${changesPath()}.tmp`), false);
        assert.equal((await post('forget', {})).status, 204);
    });
});
describe('stored files', () => {
    it('are never written by the note routes', async () => {
        seed([nightLine('right', 0)]);
        const files = ['rhythmsDB.json', 'settingsDB.json'].map(name => path.join(lowdb, name));
        const before = files.map(file => statSync(file).mtimeMs);
        await post('exclude', { side: 'right', rhythmId: HAND.id, date: nightLine('right', 0).date, excluded: true });
        await post('forget', {});
        assert.deepEqual(files.map(file => statSync(file).mtimeMs), before);
    });
});
//# sourceMappingURL=rhythmsSuggestions.test.js.map