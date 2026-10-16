import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Same isolated-temp-DATA_FOLDER pattern as db/services.test.ts.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-franken-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let updateRejectsWith = null;
let updateCalls = 0;
let updatedStatus;
// Every left target written, in order, and how many writes overlapped.
let writtenLeftTargets = [];
let updateDelayMs = 0;
let writesInFlight = 0;
let mostWritesInFlight = 0;
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: {
        updateDeviceStatus: async (status) => {
            updatedStatus = status;
            updateCalls += 1;
            if (typeof status.left?.targetTemperatureF === 'number')
                writtenLeftTargets.push(status.left.targetTemperatureF);
            writesInFlight += 1;
            mostWritesInFlight = Math.max(mostWritesInFlight, writesInFlight);
            try {
                if (updateDelayMs)
                    await new Promise((resolve) => setTimeout(resolve, updateDelayMs));
                if (updateRejectsWith)
                    throw updateRejectsWith;
            }
            finally {
                writesInFlight -= 1;
            }
        },
    },
});
// The real module constructs a TriMixBaseControl at import time, and that
// constructor starts an unawaited BLE initialize(). This file measures
// unhandled rejections, so an unrelated one from the base would be read as
// the bug under test.
mock.module(new URL('./trimixBaseControl.js', import.meta.url).href, {
    namedExports: {
        trimixBase: {
            goToFlat: async () => { },
            setPosition: async () => { },
        },
    },
});
let FrankenMonitor;
let settingsDB;
let serverStatus;
before(async () => {
    ({ FrankenMonitor } = await import('./frankenMonitor.js'));
    ({ default: settingsDB } = await import('../db/settings.js'));
    ({ default: serverStatus } = await import('../serverStatus.js'));
});
const side = (taps) => ({
    currentTemperatureLevel: 0,
    currentTemperatureF: 82,
    targetTemperatureF: 82,
    secondsRemaining: 0,
    isOn: true,
    isAlarmVibrating: false,
    taps,
});
const deviceStatus = (leftTaps) => ({
    left: side(leftTaps),
    right: side({ doubleTap: 0, tripleTap: 0, quadTap: 0 }),
    waterLevel: 'true',
    isPriming: false,
    settings: { v: 1, gainLeft: 0, gainRight: 0, ledBrightness: 100 },
    coverVersion: '1',
    hubVersion: '1',
    freeSleep: { version: '3.0.1', branch: 'main' },
    wifiStrength: 70,
    sensorTemps: null,
});
// A rejection is only reported as unhandled once the microtask queue has
// drained and the process has had a real turn, so yield past both.
async function settle() {
    for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await new Promise((resolve) => setImmediate(resolve));
    }
}
// Waits for the detached gesture chain to finish its writes.
async function writesFinished(count) {
    const deadline = Date.now() + 2000;
    while (updateCalls < count || writesInFlight > 0) {
        assert.ok(Date.now() < deadline, `only ${updateCalls} of ${count} writes happened`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
async function runGestureTick(previous, next) {
    const monitor = new FrankenMonitor();
    monitor.deviceStatus = previous;
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        monitor.processGestures(next);
        await settle();
    }
    finally {
        process.off('unhandledRejection', onUnhandled);
    }
    return seen;
}
// Feeds reads through one monitor the way the poll loop does.
async function runGestureTicks(reads) {
    const monitor = new FrankenMonitor();
    monitor.deviceStatus = reads[0];
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        for (const next of reads.slice(1)) {
            monitor.processGestures(next);
            monitor.deviceStatus = next;
            await settle();
        }
    }
    finally {
        process.off('unhandledRejection', onUnhandled);
    }
    return seen;
}
describe('FrankenMonitor gesture handling', () => {
    beforeEach(async () => {
        updateRejectsWith = null;
        updateCalls = 0;
        updatedStatus = undefined;
        writtenLeftTargets = [];
        updateDelayMs = 0;
        writesInFlight = 0;
        mostWritesInFlight = 0;
        serverStatus.status.frankenMonitor.status = 'healthy';
        serverStatus.status.frankenMonitor.message = '';
        await settingsDB.read();
        settingsDB.data.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 2 };
        await settingsDB.write();
    });
    it('applies a temperature tap when the tap counter increases', async () => {
        const seen = await runGestureTick(deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }), deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }));
        assert.equal(updateCalls, 1, 'expected the tap to reach updateDeviceStatus');
        assert.deepEqual(seen, []);
    });
    for (const [change, target, expected] of [
        ['increment', 55, 65], ['increment', 110, 110],
        ['decrement', 55, 55], ['decrement', 110, 100],
    ]) {
        it(`keeps a ${change} tap at ${target} F within the temperature range`, async () => {
            settingsDB.data.left.taps.doubleTap = { type: 'temperature', change, amount: 10 };
            await settingsDB.write();
            const previous = deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 });
            previous.left.targetTemperatureF = target;
            const next = deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 });
            next.left.targetTemperatureF = target;
            await runGestureTick(previous, next);
            assert.equal(updatedStatus?.left?.targetTemperatureF, expected);
        });
    }
    it('treats a decreasing counter as a reset and sees the next increase', async () => {
        await runGestureTicks([
            deviceStatus({ doubleTap: 5, tripleTap: 0, quadTap: 0 }),
            deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }),
        ]);
        assert.equal(updateCalls, 0);
        await runGestureTicks([
            deviceStatus({ doubleTap: 5, tripleTap: 0, quadTap: 0 }),
            deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }),
            deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }),
        ]);
        assert.equal(updateCalls, 1);
    });
    it('ignores a tick where no tap counter moved', async () => {
        const unchanged = deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 });
        const seen = await runGestureTick(unchanged, deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }));
        assert.equal(updateCalls, 0);
        assert.deepEqual(seen, []);
    });
    it('ignores a tap counter missing from the previous read', async () => {
        const seen = await runGestureTick(deviceStatus(undefined), deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }));
        assert.equal(updateCalls, 0);
        assert.deepEqual(seen, []);
    });
    it('ignores a tap counter missing from the new read', async () => {
        const seen = await runGestureTick(deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }), deviceStatus(undefined));
        assert.equal(updateCalls, 0);
        assert.deepEqual(seen, []);
    });
    it('sees a tap made across a read that is missing the counter', async () => {
        const seen = await runGestureTicks([
            deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }),
            deviceStatus(undefined),
            deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }),
        ]);
        assert.equal(updateCalls, 1);
        assert.deepEqual(seen, []);
    });
    it('does not count a counter that comes back unchanged as a tap', async () => {
        await runGestureTicks([
            deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }),
            deviceStatus(undefined),
            deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }),
        ]);
        assert.equal(updateCalls, 0);
    });
    it('sees the first tap after the counter starts being reported', async () => {
        await runGestureTicks([
            deviceStatus(undefined),
            deviceStatus({ doubleTap: 5, tripleTap: 0, quadTap: 0 }),
            deviceStatus({ doubleTap: 6, tripleTap: 0, quadTap: 0 }),
        ]);
        assert.equal(updateCalls, 1, 'the first report is a baseline, the change after it is a tap');
    });
    // The regression this file exists for. processGesture runs detached so a
    // slow base move cannot stall the poll loop, which means the surrounding
    // try cannot catch its rejection. server.ts handles unhandledRejection by
    // shutting the process down, and the unit restarts it, so before this was
    // caught a tap that failed to write bounced the whole server.
    it('does not leave an unhandled rejection when a tap fails to write', async () => {
        updateRejectsWith = new Error('franken write failed');
        const seen = await runGestureTick(deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }), deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }));
        assert.equal(updateCalls, 1, 'expected the tap to have been attempted');
        assert.deepEqual(seen, [], 'a failed tap escaped as an unhandled rejection');
    });
    it('reports a failed tap on the service status instead of staying healthy', async () => {
        updateRejectsWith = new Error('franken write failed');
        await runGestureTick(deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }), deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }));
        assert.equal(serverStatus.status.frankenMonitor.status, 'failed');
        assert.match(serverStatus.status.frankenMonitor.message, /franken write failed/);
    });
    it('still handles a rejection when both sides tap in the same tick', async () => {
        updateRejectsWith = new Error('franken write failed');
        await settingsDB.read();
        settingsDB.data.right.taps.doubleTap = { type: 'temperature', change: 'increment', amount: 2 };
        await settingsDB.write();
        const previous = deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 });
        const next = deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 });
        next.right = side({ doubleTap: 5, tripleTap: 0, quadTap: 0 });
        const seen = await runGestureTick(previous, next);
        assert.equal(updateCalls, 2, 'expected both sides to be attempted');
        assert.deepEqual(seen, []);
    });
    it('sets the temperature and turns the side on for a set temperature tap', async () => {
        settingsDB.data.left.taps.doubleTap = { type: 'set_temperature', temperatureF: 75 };
        await settingsDB.write();
        const previous = deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 });
        const next = deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 });
        previous.left.isOn = false;
        next.left.isOn = false;
        const seen = await runGestureTick(previous, next);
        assert.deepEqual(updatedStatus, { left: { isOn: true, targetTemperatureF: 75 } });
        assert.deepEqual(seen, []);
    });
    it('does nothing for a tap action this release does not know', async () => {
        settingsDB.data.left.taps.doubleTap = { type: 'future_action' };
        await settingsDB.write();
        const seen = await runGestureTick(deviceStatus({ doubleTap: 1, tripleTap: 0, quadTap: 0 }), deviceStatus({ doubleTap: 2, tripleTap: 0, quadTap: 0 }));
        assert.equal(updateCalls, 0);
        assert.deepEqual(seen, []);
        assert.equal(serverStatus.status.frankenMonitor.status, 'healthy');
    });
});
// Two gestures can land in one 2 s read: on a Pod 4 hub with a Pod 5 cover
// the firmware reports a held cover button as a tap while the counters of an
// earlier tap also moved. Both used to step from the read's target, so the
// second write undid the first instead of stacking on it.
describe('FrankenMonitor gestures in one read', () => {
    const taps = (doubleTap, tripleTap) => ({ doubleTap, tripleTap, quadTap: 0 });
    beforeEach(async () => {
        updateRejectsWith = null;
        updateCalls = 0;
        writtenLeftTargets = [];
        updateDelayMs = 0;
        writesInFlight = 0;
        mostWritesInFlight = 0;
        serverStatus.status.frankenMonitor.status = 'healthy';
        serverStatus.status.frankenMonitor.message = '';
        await settingsDB.read();
        settingsDB.data.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 2 };
        settingsDB.data.left.taps.tripleTap = { type: 'temperature', change: 'increment', amount: 10 };
        await settingsDB.write();
    });
    it('steps the second gesture from the target the first one wrote', async () => {
        await runGestureTick(deviceStatus(taps(1, 1)), deviceStatus(taps(2, 2)));
        assert.deepEqual(writtenLeftTargets, [80, 90]);
    });
    it('steps a later gesture from the temperature a set tap wrote', async () => {
        settingsDB.data.left.taps.doubleTap = { type: 'set_temperature', temperatureF: 75 };
        await settingsDB.write();
        await runGestureTick(deviceStatus(taps(1, 1)), deviceStatus(taps(2, 2)));
        assert.deepEqual(writtenLeftTargets, [75, 85]);
    });
    it('writes the gestures of one read one after another', async () => {
        updateDelayMs = 5;
        await runGestureTick(deviceStatus(taps(1, 1)), deviceStatus(taps(2, 2)));
        await writesFinished(2);
        assert.equal(mostWritesInFlight, 1, 'the second write started before the first finished');
    });
    it('still runs a later gesture after an earlier one in the read fails', async () => {
        updateRejectsWith = new Error('franken write failed');
        const seen = await runGestureTick(deviceStatus(taps(1, 1)), deviceStatus(taps(2, 2)));
        assert.equal(updateCalls, 2, 'expected both gestures to be attempted');
        assert.deepEqual(seen, []);
        assert.equal(serverStatus.status.frankenMonitor.status, 'failed');
    });
    it('steps from the written target while a read still carries the old one', async () => {
        // The read after a write can already have been in flight when the write
        // happened, so it reports the target from before it.
        await runGestureTicks([deviceStatus(taps(1, 0)), deviceStatus(taps(2, 0)), deviceStatus(taps(3, 0))]);
        assert.deepEqual(writtenLeftTargets, [80, 78]);
    });
    it('steps from the read once the Pod reports the written target', async () => {
        const reported = deviceStatus(taps(2, 0));
        reported.left.targetTemperatureF = 80;
        const changedInApp = deviceStatus(taps(3, 0));
        changedInApp.left.targetTemperatureF = 90;
        await runGestureTicks([deviceStatus(taps(1, 0)), deviceStatus(taps(2, 0)), reported, changedInApp]);
        assert.deepEqual(writtenLeftTargets, [80, 88]);
    });
    it('steps from the read when something else changed the target first', async () => {
        const changedInApp = deviceStatus(taps(3, 0));
        changedInApp.left.targetTemperatureF = 90;
        await runGestureTicks([deviceStatus(taps(1, 0)), deviceStatus(taps(2, 0)), changedInApp]);
        assert.deepEqual(writtenLeftTargets, [80, 88]);
    });
    it('keeps stepping from the last write while only an earlier one is reported', async () => {
        // Two writes from one read; the next reads show only the first landed.
        const firstLanded = deviceStatus(taps(2, 2));
        firstLanded.left.targetTemperatureF = 80;
        const thirdTap = deviceStatus(taps(3, 2));
        thirdTap.left.targetTemperatureF = 80;
        await runGestureTicks([deviceStatus(taps(1, 1)), deviceStatus(taps(2, 2)), firstLanded, thirdTap]);
        assert.deepEqual(writtenLeftTargets, [80, 90, 88]);
    });
});
//# sourceMappingURL=frankenMonitor.test.js.map