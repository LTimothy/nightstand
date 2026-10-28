import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
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
let noteSentTarget;
let clickCounts;
before(async () => {
    ({ FrankenMonitor, lastDeviceStatus } = await import('./frankenMonitor.js'));
    ({ default: settingsDB } = await import('../db/settings.js'));
    ({ noteSentTarget } = await import('./sentTargets.js'));
    clickCounts = await import('./clickCounts.js');
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
    it('notes a target the bed changed by itself, as a Pod 5 hub does for cover clicks', async () => {
        changes.length = 0;
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = status(78, 0);
        monitor.processGestures(status(80, 0));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(changes, [['left', { targetF: 80, fromF: 78, on: true, setsOn: false, source: 'tap' }]]);
    });
    it('leaves out targets Nightstand sent and sides that are off', async () => {
        changes.length = 0;
        const monitor = new FrankenMonitor();
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
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = status(78, 0);
        monitor.readAt = Date.now() - 120_000;
        noteSentTarget('left', 90, Date.now() - 90_000);
        monitor.processGestures(status(90, 0));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(changes, []);
    });
    it('notes a press back to a value sent before the previous read', async () => {
        changes.length = 0;
        const monitor = new FrankenMonitor();
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
        const monitor = new FrankenMonitor();
        const before = status(83, 0);
        monitor.deviceStatus = before;
        const after = status(86, 0);
        after.left.taps = { doubleTap: 0, tripleTap: 1, quadTap: 0 };
        before.left.taps = { doubleTap: 0, tripleTap: 0, quadTap: 0 };
        monitor.processGestures(after);
        for (let i = 0; i < 20 && changes.length === 0; i++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(changes, [['left', { targetF: 85, fromF: 83, on: true, setsOn: false, source: 'tap' }]]);
    });
});
describe('cover clicks with the firmware\'s click count', () => {
    const PREVIOUS = 1793101537;
    const TAP = 1793122973;
    const read = (leftTripleTap, rightTripleTap = PREVIOUS) => {
        const next = status(80, 0);
        next.left.taps = { doubleTap: 0, tripleTap: leftTripleTap, quadTap: 0 };
        next.right = sideStatus(80, 0);
        next.right.taps = { doubleTap: 0, tripleTap: rightTripleTap, quadTap: 0 };
        return next;
    };
    const record = (side, count) => clickCounts.noteButtonTap({ side, control: 'top', count, timestamp: TAP }, Date.now() / 1000);
    const writes = (side) => changes.filter(([changed]) => changed === side).map(([, change]) => change.targetF);
    // Waits for at least `count` writes, then a little longer so extra ones would show.
    const writesFinished = async (count) => {
        for (let i = 0; i < 200 && changes.length < count; i++)
            await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setTimeout(resolve, 50));
    };
    const started = async () => {
        const first = read(PREVIOUS);
        reads = [first];
        onRead = () => { };
        const monitor = new FrankenMonitor();
        await monitor.start();
        for (let i = 0; i < 200 && lastDeviceStatus() !== first; i++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(lastDeviceStatus(), first);
        return monitor;
    };
    beforeEach(async () => {
        changes.length = 0;
        clickCounts.resetClickCounts();
        await settingsDB.read();
        settingsDB.data.left.taps.tripleTap = { type: 'temperature', change: 'increment', amount: 1 };
        settingsDB.data.right.taps.tripleTap = { type: 'temperature', change: 'increment', amount: 1 };
        await settingsDB.write();
    });
    it('steps once for a timestamp jump of minutes with no record', async () => {
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = read(PREVIOUS);
        monitor.processGestures(read(TAP));
        await writesFinished(1);
        assert.deepEqual(writes('left'), [81]);
    });
    it('steps by the count of a record that arrived first', async () => {
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = read(PREVIOUS);
        record('left', 3);
        monitor.processGestures(read(TAP));
        await writesFinished(3);
        assert.deepEqual(writes('left'), [81, 82, 83]);
    });
    it('adds the rest when the record arrives after the step', async () => {
        const monitor = await started();
        try {
            monitor.processGestures(read(TAP));
            await writesFinished(1);
            assert.deepEqual(writes('left'), [81]);
            record('left', 3);
            await writesFinished(3);
            assert.deepEqual(writes('left'), [81, 82, 83]);
        }
        finally {
            monitor.stop();
        }
    });
    it('runs a set temperature tap once whatever the count', async () => {
        settingsDB.data.left.taps.tripleTap = { type: 'set_temperature', temperatureF: 75 };
        await settingsDB.write();
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = read(PREVIOUS);
        record('left', 3);
        monitor.processGestures(read(TAP));
        await writesFinished(1);
        assert.deepEqual(writes('left'), [75]);
    });
    it('a record alone steps nothing', async () => {
        const monitor = await started();
        try {
            record('left', 3);
            await writesFinished(1);
            assert.deepEqual(changes, []);
        }
        finally {
            monitor.stop();
        }
    });
    it('steps only the side the record names', async () => {
        const monitor = new FrankenMonitor();
        monitor.deviceStatus = read(PREVIOUS);
        record('right', 2);
        monitor.processGestures(read(TAP, TAP));
        await writesFinished(3);
        assert.deepEqual(writes('left'), [81]);
        assert.deepEqual(writes('right'), [81, 82]);
    });
});
//# sourceMappingURL=frankenMonitor.handChange.test.js.map