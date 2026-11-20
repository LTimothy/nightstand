import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FrankenSupersededError } from '../8sleep/frankenErrors.js';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-power-reconnect-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

type Pending = { send: () => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
const writes: [string, string][] = [];
const submitted: string[] = [];
let connected = false;
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
  namedExports: {
    holdCommand: () => {},
    executeFunction: async (command: string, arg: string | (() => string), options: { latest?: boolean }) => {
      submitted.push(command);
      const value = () => typeof arg === 'function' ? arg() : arg;
      if (connected) { writes.push([command, value()]); return; }
      assert.equal(options.latest, true);
      // Model transport supersession without opening a socket.
      pending.get(command)?.reject(new FrankenSupersededError());
      await new Promise<void>((resolve, reject) => {
        pending.set(command, { reject, send: () => { writes.push([command, value()]); resolve(); } });
      });
    },
  },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
  namedExports: { connectFrankenWithin: async () => ({}), getDeviceStatusCoalesced: async () => ({}), isFrankenConnected: () => false },
});
const { default: settingsDB } = await import('../db/settings.js');
const { default: schedulesDB } = await import('../db/schedules.js');
const { weeklyPowerOnJob } = await import('./powerScheduler.js');
const { runRhythmEvent } = await import('./rhythms/runEvent.js');
const { resolveSleeps } = await import('./rhythms/resolve.js');
const { everyNight, testNight, testRhythmsDB } = await import('./rhythms/testSupport.js');
const { updateDeviceStatus } = await import('../routes/deviceStatus/updateDeviceStatus.js');

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T22:30:00Z') });
  connected = false;
  pending.clear(); writes.length = submitted.length = 0;
  settingsDB.data.timeZone = 'UTC';
  for (const side of ['left', 'right'] as const) {
    settingsDB.data[side].awayMode = false;
    settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
    settingsDB.data[side].scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
  }
  schedulesDB.data.left.sunday = testNight('20:00', '07:00');
  await settingsDB.write();
  await schedulesDB.write();
  mock.method(settingsDB, 'read', async () => {});
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
after(() => rmSync(folder, { recursive: true, force: true }));

for (const engine of ['weekly', 'rhythms']) {
  it(`${engine}: a manual off supersedes both starts waiting for reconnection`, async () => {
    const db = testRhythmsDB(schedulesDB.data, everyNight(schedulesDB.data.left.sunday));
    const sleep = resolveSleeps({ db, side: 'left', from: new Date(), to: new Date(), timeZone: 'UTC' })[0];
    const start = () => engine === 'weekly'
      ? weeklyPowerOnJob('left', 'sunday', schedulesDB.data.left.sunday.power, 'UTC')(new Date())
      : runRhythmEvent('left', sleep, { kind: 'power-on', at: new Date(), temperatureF: 80 });
    const first = start();
    await new Promise<void>(resolve => setImmediate(resolve));
    const second = start();
    await new Promise<void>(resolve => setImmediate(resolve));
    const off = updateDeviceStatus({ left: { isOn: false } });
    await new Promise<void>(resolve => setImmediate(resolve));
    connected = true;
    for (const entry of pending.values()) entry.send();
    pending.clear();
    await Promise.all([first, second, off]);
    assert.deepEqual(writes, [['LEFT_TEMP_DURATION', '0']]);
    assert.deepEqual(submitted, ['LEFT_TEMP_DURATION', 'LEFT_TEMP_DURATION', 'LEFT_TEMP_DURATION']);
  });
}
