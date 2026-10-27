import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeviceStatus, SideStatus } from '../routes/deviceStatus/deviceStatusSchema.js';

const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-franken-hand-change-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: { updateDeviceStatus: async () => {} },
});
mock.module(new URL('./trimixBaseControl.js', import.meta.url).href, {
  namedExports: { trimixBase: { goToFlat: async () => {}, setPosition: async () => {} } },
});
let reads: DeviceStatus[] = [];
let onRead: () => void = () => {};
mock.module(new URL('./frankenServer.js', import.meta.url).href, {
  namedExports: {
    FrankenCommandTimeoutError: class extends Error {},
    getDeviceStatusCoalesced: async () => ({}),
    isFrankenConnected: () => true,
    connectFrankenWithin: async () => ({ callFunction: async () => {} }),
    connectFranken: async () => ({ getDeviceStatus: async () => { onRead(); return reads.shift(); } }),
  },
});
const changes: unknown[][] = [];
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
  namedExports: {
    markManualTempChange: async (...args: unknown[]) => { changes.push(args); },
    isTempScheduleOverridden: () => false,
    OVERRIDE_WINDOW_HOURS: 3,
    OVERRIDE_DURATION_HOURS: 12,
  },
});

let FrankenMonitor: typeof import('./frankenMonitor.js')['FrankenMonitor'];
let lastDeviceStatus: typeof import('./frankenMonitor.js')['lastDeviceStatus'];
let settingsDB: typeof import('../db/settings.js')['default'];
let noteSentTarget: typeof import('./sentTargets.js')['noteSentTarget'];

before(async () => {
  ({ FrankenMonitor, lastDeviceStatus } = await import('./frankenMonitor.js'));
  ({ default: settingsDB } = await import('../db/settings.js'));
  ({ noteSentTarget } = await import('./sentTargets.js'));
});

const sideStatus = (targetTemperatureF: number, doubleTap: number): SideStatus => ({
  currentTemperatureLevel: 0, currentTemperatureF: 80, targetTemperatureF, secondsRemaining: 0, isOn: true,
  isAlarmVibrating: false, taps: { doubleTap, tripleTap: 0, quadTap: 0 },
});
const status = (leftTarget: number, doubleTap: number): DeviceStatus => ({
  left: sideStatus(leftTarget, doubleTap), right: sideStatus(75, 0), waterLevel: 'true', isPriming: false,
  settings: { v: 1, gainLeft: 0, gainRight: 0, ledBrightness: 100 }, coverVersion: '1', hubVersion: '1',
  freeSleep: { version: '3.7.0', branch: 'dev' }, wifiStrength: 70, sensorTemps: null,
});
type Internals = {
  deviceStatus?: DeviceStatus; readAt: number; processGestures(next: DeviceStatus): void; setDeviceStatus(next: DeviceStatus): void;
};

describe('cover taps as hand changes', () => {
  it('passes the written value, the previous read\'s target and on state, from the cover', async () => {
    await settingsDB.read();
    settingsDB.data.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 2 };
    await settingsDB.write();
    const monitor = new FrankenMonitor() as unknown as Internals;
    monitor.deviceStatus = status(82, 1);
    monitor.processGestures(status(82, 2));
    for (let i = 0; i < 20 && changes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, [['left', { targetF: 80, fromF: 82, on: true, setsOn: false, source: 'tap' }]]);
  });

  it('keeps the latest read for routes to use', () => {
    const monitor = new FrankenMonitor() as unknown as Internals;
    const read = status(77, 0);
    monitor.setDeviceStatus(read);
    assert.equal(lastDeviceStatus(), read);
    assert.equal(monitor.deviceStatus, read);
  });

  it('routes every read of the loop to the latest-read snapshot', async () => {
    const monitor = new FrankenMonitor() as unknown as Internals & { start(): Promise<void>; stop(): void };
    const first = status(70, 0);
    const polled = status(71, 0);
    reads = [first, polled];
    let calls = 0;
    onRead = () => { if (++calls === 2) monitor.stop(); };
    await monitor.start();
    for (let i = 0; i < 100 && lastDeviceStatus() !== polled; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lastDeviceStatus(), polled);
  });

  it('passes a set temperature tap that turns an off side on', async () => {
    changes.length = 0;
    await settingsDB.read();
    settingsDB.data.left.taps.doubleTap = { type: 'set_temperature', temperatureF: 75 };
    await settingsDB.write();
    const monitor = new FrankenMonitor() as unknown as Internals;
    const before = status(82, 1);
    before.left.isOn = false;
    monitor.deviceStatus = before;
    monitor.processGestures(status(82, 2));
    for (let i = 0; i < 20 && changes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, [['left', { targetF: 75, fromF: 82, on: true, setsOn: true, source: 'tap' }]]);
  });

  it('notes a target the bed changed by itself, as a Pod 5 hub does for cover clicks', async () => {
    changes.length = 0;
    const monitor = new FrankenMonitor() as unknown as Internals;
    monitor.deviceStatus = status(78, 0);
    monitor.processGestures(status(80, 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, [['left', { targetF: 80, fromF: 78, on: true, setsOn: false, source: 'tap' }]]);
  });

  it('leaves out targets Nightstand sent and sides that are off', async () => {
    changes.length = 0;
    const monitor = new FrankenMonitor() as unknown as Internals;
    noteSentTarget('left', 84);
    monitor.deviceStatus = status(78, 0);
    monitor.processGestures(status(84, 0));
    const off = status(78, 0);
    off.left.isOn = false;
    monitor.deviceStatus = off;
    monitor.processGestures(status(86, 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, []);
  });

  it('counts a target sent while the reads were failing as ours, however long ago', async () => {
    changes.length = 0;
    const monitor = new FrankenMonitor() as unknown as Internals;
    monitor.deviceStatus = status(78, 0);
    monitor.readAt = Date.now() - 120_000;
    noteSentTarget('left', 90, Date.now() - 90_000);
    monitor.processGestures(status(90, 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, []);
  });

  it('notes a press back to a value sent before the previous read', async () => {
    changes.length = 0;
    const monitor = new FrankenMonitor() as unknown as Internals;
    noteSentTarget('left', 76, Date.now() - 30_000);
    monitor.deviceStatus = status(77, 0);
    monitor.readAt = Date.now();
    monitor.processGestures(status(76, 0));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, [['left', { targetF: 76, fromF: 77, on: true, setsOn: false, source: 'tap' }]]);
  });

  it('steps a tap from before the hub\'s own step when both land in one read, and notes it once', async () => {
    changes.length = 0;
    await settingsDB.read();
    settingsDB.data.left.taps.tripleTap = { type: 'temperature', change: 'increment', amount: 2 };
    await settingsDB.write();
    const monitor = new FrankenMonitor() as unknown as Internals;
    const before = status(83, 0);
    monitor.deviceStatus = before;
    const after = status(86, 0);
    after.left.taps = { doubleTap: 0, tripleTap: 1, quadTap: 0 };
    before.left.taps = { doubleTap: 0, tripleTap: 0, quadTap: 0 };
    monitor.processGestures(after);
    for (let i = 0; i < 20 && changes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes, [['left', { targetF: 85, fromF: 83, on: true, setsOn: false, source: 'tap' }]]);
  });

  it('steps once for each click when two land in one read', async () => {
    changes.length = 0;
    await settingsDB.read();
    settingsDB.data.left.taps.tripleTap = { type: 'temperature', change: 'increment', amount: 2 };
    await settingsDB.write();
    const monitor = new FrankenMonitor() as unknown as Internals;
    const before = status(83, 0);
    monitor.deviceStatus = before;
    const after = status(89, 0);
    after.left.taps = { doubleTap: 0, tripleTap: 2, quadTap: 0 };
    before.left.taps = { doubleTap: 0, tripleTap: 0, quadTap: 0 };
    monitor.processGestures(after);
    for (let i = 0; i < 20 && changes.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes.map(([, change]) => (change as { targetF: number }).targetF), [85, 87]);
  });
});
