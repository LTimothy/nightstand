import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

// config.ts reads DATA_FOLDER at import time, so set it before importing.
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-rhythms-live-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
writeFileSync(path.join(folder, 'lowdb', 'settingsDB.json'), JSON.stringify({ timeZone: 'UTC' }));

const { default: router } = await import('./rhythms.js');
const { updateSettings } = await import('../../db/settings.js');
const { RhythmsLiveResponseSchema } = await import('../../db/rhythmsSchema.js');
const { applySmartCurve } = await import('../../jobs/rhythms/smartSleep.js');
const { startCurveController, stopCurveController } = await import('../../jobs/rhythms/curveController.js');

const MINUTE = 60_000;
// Smart Schedule curves differ for a sleep whose midpoint falls in daytime, so a wall clock that
// moves the fixture's night into the day changes the next change the route reports.
const NOW = Date.parse('2026-09-29T23:00:00Z');
let server: Server;
let baseUrl: string;

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const app = express();
  app.use(express.json());
  app.use(router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  mock.timers.reset();
  stopCurveController();
  await new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const alarm = {
  time: '06:30', enabled: true, alarmTemperature: 82, vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 60,
};

// A Smart Schedule night that starts at bedtime and lasts the given minutes.
const smartNight = (bedtime: Date, minutes: number, offWhenUp = false) => {
  const end = new Date(bedtime.getTime() + minutes * MINUTE);
  return applySmartCurve({
    side: 'left',
    date: '2026-09-29',
    rhythmId: 'workday',
    start: bedtime,
    end,
    wake: new Date(end.getTime() - 60 * MINUTE),
    night: { temperatures: {}, alarm, alarms: [], power: { on: '22:45', off: '07:45', onTemperature: 80, enabled: true } },
    mode: 'smart',
    ...(offWhenUp ? { offWhenUp: true as const } : {}),
    smart: { baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false, ...(offWhenUp ? { offWhenUp } : {}) },
    events: [
      { kind: 'power-on', at: bedtime, temperatureF: 80 },
      { kind: 'alarm', at: new Date(end.getTime() - 60 * MINUTE), alarm, index: 0 },
      { kind: 'power-off', at: end },
    ],
  }, 'UTC');
};

// A controller whose clock and left-side presence the test moves.
const controllerFor = (sleep: ReturnType<typeof smartNight>) => {
  let clock = new Date();
  const controller = startCurveController({
    now: () => clock,
    presence: () => ({
      left: { present: false, lastUpdatedAt: clock.toISOString(), stateChangedAt: clock.toISOString() },
      right: { present: false },
    }),
    awayMode: () => ({ left: false, right: false }),
    isPaused: () => false,
    sleeps: side => (side === 'left' ? [sleep] : []),
    applyLevel: async () => {},
    retime: () => {},
    recordHistory: async () => {},
  });
  const run = (nowAt: Date) => {
    clock = nowAt;
    return controller.tick();
  };
  return { controller, run };
};

const live = async (query: string) => {
  const res = await fetch(`${baseUrl}/rhythms/live${query}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /rhythms/live', () => {
  afterEach(() => stopCurveController());

  it('answers null while no Smart Schedule controller runs, and 400 without a side', async () => {
    assert.deepEqual(await live('?side=left'), { status: 200, body: null });
    assert.equal((await live('')).status, 400);
    assert.equal((await live('?side=left&extra=1')).status, 400);
    assert.equal((await live('?side=middle')).status, 400);
  });

  it('shows a manual hold and the next change, and follows the present side in away mode', async () => {
    const sleep = smartNight(new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 60 * MINUTE), 9 * 60);
    const { controller } = controllerFor(sleep);
    assert.equal(controller.noteManualChange('left', new Date()), 'held');

    const left = await live('?side=left');
    assert.equal(left.status, 200);
    const state = RhythmsLiveResponseSchema.parse(left.body);
    assert.ok(state);
    assert.equal(state.side, 'left');
    assert.equal(state.date, '2026-09-29');
    assert.equal(state.waiting, false);
    assert.ok(state.hold && Date.parse(state.hold.until) > Date.now());
    assert.deepEqual(state.nextChange, { at: state.hold.until, level: -2, phase: 'hold' });
    assert.equal(state.baseSince, null);
    assert.equal((await live('?side=right')).body, null);

    await updateSettings(draft => { draft.right.awayMode = true; });
    const right = await live('?side=right');
    await updateSettings(draft => { draft.right.awayMode = false; });
    assert.equal(right.body.side, 'left');
  });

  it('reports a cool-down that still waits for bed entry, ending at the cap', async () => {
    const bedtime = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 10 * MINUTE);
    const sleep = smartNight(bedtime, 9 * 60);
    const { run } = controllerFor(sleep);
    await run(new Date(bedtime.getTime() + MINUTE));
    await run(new Date());

    const state = RhythmsLiveResponseSchema.parse((await live('?side=left')).body);
    assert.ok(state);
    assert.equal(state.waiting, true);
    assert.equal(state.hold, null);
    assert.equal(state.coolStart, new Date(bedtime.getTime() + 120 * MINUTE).toISOString());
  });

  it('reports when the curve was released to the base level after waking', async () => {
    const bedtime = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 8 * 60 * MINUTE);
    const sleep = smartNight(bedtime, 8 * 60 + 55);
    const { run } = controllerFor(sleep);
    await run(new Date(bedtime.getTime() + MINUTE));
    await run(new Date());

    const state = RhythmsLiveResponseSchema.parse((await live('?side=left')).body);
    assert.ok(state);
    assert.ok(state.baseSince && Math.abs(Date.parse(state.baseSince) - Date.now()) < 5_000);
    assert.equal(state.waiting, false);
  });

  it('says when a "When I get up" sleep turns off at the latest while presence is fresh', async () => {
    const sleep = smartNight(new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 60 * MINUTE), 9 * 60, true);
    const controller = startCurveController({
      now: () => new Date(),
      presence: () => {
        const stamp = new Date().toISOString();
        return { left: { present: true, lastUpdatedAt: stamp, stateChangedAt: stamp }, right: { present: false } };
      },
      awayMode: () => ({ left: false, right: false }),
      isPaused: () => false,
      sleeps: side => (side === 'left' ? [sleep] : []),
      applyLevel: async () => {},
      retime: () => {},
      recordHistory: async () => {},
      smartOff: {
        sideIsOn: async () => true,
        powerOff: async () => true,
        armTimer: async () => true,
        alarmPending: () => false,
        nextRestart: () => null,
      },
    });
    await controller.tick();
    const state = RhythmsLiveResponseSchema.parse((await live('?side=left')).body);
    assert.equal(state?.offWhenUp?.by, new Date(sleep.end.getTime() + 3 * 60 * MINUTE).toISOString());
  });
});
