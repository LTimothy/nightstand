import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-franken-boost-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let writes = [];
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async (status) => { writes.push(status); } },
});
mock.module(new URL('./trimixBaseControl.js', import.meta.url).href, {
    namedExports: { trimixBase: { goToFlat: async () => { }, setPosition: async () => { } } },
});
let marks = 0;
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
    namedExports: {
        markManualTempChange: async () => { marks += 1; },
        isTempScheduleOverridden: () => false,
        OVERRIDE_WINDOW_HOURS: 3,
        OVERRIDE_DURATION_HOURS: 12,
    },
});
let FrankenMonitor;
let settingsDB;
before(async () => {
    ({ FrankenMonitor } = await import('./frankenMonitor.js'));
    ({ default: settingsDB } = await import('../db/settings.js'));
});
const sideStatus = (isOn, taps) => ({
    currentTemperatureLevel: 0, currentTemperatureF: 80, targetTemperatureF: 78, secondsRemaining: 0, isOn,
    isAlarmVibrating: false, taps,
});
const status = (hubVersion, isOn, quadTap, doubleTap = 0) => ({
    left: sideStatus(isOn, { doubleTap, tripleTap: 0, quadTap }), right: sideStatus(true, { doubleTap: 0, tripleTap: 0, quadTap: 0 }),
    waterLevel: 'true', isPriming: false, settings: { v: 1, gainLeft: 0, gainRight: 0, ledBrightness: 100 },
    coverVersion: 'Pod 5', hubVersion, freeSleep: { version: '3.8.0', branch: 'dev' }, wifiStrength: 70, sensorTemps: null,
});
// One left tap tick between two reads, then time for the detached gesture chain.
async function tick(hubVersion, isOn = true, gesture = 'quadTap') {
    const monitor = new FrankenMonitor();
    monitor.deviceStatus = status(hubVersion, isOn, 0);
    monitor.processGestures(gesture === 'quadTap' ? status(hubVersion, isOn, 1) : status(hubVersion, isOn, 0, 1));
    for (let i = 0; i < 20; i++)
        await new Promise(resolve => setTimeout(resolve, 2));
}
describe('a Pod 5 center double press with the boost on', () => {
    beforeEach(async () => {
        await settingsDB.read();
        settingsDB.data.left.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
        settingsDB.data.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 1 };
        settingsDB.data.left.taps.logoDouble = { ...settingsDB.data.left.taps.logoDouble, temperatureF: 55, minutes: 5 };
        await settingsDB.write();
        writes = [];
        marks = 0;
    });
    for (const isOn of [true, false]) {
        it(`leaves the quadTap tick to the boost on a side that is ${isOn ? 'on' : 'off'}`, async () => {
            await tick('Pod 5', isOn);
            assert.deepEqual(writes, []);
            assert.equal(marks, 0);
        });
    }
    it('applies the tick with the boost off', async () => {
        settingsDB.data.left.taps.logoDouble.minutes = 0;
        await settingsDB.write();
        await tick('Pod 5');
        assert.deepEqual(writes, [{ left: { isOn: true, targetTemperatureF: 77 } }]);
        assert.equal(marks, 1);
    });
    it('applies the tick on a Pod 4 hub', async () => {
        await tick('Pod 4');
        assert.deepEqual(writes, [{ left: { isOn: true, targetTemperatureF: 77 } }]);
        assert.equal(marks, 1);
    });
    it('applies a minus tick', async () => {
        await tick('Pod 5', true, 'doubleTap');
        assert.deepEqual(writes, [{ left: { targetTemperatureF: 77 } }]);
        assert.equal(marks, 1);
    });
});
//# sourceMappingURL=frankenMonitor.boost.test.js.map