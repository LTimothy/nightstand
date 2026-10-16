import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-device-status-route-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const sent = [];
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async (command, arg) => { sent.push([command, arg]); } },
});
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        FrankenCommandTimeoutError: class extends Error {
        },
        getDeviceStatusCoalesced: async () => ({}),
        isFrankenConnected: () => true,
        connectFrankenWithin: async () => ({ callFunction: async (command, arg) => { sent.push([command, arg]); } }),
    },
});
const manualChanges = [];
mock.module(new URL('../../jobs/scheduleOverride.js', import.meta.url).href, {
    namedExports: { markManualTempChange: async (side) => { manualChanges.push(side); } },
});
const { default: router } = await import('./deviceStatus.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/deviceStatus`;
after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
});
const post = async (body) => {
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await response.text();
    return response.status;
};
beforeEach(() => {
    sent.length = 0;
    manualChanges.length = 0;
});
describe('POST /deviceStatus', () => {
    const rejected = [
        ['a huge duration', { left: { secondsRemaining: 1e21 } }],
        ['a negative duration', { right: { secondsRemaining: -5 } }],
        ['a duration past twelve hours', { left: { secondsRemaining: 43201 } }],
        ['a fractional duration', { left: { secondsRemaining: 10.5 } }],
        ['an unknown settings key', { settings: { foo: 'bar' } }],
        ['a prototype settings key', JSON.parse('{"settings":{"__proto__":{"x":1}}}')],
        ['an out of range LED brightness', { settings: { ledBrightness: 1e9 } }],
        ['a fractional LED brightness', { settings: { ledBrightness: 50.5 } }],
        ['a negative gain', { settings: { gainLeft: -1 } }],
        ['a gain past the 32-bit range', { settings: { gainRight: 2_147_483_648 } }],
        ['a fractional gain', { settings: { gainLeft: 400.5 } }],
        ['a negative settings version', { settings: { v: -1 } }],
        ['a target below the range', { left: { targetTemperatureF: 54 } }],
        ['a target above the range', { right: { targetTemperatureF: 111 } }],
        ['an unknown side key', { left: { evil: 1 } }],
        ['an unknown top-level key', { middle: { isOn: true } }],
        ['a non-boolean power state', { left: { isOn: 'yes' } }],
        ['a non-boolean priming flag', { isPriming: 1 }],
    ];
    for (const [name, body] of rejected) {
        it(`rejects ${name} without reaching the firmware`, async () => {
            assert.equal(await post(body), 400);
            assert.deepEqual(sent, []);
        });
    }
    it('accepts every payload the app sends', async () => {
        assert.equal(await post({ left: { isOn: true, targetTemperatureF: 80 } }), 204);
        assert.equal(await post({ right: { isOn: false } }), 204);
        assert.equal(await post({ left: { isAlarmVibrating: false } }), 204);
        assert.equal(await post({ isPriming: true }), 204);
        assert.equal(await post({ settings: { v: 1, gainLeft: 400, gainRight: 400, ledBrightness: 60 } }), 204);
        assert.equal(await post({ settings: { v: 70_000, gainLeft: 2_147_483_647, gainRight: 0, ledBrightness: 0 } }), 204);
        assert.equal(await post({ right: { targetTemperatureF: 55 } }), 204);
        assert.deepEqual(manualChanges, ['left', 'right']);
    });
    it('ignores isPriming false without sending an unverified cancellation command', async () => {
        assert.equal(await post({ isPriming: false }), 204);
        assert.deepEqual(sent, []);
    });
    it('forwards a bounded duration unchanged', async () => {
        assert.equal(await post({ left: { secondsRemaining: 43200 } }), 204);
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', '43200']]);
    });
    it('accepts read-only status fields echoed back without sending them', async () => {
        assert.equal(await post({
            left: { currentTemperatureF: 71, currentTemperatureLevel: -43, taps: { doubleTap: 0, tripleTap: 0, quadTap: 0 } },
            waterLevel: 'true', coverVersion: 'Pod 5', hubVersion: 'Pod 5', wifiStrength: 50,
        }), 204);
        assert.deepEqual(sent, []);
    });
});
//# sourceMappingURL=deviceStatusRoute.test.js.map