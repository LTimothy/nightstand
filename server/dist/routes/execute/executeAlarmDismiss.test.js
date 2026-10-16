import assert from 'node:assert/strict';
import { after, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-raw-alarm-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const sent = [];
let failCommand = false;
mock.module('../../8sleep/frankenServer.js', { namedExports: {
        connectFrankenWithin: async () => ({ callFunction: async (command, arg) => {
                if (failCommand)
                    throw new Error('command failed');
                sent.push([command, arg]);
            } }),
        FrankenCommandTimeoutError: class extends Error {
        },
        getDeviceStatusCoalesced: async () => ({}),
        isFrankenConnected: () => true,
    } });
const { default: executeRouter } = await import('./execute.js');
const { default: deviceRouter } = await import('../deviceStatus/deviceStatus.js');
const { activeAlarms, forgetActiveAlarm } = await import('../../jobs/activeAlarms.js');
const { default: memoryDB } = await import('../../db/memoryDB.js');
function postHandler(router, routePath) {
    const route = router.stack.find(layer => layer.route?.path === routePath
        && layer.route.stack.some(handler => handler.method === 'post'))?.route;
    const handler = route?.stack.find(layer => layer.method === 'post')?.handle;
    assert.ok(handler, `missing POST ${routePath}`);
    return handler;
}
const execute = postHandler(executeRouter, '/execute');
const dismiss = postHandler(deviceRouter, '/deviceStatus');
async function request(handler, body) {
    let status = 200;
    const response = {
        status: (value) => { status = value; return response; },
        json: () => { }, send: () => { }, sendStatus: (value) => { status = value; }, end: () => { },
    };
    await handler({ body }, response, () => { });
    return status;
}
const payload = (duration, targetTime = 1_800_000_000) => cbor.encode({ pl: 50, du: duration, pi: 'double', tt: targetTime }).toString('hex');
beforeEach(() => {
    sent.length = 0;
    failCommand = false;
    for (const side of ['left', 'right']) {
        forgetActiveAlarm(side);
        memoryDB.data[side].isAlarmVibrating = false;
    }
});
after(() => rmSync(folder, { recursive: true, force: true }));
for (const side of ['left', 'right']) {
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    const other = side === 'left' ? 'right' : 'left';
    it(`dismisses a raw ${side} alarm through the device status route without touching its partner`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
        assert.equal(await request(execute, { command, arg: payload(180) }), 200);
        assert.equal(await request(execute, { command: other === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT', arg: payload(240) }), 200);
        assert.deepEqual(activeAlarms.get(side), { vibrationIntensity: 50, duration: 180, vibrationPattern: 'double' });
        assert.equal(memoryDB.data[side].isAlarmVibrating, true);
        sent.length = 0;
        assert.equal(await request(dismiss, { [side]: { isAlarmVibrating: false } }), 204);
        assert.deepEqual(sent.map(([name]) => name), [command]);
        assert.deepEqual(cbor.decodeFirstSync(Buffer.from(sent[0][1], 'hex')), { pl: 1, du: 1, pi: 'double', tt: 1_800_000_000 });
        assert.equal(activeAlarms.has(side), false);
        assert.equal(memoryDB.data[side].isAlarmVibrating, false);
        assert.equal(activeAlarms.has(other), true);
        assert.equal(memoryDB.data[other].isAlarmVibrating, true);
    });
    it(`expires raw ${side} tracking at the supplied duration and leaves an idle dismiss silent`, async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
        const timers = [];
        t.mock.method(globalThis, 'setTimeout', ((callback, delay) => {
            timers.push({ callback, delay });
            return {};
        }));
        await request(execute, { command, arg: payload(180) });
        assert.equal(timers[0]?.delay, 180_000);
        await timers[0].callback();
        assert.equal(activeAlarms.has(side), false);
        assert.equal(memoryDB.data[side].isAlarmVibrating, false);
        sent.length = 0;
        await request(dismiss, { [side]: { isAlarmVibrating: false } });
        assert.deepEqual(sent, []);
    });
    it(`rejects future raw ${side} alarms before sending a hardware command`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
        for (const offset of [1, 600, 3_000_000]) {
            assert.equal(await request(execute, { command, arg: payload(180, 1_800_000_000 + offset) }), 400);
            assert.deepEqual(sent, []);
            assert.equal(activeAlarms.has(side), false);
            assert.equal(memoryDB.data[side].isAlarmVibrating, false);
        }
    });
    it(`preserves both tracked alarms when a future raw ${side} start is rejected`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
        assert.equal(await request(execute, { command, arg: payload(180) }), 200);
        assert.equal(await request(execute, { command: other === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT', arg: payload(240) }), 200);
        const ringingAlarm = activeAlarms.get(side);
        const partnerAlarm = activeAlarms.get(other);
        sent.length = 0;
        assert.equal(await request(execute, { command, arg: payload(180, 1_800_000_600) }), 400);
        assert.equal(sent.length, 0);
        assert.equal(activeAlarms.get(side), ringingAlarm);
        assert.equal(activeAlarms.get(other), partnerAlarm);
        assert.equal(memoryDB.data[side].isAlarmVibrating, true);
        assert.equal(memoryDB.data[other].isAlarmVibrating, true);
        assert.equal(await request(dismiss, { [side]: { isAlarmVibrating: false } }), 204);
        assert.deepEqual(sent.map(([name]) => name), [command]);
        assert.equal(activeAlarms.has(other), true);
    });
    it(`rejects raw ${side} alarms with an unusable target time before hardware execution`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
        for (const targetTime of [undefined, -1, 1_800_000_000.5, '1800000000', Number.MAX_SAFE_INTEGER + 1]) {
            const arg = cbor.encode({ pl: 50, du: 180, pi: 'double', tt: targetTime }).toString('hex');
            assert.equal(await request(execute, { command, arg }), 400);
            assert.deepEqual(sent, []);
            assert.equal(activeAlarms.has(side), false);
        }
    });
}
it('does not track a raw alarm rejected by the hardware', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    failCommand = true;
    await assert.rejects(request(execute, { command: 'ALARM_LEFT', arg: payload(180) }), /command failed/);
    assert.equal(activeAlarms.has('left'), false);
    assert.equal(memoryDB.data.left.isAlarmVibrating, false);
});
//# sourceMappingURL=executeAlarmDismiss.test.js.map