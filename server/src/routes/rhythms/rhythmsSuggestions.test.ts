import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const HAND = rhythmOf('off-days', nightOf({ on: '22:00', off: '06:00', onTemperature: 82 }));
const everyDay = () => sideOf([HAND], Object.fromEntries(WEEK.map(day => [day, HAND.id])));
const DAY = 24 * 60 * 60 * 1000;
// Night k started k + 1 days ago at the same clock time and ended 8 hours later.
const start = (k: number) => Date.now() - (k + 1) * DAY;
const nightLine = (side: 'left' | 'right', k: number) => {
  const date = new Date(start(k)).toISOString().slice(0, 10);
  return {
    v: 1, kind: 'night', at: new Date(start(k)).toISOString(), side, rhythmId: HAND.id, mode: 'manual', planKey: rhythmPlanKey(HAND),
    date, sleepStart: new Date(start(k)).toISOString(), sleepEnd: new Date(start(k) + 8 * 60 * 60 * 1000).toISOString(),
  };
};
// Night k as above, with a hand change `offsetMin` after power-on from `fromF` to `targetF`.
const changeLine = (side: 'left' | 'right', k: number, offsetMin: number, fromF: number, targetF: number) => ({
  ...nightLine(side, k), kind: 'change', at: new Date(start(k) + offsetMin * 60_000).toISOString(),
  offsetMin, plannedF: 82, holdF: null, fromF, targetF, phase: null, held: false, source: 'api',
});
// `count` nights, oldest first, with a 23:30 change to 79 on the listed nights (0 is the oldest).
const habit = (side: 'left' | 'right', count: number, on: number[], extra: (k: number) => object[] = () => []) =>
  Array.from({ length: count }, (_, index) => count - 1 - index).flatMap(k => [
    nightLine(side, k),
    ...(on.includes(count - 1 - k) ? [changeLine(side, k, 90, 82, 79), ...extra(k)] : []),
  ]);
const seed = (lines: object[]) => writeFileSync(changesPath(), lines.map(line => `${JSON.stringify(line)}\n`).join(''));

let server: Server;
let baseUrl: string;
before(async () => {
  await schedulesDB.read();
  await createRhythms(dbOf(everyDay(), everyDay(), legacyFingerprint(schedulesDB.data)));
  const app = express();
  app.use(express.json());
  app.use(router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  rmSync(folder, { recursive: true, force: true });
});
beforeEach(async () => {
  await flushHandChanges();
  rmSync(changesPath(), { force: true });
  await updateSettings(draft => { draft.features.rhythmSuggestions = true; });
});

const get = async (query: string) => {
  const response = await fetch(`${baseUrl}/rhythms/suggestions${query}`);
  return { status: response.status, body: await response.json() };
};
const post = async (route: string, body: unknown) => {
  const response = await fetch(`${baseUrl}/rhythms/suggestions/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

describe('GET /rhythms/suggestions', () => {
  it('answers with every key empty while the feature is off', async () => {
    await updateSettings(draft => { draft.features.rhythmSuggestions = false; });
    assert.deepEqual((await get('?side=left')).body,
      { enabled: false, nights: {}, suggestions: [], dismissed: [], log: [] });
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
    assert.deepEqual(body.log.map((night: { date: string }) => night.date),
      [nightLine('right', 0).date, nightLine('right', 1).date, nightLine('right', 2).date]);
  });
});

describe('POST /rhythms/suggestions/exclude', () => {
  it('marks a night as a one-off and back', async () => {
    seed([nightLine('right', 1), nightLine('right', 0)]);
    const date = nightLine('right', 1).date;
    assert.equal((await post('exclude', { side: 'right', rhythmId: HAND.id, date, excluded: true })).status, 204);
    let { body } = await get('?side=right');
    assert.equal(body.nights[HAND.id].counted, 1);
    assert.equal(body.log.find((night: { date: string }) => night.date === date).excluded, true);
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
    } finally {
      await updateSettings(draft => { draft.features.rhythms = true; });
    }
  });
});

describe('hide and restore while Rhythms is not active', () => {
  it('refuse with 409', async () => {
    seed(habit('right', 6, [0, 1, 2, 3, 4, 5]));
    const { body } = await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'later' });
    await updateSettings(draft => { draft.features.rhythms = false; });
    try {
      assert.equal((await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'later' })).status, 409);
      assert.equal((await post('restore', { side: 'right', ids: body.ids })).status, 409);
    } finally {
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

describe('suggestions from the notes', () => {
  it('suggests a change made on enough nights, and offers a near miss below the gate', async () => {
    seed([...habit('right', 6, [0, 1, 2, 3, 4, 5]), ...habit('left', 7, [2, 4, 6])]);
    const right = (await get('?side=right')).body;
    assert.equal(right.nights[HAND.id].reason, 'suggested');
    assert.deepEqual(right.suggestions.map((entry: { near: boolean; rows: Array<{ time: string; temperatureF: number }> }) =>
      [entry.near, entry.rows.map(row => [row.time, row.temperatureF])]), [[false, [['23:30', 79]]]]);
    const left = (await get('?side=left')).body;
    assert.deepEqual(left.suggestions.map((entry: { near: boolean }) => entry.near), [true]);
  });
});

describe('POST /rhythms/suggestions/dismiss and /restore', () => {
  const twoRows = () => habit('right', 6, [0, 1, 2, 3, 4, 5], k => [changeLine('right', k, 360, 79, 84)]);

  it('hides the checked rows for this plan and brings them back', async () => {
    seed(twoRows());
    const dismissed = await post('dismiss', {
      side: 'right', rhythmId: HAND.id, scope: 'plan', rows: [{ key: 'step:down', time: '23:30' }, { key: 'step:up', time: '04:00' }],
    });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.ids.length, 2);
    let { body } = await get('?side=right');
    assert.deepEqual(body.suggestions, []);
    assert.equal(body.nights[HAND.id].reason, 'dismissed');
    assert.deepEqual(body.dismissed.map((entry: { scope: string; key: string; nightsLeft: number }) =>
      [entry.scope, entry.key, entry.nightsLeft]), [['plan', 'step:down', 0], ['plan', 'step:up', 0]]);
    assert.equal((await post('restore', { side: 'right', ids: dismissed.body.ids })).status, 204);
    ({ body } = await get('?side=right'));
    assert.equal(body.suggestions[0].rows.length, 2);
  });

  it('hides every row for 14 nights with one line', async () => {
    seed(twoRows());
    const dismissed = await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'later' });
    assert.equal(dismissed.body.ids.length, 1);
    const { body } = await get('?side=right');
    assert.deepEqual(body.suggestions, []);
    assert.deepEqual(body.dismissed.map((entry: { scope: string; key: null; time: null; nightsLeft: number }) =>
      [entry.scope, entry.key, entry.time, entry.nightsLeft]), [['later', null, null, 14]]);
  });

  it('refuses while the feature is off, for an unknown rhythm or id, or a bad body', async () => {
    seed(twoRows());
    assert.equal((await post('dismiss', { side: 'right', rhythmId: 'nope', scope: 'later' })).status, 404);
    assert.equal((await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'plan', rows: [] })).status, 400);
    assert.equal((await post('restore', { side: 'right', ids: ['0123456789ab'] })).status, 404);
    const { body } = await post('dismiss', { side: 'left', rhythmId: HAND.id, scope: 'later' });
    assert.equal((await post('restore', { side: 'right', ids: body.ids })).status, 404);
    await updateSettings(draft => { draft.features.rhythmSuggestions = false; });
    assert.equal((await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'later' })).status, 409);
    assert.equal((await post('restore', { side: 'left', ids: body.ids })).status, 409);
  });

  it('never writes the stored files', async () => {
    seed(twoRows());
    const files = ['rhythmsDB.json', 'settingsDB.json'].map(name => path.join(lowdb, name));
    const before = files.map(file => statSync(file).mtimeMs);
    const { body } = await post('dismiss', { side: 'right', rhythmId: HAND.id, scope: 'later' });
    await post('restore', { side: 'right', ids: body.ids });
    assert.deepEqual(files.map(file => statSync(file).mtimeMs), before);
  });
});
