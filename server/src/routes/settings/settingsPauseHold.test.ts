import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-settings-pause-hold-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

// Firmware commands as sent, with a duration read when it goes out.
const sent: Array<[string, string]> = [];
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
  namedExports: {
    executeFunction: async (command: string, arg: string | (() => string) = 'empty') => {
      sent.push([command, typeof arg === 'function' ? arg() : arg]);
    },
  },
});
type SideRead = { isOn: boolean; secondsRemaining: number };
const pod: { left: SideRead; right: SideRead } = {
  left: { isOn: false, secondsRemaining: 0 }, right: { isOn: false, secondsRemaining: 0 },
};
let podReachable = true;
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
  namedExports: {
    connectFrankenWithin: async () => {
      if (!podReachable) throw new Error('No connection');
      return { getDeviceStatus: async () => structuredClone(pod) };
    },
  },
});
const resumes: string[] = [];
mock.module(new URL('../../jobs/resumeSchedule.js', import.meta.url).href, {
  namedExports: { resumeSchedule: async (side: string) => { resumes.push(side); } },
});

// The latest off of a "When I get up" sleep kept on past its set off.
let extendedUntil: Date | undefined;
mock.module(new URL('../../jobs/rhythms/curveController.js', import.meta.url).href, {
  namedExports: { smartOffExtendedUntil: () => extendedUntil },
});

const { default: settingsDB } = await import('../../db/settings.js');
const { clearEndedPause } = await import('../../jobs/pauseResume.js');
const { pauseHoldUntil } = await import('../../jobs/pauseHold.js');
const presence = (await import('../metrics/presence.js')).getPresenceData();
const { default: router } = await import('./settings.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings`;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

const HOUR = 3600;
const post = async (body: unknown) => {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
};
// The hub write runs after the answer; this waits for it to settle.
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const pauseLeft = (expiresAt: string) => post({ left: { scheduleOverrides: { pause: { active: true, expiresAt } } } });
const resumeLeft = () => post({ left: { scheduleOverrides: { pause: { active: false, expiresAt: '' } } } });
const seconds = (arg: string) => Number(arg);

beforeEach(async () => {
  sent.length = 0;
  resumes.length = 0;
  podReachable = true;
  extendedUntil = undefined;
  presence.left = { present: false };
  pod.left = { isOn: true, secondsRemaining: HOUR };
  pod.right = { isOn: false, secondsRemaining: 0 };
  await settingsDB.read();
  for (const side of ['left', 'right'] as const) {
    settingsDB.data[side].awayMode = false;
    settingsDB.data[side].scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
    settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
  }
  settingsDB.data.features.presenceAutoOff = true;
  await settingsDB.write();
});
afterEach(async () => {
  // Ends any hold a test left, so the next starts clean.
  podReachable = false;
  await resumeLeft();
  await settle();
  mock.timers.reset();
});

it('keeps a side that is on running until the pause ends', async () => {
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'LEFT_TEMP_DURATION');
  assert.ok(Math.abs(seconds(sent[0][1]) - 5 * HOUR) <= 2, sent[0][1]);
});

it('keeps it on for at most 12 hours', async () => {
  await pauseLeft(inSeconds(20 * HOUR));
  await settle();
  assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(12 * HOUR)]]);
});

it('sends nothing for a side that is off', async () => {
  pod.left = { isOn: false, secondsRemaining: 0 };
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  assert.deepEqual(sent, []);
});

it('never shortens a timer that already runs past the pause end', async () => {
  pod.left = { isOn: true, secondsRemaining: 10 * HOUR };
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  assert.deepEqual(sent, []);
});

it('leaves the timer alone for a pause until resumed and for a hand change hold', async () => {
  await pauseLeft('');
  await post({ left: { scheduleOverrides: { temperatureSchedules: { disabled: true, expiresAt: inSeconds(12 * HOUR) } } } });
  await settle();
  assert.deepEqual(sent, []);
});

it('keeps the pause saved when the Pod cannot be reached', async () => {
  podReachable = false;
  const expiresAt = inSeconds(5 * HOUR);
  await pauseLeft(expiresAt);
  await settle();
  await settingsDB.read();
  assert.deepEqual(sent, []);
  assert.equal(settingsDB.data.left.scheduleOverrides.pause.active, true);
  assert.equal(pauseHoldUntil('left'), undefined);
});

it('gives back the timer the pause replaced when it is resumed before the planned end', async () => {
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  pod.left.secondsRemaining = 5 * HOUR;
  sent.length = 0;
  await resumeLeft();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'LEFT_TEMP_DURATION');
  assert.ok(Math.abs(seconds(sent[0][1]) - HOUR) <= 2, sent[0][1]);
  assert.deepEqual(resumes, ['left']);
});

it('turns the side off when it is resumed after the planned end', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  mock.timers.tick(2 * HOUR * 1000);
  pod.left.secondsRemaining = 3 * HOUR;
  sent.length = 0;
  await resumeLeft();
  await settle();
  assert.deepEqual(sent, [['LEFT_TEMP_DURATION', '0']]);
});

it('leaves a side alone at the end when its timer was changed during the pause', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  mock.timers.tick(2 * HOUR * 1000);
  // Turned on again by hand: a fresh 12 hour timer.
  pod.left.secondsRemaining = 12 * HOUR;
  sent.length = 0;
  await resumeLeft();
  await settle();
  assert.deepEqual(sent, []);
});

it('gives back the planned timer when a shortened pause expires before the planned end', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  pod.left.secondsRemaining = 5 * HOUR;
  const shorter = inSeconds(HOUR / 2);
  await pauseLeft(shorter);
  await settle();
  mock.timers.tick((HOUR / 2 + 60) * 1000);
  pod.left.secondsRemaining = Math.round(4.5 * HOUR - 60);
  sent.length = 0;
  assert.equal(await clearEndedPause('left', shorter), true);
  assert.equal(sent.length, 1);
  assert.ok(Math.abs(seconds(sent[0][1]) - (HOUR / 2 - 60)) <= 2, sent[0][1]);
});

it('gives a side kept on until up its steps back when resumed before the latest off', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  pod.left = { isOn: true, secondsRemaining: 15 * 60 };
  extendedUntil = new Date(Date.now() + HOUR * 1000);
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  mock.timers.tick(HOUR / 2 * 1000);
  pod.left.secondsRemaining = 4.5 * HOUR;
  sent.length = 0;
  await resumeLeft();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'LEFT_TEMP_DURATION');
  assert.ok(Math.abs(seconds(sent[0][1]) - HOUR / 2) <= 2, sent[0][1]);
});

it('gives back the timer set by hand between two pauses, not the one before the first', async () => {
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  // Turned off and on by hand with a shorter timer, then paused for longer.
  pod.left.secondsRemaining = 3 * HOUR;
  await pauseLeft(inSeconds(8 * HOUR));
  await settle();
  pod.left.secondsRemaining = 8 * HOUR;
  sent.length = 0;
  await resumeLeft();
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(Math.abs(seconds(sent[0][1]) - 3 * HOUR) <= 2, sent[0][1]);
});

// Resumed two hours into a five hour pause, with the planned off an hour in.
const resumeLateWith = async (left: { present: boolean; lastUpdatedAt?: string }) => {
  pod.left = { isOn: true, secondsRemaining: HOUR };
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await pauseLeft(inSeconds(5 * HOUR));
  await settle();
  mock.timers.tick(2 * HOUR * 1000);
  pod.left.secondsRemaining = 3 * HOUR;
  presence.left = left;
  sent.length = 0;
  await resumeLeft();
  await settle();
};

it('leaves a side on when resumed after the planned end with someone in bed', async () => {
  await resumeLateWith({ present: true, lastUpdatedAt: new Date(Date.now() + 2 * HOUR * 1000).toISOString() });
  assert.deepEqual(sent, []);
});

it('turns the side off when resumed late while in bed but presence is stale or its auto-off is off', async () => {
  await resumeLateWith({ present: true, lastUpdatedAt: new Date(Date.now()).toISOString() });
  assert.deepEqual(sent, [['LEFT_TEMP_DURATION', '0']]);
  mock.timers.reset();
  await settingsDB.read();
  settingsDB.data.features.presenceAutoOff = false;
  await settingsDB.write();
  await resumeLateWith({ present: true, lastUpdatedAt: new Date(Date.now() + 2 * HOUR * 1000).toISOString() });
  assert.deepEqual(sent, [['LEFT_TEMP_DURATION', '0']]);
});
