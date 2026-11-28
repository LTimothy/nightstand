import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-alarm-route-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

let result = 10_000;
let release: (() => void) | undefined;
let started = 0;
const rung: unknown[] = [];
mock.module(new URL('../../jobs/alarmScheduler.js', import.meta.url).href, {
  namedExports: {
    executeAlarm: async (job: unknown) => {
      started++;
      rung.push(job);
      if (release === undefined) return result;
      await new Promise<void>(resolve => { release = resolve; });
      return result;
    },
  },
});

const dismissed: string[] = [];
let dismissFails = false;
mock.module(new URL('../../8sleep/dismissAlarm.js', import.meta.url).href, {
  namedExports: {
    dismissAlarm: async (side: string) => {
      dismissed.push(side);
      if (dismissFails) throw new Error('no connection');
    },
  },
});

const { default: router } = await import('./alarm.js');
const activeAlarms = await import('../../jobs/activeAlarms.js');
const { default: settingsDB } = await import('../../db/settings.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alarm`;
const snoozeUrl = `${url}/snooze`;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

const alarm = { side: 'left', vibrationIntensity: 1, vibrationPattern: 'rise', duration: 10, force: true };
const post = (body: unknown) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  result = 10_000;
  release = undefined;
  started = 0;
  rung.length = 0;
  dismissed.length = 0;
  dismissFails = false;
  activeAlarms.forgetActiveAlarm('left');
  activeAlarms.forgetActiveAlarm('right');
});

describe('POST /alarm', () => {
  it('answers 200 once the alarm has started', async () => {
    const response = await post(alarm);
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(started, 1);
  });

  it('answers 503 with a message when the alarm did not start', async () => {
    result = 0;
    const response = await post(alarm);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /did not start/);
  });

  it('waits for the start command before answering', async () => {
    release = () => undefined;
    let answered = false;
    const pending = post(alarm).then(response => { answered = true; return response.text(); });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(started, 1);
    assert.equal(answered, false);
    release();
    await pending;
    assert.equal(answered, true);
  });

  it('still rejects an invalid body', async () => {
    const response = await post({ ...alarm, side: 'middle' });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(started, 0);
  });
});

describe('POST /alarm/snooze', () => {
  const ringing = { vibrationIntensity: 40, duration: 120, vibrationPattern: 'rise' } as const;
  const snooze = (body: unknown) => fetch(snoozeUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const noAlarmTaps = () => {
    for (const gesture of ['doubleTap', 'tripleTap', 'quadTap'] as const) {
      settingsDB.data.left.taps[gesture] = { type: 'temperature', change: 'increment', amount: 2 };
    }
  };

  it('answers 409 when no alarm is ringing', async () => {
    const response = await snooze({ side: 'left' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'No alarm is ringing on this side' });
    assert.deepEqual(dismissed, []);
    assert.equal(activeAlarms.hasSnooze('left'), false);
  });

  it('answers 409 when the alarm is already snoozed and keeps that snooze', async () => {
    let fired = false;
    activeAlarms.setSnooze('left', 200, () => { fired = true; });
    const response = await snooze({ side: 'left' });
    assert.equal(response.status, 409);
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fired, true, 'the existing snooze was replaced or cancelled');
  });

  it('stops the ringing alarm and rings it again with the same settings', async t => {
    noAlarmTaps();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    activeAlarms.activeAlarms.set('left', { ...ringing });
    const response = await snooze({ side: 'left' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { snoozedUntil: new Date(1_800_000_300_000).toISOString() });
    assert.deepEqual(dismissed, ['left']);
    assert.equal(activeAlarms.activeAlarms.has('left'), false);
    assert.equal(activeAlarms.hasSnooze('left'), true);
    t.mock.timers.tick(299_999);
    assert.equal(rung.length, 0, 'rang before the snooze was up');
    t.mock.timers.tick(1);
    assert.deepEqual(rung, [{ side: 'left', ...ringing, force: true }]);
  });

  it('takes the snooze length from the first snooze gesture', async () => {
    noAlarmTaps();
    settingsDB.data.left.taps.tripleTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 60, inactiveAlarmBehavior: 'none' };
    settingsDB.data.left.taps.quadTap = { type: 'alarm', behavior: 'snooze', snoozeDuration: 120, inactiveAlarmBehavior: 'none' };
    activeAlarms.activeAlarms.set('left', { ...ringing });
    const before = Date.now();
    const response = await snooze({ side: 'left' });
    assert.equal(response.status, 200);
    const { snoozedUntil } = await response.json() as { snoozedUntil: string };
    const ms = Date.parse(snoozedUntil) - before;
    assert.ok(ms >= 120_000 && ms < 121_000, `snoozed for ${ms} ms`);
  });

  it('answers 503 when the alarm did not stop but the snooze is set', async () => {
    noAlarmTaps();
    dismissFails = true;
    activeAlarms.activeAlarms.set('left', { ...ringing });
    const response = await snooze({ side: 'left' });
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /did not stop/);
    assert.equal(activeAlarms.hasSnooze('left'), true);
  });

  it('rejects a bad body', async () => {
    for (const body of [{}, { side: 'middle' }, { side: 'left', minutes: 5 }]) {
      const response = await snooze(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json() as { error: string }).error, 'Invalid request data');
    }
  });
});
