import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-franken-hand-change-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { } },
});
mock.module(new URL('./trimixBaseControl.js', import.meta.url).href, {
    namedExports: { trimixBase: { goToFlat: async () => { }, setPosition: async () => { } } },
});
let reads = [];
let onRead = () => { };
mock.module(new URL('./frankenServer.js', import.meta.url).href, {
    namedExports: {
        FrankenCommandTimeoutError: class extends Error {
        },
        getDeviceStatusCoalesced: async () => ({}),
        isFrankenConnected: () => true,
        connectFrankenWithin: async () => ({ callFunction: async () => { } }),
        connectFranken: async () => ({ getDeviceStatus: async () => { onRead(); return reads.shift(); } }),
    },
});
const changes = [];
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
    namedExports: {
        markManualTempChange: async (...args) => { changes.push(args); },
        isTempScheduleOverridden: () => false,
        OVERRIDE_WINDOW_HOURS: 3,
        OVERRIDE_DURATION_HOURS: 12,
    },
});
let FrankenMonitor;
let lastDeviceStatus;
let settingsDB;
before(async () => {
    ({ FrankenMonitor, lastDeviceStatus } = await import('./frankenMonitor.js'));
    ({ default: settingsDB } = await import('../db/settings.js'));
});
const sideStatus = (targetTemperatureF, doubleTap) => ({
    currentTemperatureLevel: 0, currentTemperatureF: 80, targetTemperatureF, secondsRemaining: 0, isOn: true,
    isAlarmVibrating: false, taps: { doubleTap, tripleTap: 0, quadTap: 0 },
});
const status = (leftTarget, doubleTap) => ({
    left: sideStatus(leftTarget, doubleTap), right: sideStatus(75, 0), waterLevel: 'true', isPriming: false,
    settings: { v: 1, gainLeft: 0, gainRight: 0, ledBrightness: 100 }, coverVersion: '1', hubVersion: '1',
    freeSleep: { version: '3.7.0', branch: 'dev' }, wifiStrength: 70, sensorTemps: null,
});
describe('cover taps as hand changes', () => {
    it('passes the written value, the previous read\'s target and on state, from the cover', async () => {
        await settingsDB.read();
        settingsDB.data.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 2 };
        await settingsDB.write();
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = status(82, 1);
        monitor.processGestures(status(82, 2));
        for (let i = 0; i < 20 && changes.length === 0; i++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(changes, [['left', { targetF: 80, fromF: 82, on: true, setsOn: false, source: 'tap' }]]);
    });
    it('keeps the latest read for routes to use', () => {
        const monitor = new FrankenMonitor();
        const read = status(77, 0);
        monitor.setDeviceStatus(read);
        assert.equal(lastDeviceStatus(), read);
        assert.equal(monitor.deviceStatus, read);
    });
    it('routes every read of the loop to the latest-read snapshot', async () => {
        const monitor = new FrankenMonitor();
        const first = status(70, 0);
        const polled = status(71, 0);
        reads = [first, polled];
        let calls = 0;
        onRead = () => { if (++calls === 2)
            monitor.stop(); };
        await monitor.start();
        for (let i = 0; i < 100 && lastDeviceStatus() !== polled; i++)
            await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(lastDeviceStatus(), polled);
    });
    it('passes a set temperature tap that turns an off side on', async () => {
        changes.length = 0;
        await settingsDB.read();
        settingsDB.data.left.taps.doubleTap = { type: 'set_temperature', temperatureF: 75 };
        await settingsDB.write();
        const monitor = new FrankenMonitor();
        const before = status(82, 1);
        before.left.isOn = false;
        monitor.deviceStatus = before;
        monitor.processGestures(status(82, 2));
        for (let i = 0; i < 20 && changes.length === 0; i++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(changes, [['left', { targetF: 75, fromF: 82, on: true, setsOn: true, source: 'tap' }]]);
    });
});
//# sourceMappingURL=frankenMonitor.handChange.test.js.map