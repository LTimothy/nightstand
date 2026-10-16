import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-alarm-dismiss-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const calls = [];
let onConnect = () => { };
const franken = {
    callFunction: async (command, arg) => { calls.push([command, arg]); },
    getDeviceStatus: async () => ({ left: { isOn: true }, right: { isOn: true }, hubVersion: 'Pod 5', coverVersion: 'Pod 5' }),
};
mock.module('./frankenServer.js', { namedExports: { connectFrankenWithin: async () => { onConnect(); return franken; } } });
const { executeAlarm } = await import('../jobs/alarmScheduler.js');
const { updateDeviceStatus } = await import('../routes/deviceStatus/updateDeviceStatus.js');
const { default: memoryDB } = await import('../db/memoryDB.js');
const alarm = { side: 'left', vibrationIntensity: 50, duration: 1, vibrationPattern: 'double', force: true };
beforeEach(async () => {
    calls.length = 0;
    onConnect = () => { };
    const { forgetActiveAlarm } = await import('../jobs/activeAlarms.js');
    for (const side of ['left', 'right']) {
        forgetActiveAlarm(side);
        memoryDB.data[side].isAlarmVibrating = false;
    }
});
after(() => rmSync(folder, { recursive: true, force: true }));
for (const side of ['left', 'right']) {
    test(`dismiss replaces the ${side} alarm without an unscoped clear`, async (t) => {
        const now = 1_800_000_000_000;
        t.mock.timers.enable({ apis: ['Date'], now });
        memoryDB.data[side].isAlarmVibrating = true;
        await memoryDB.write();
        await updateDeviceStatus({ [side]: { isAlarmVibrating: false } });
        assert.deepEqual(calls.map(([command]) => command), [side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT']);
        assert.deepEqual(cbor.decodeFirstSync(Buffer.from(calls[0][1], 'hex')), {
            pl: 1, du: 1, pi: 'double', tt: 1_800_000_000,
        });
        assert.equal(memoryDB.data[side].isAlarmVibrating, false);
    });
}
test('dismiss uses the time the replacement is sent after waiting for a connection', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    memoryDB.data.left.isAlarmVibrating = true;
    onConnect = () => t.mock.timers.tick(5_000);
    await updateDeviceStatus({ left: { isAlarmVibrating: false } });
    assert.equal(cbor.decodeFirstSync(Buffer.from(calls[0][1], 'hex')).tt, 1_800_000_005);
});
for (const side of ['left', 'right']) {
    test(`dismiss sends nothing if ${side} stops ringing while waiting for a connection`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { forgetActiveAlarm } = await import('../jobs/activeAlarms.js');
        await executeAlarm({ ...alarm, side });
        calls.length = 0;
        onConnect = () => {
            forgetActiveAlarm(side);
            memoryDB.data[side].isAlarmVibrating = false;
        };
        await updateDeviceStatus({ [side]: { isAlarmVibrating: false } });
        assert.deepEqual(calls, []);
    });
}
test('normal alarms retain their ten second minimum', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(await executeAlarm(alarm), 10_000);
    assert.equal(cbor.decodeFirstSync(Buffer.from(calls[0][1], 'hex')).du, 10);
    t.mock.timers.tick(9_999);
    assert.equal(memoryDB.data.left.isAlarmVibrating, true);
});
test('dismiss invalidates the old timer before a later alarm rings', async (t) => {
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', ((callback) => {
        timers.push(callback);
        return {};
    }));
    await executeAlarm(alarm);
    await updateDeviceStatus({ left: { isAlarmVibrating: false } });
    const read = t.mock.method(memoryDB, 'read');
    await timers[0]();
    assert.equal(read.mock.callCount(), 0, 'the dismissed timer must not enter memory updates');
    await executeAlarm(alarm);
    await timers[0]();
    assert.equal(memoryDB.data.left.isAlarmVibrating, true);
    await timers[1]();
    assert.equal(memoryDB.data.left.isAlarmVibrating, false);
});
test('dismissing one side leaves the other ringing side to its own timer', async (t) => {
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', ((callback) => {
        timers.push(callback);
        return {};
    }));
    await executeAlarm(alarm);
    await executeAlarm({ ...alarm, side: 'right' });
    assert.equal(memoryDB.data.left.isAlarmVibrating, true);
    assert.equal(memoryDB.data.right.isAlarmVibrating, true);
    await updateDeviceStatus({ left: { isAlarmVibrating: false } });
    assert.equal(memoryDB.data.left.isAlarmVibrating, false);
    assert.equal(memoryDB.data.right.isAlarmVibrating, true);
    assert.deepEqual(calls.map(([command]) => command), ['ALARM_LEFT', 'ALARM_RIGHT', 'ALARM_LEFT']);
    await timers[0]();
    assert.equal(memoryDB.data.right.isAlarmVibrating, true, 'the dismissed side timer must not touch the other side');
    await timers[1]();
    assert.equal(memoryDB.data.right.isAlarmVibrating, false);
});
test('a ringing alarm keeps the settings it started with', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { activeAlarms } = await import('../jobs/activeAlarms.js');
    await executeAlarm({ ...alarm, vibrationIntensity: 30, vibrationPattern: 'rise', duration: 45 });
    assert.deepEqual(activeAlarms.get('left'), { vibrationIntensity: 30, vibrationPattern: 'rise', duration: 45 });
});
test('an alarm that starts replaces a snooze waiting on its side only', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { cancelSnooze, hasSnooze, setSnooze } = await import('../jobs/activeAlarms.js');
    t.after(() => { cancelSnooze('left'); cancelSnooze('right'); });
    setSnooze('left', 300_000, () => { });
    setSnooze('right', 300_000, () => { });
    await executeAlarm(alarm);
    assert.equal(hasSnooze('left'), false);
    assert.equal(hasSnooze('right'), true);
});
test('an alarm that does not start leaves the snooze in place', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { cancelSnooze, hasSnooze, setSnooze } = await import('../jobs/activeAlarms.js');
    t.after(() => cancelSnooze('left'));
    t.mock.method(franken, 'getDeviceStatus', async () => ({
        left: { isOn: false }, right: { isOn: false }, hubVersion: 'Pod 5', coverVersion: 'Pod 5',
    }));
    setSnooze('left', 300_000, () => { });
    assert.equal(await executeAlarm({ ...alarm, force: false }), 0);
    assert.equal(hasSnooze('left'), true);
});
test('firmware dismissal sends no command and invalidates the ringing timer', async (t) => {
    const timers = [];
    t.mock.method(globalThis, 'setTimeout', ((callback) => {
        timers.push(callback);
        return {};
    }));
    const { loadDeviceStatus } = await import('./loadDeviceStatus.js');
    const { activeAlarms } = await import('../jobs/activeAlarms.js');
    const reply = (dismissAlarm) => Object.entries({
        tgHeatLevelL: '0', tgHeatLevelR: '0', heatTimeL: '3600', heatTimeR: '3600',
        heatLevelL: '0', heatLevelR: '0', sensorLabel: '20500-0001-J01-0000',
        waterLevel: 'true', priming: 'false', settings: cbor.encode({ gl: 20, gr: 20, lb: 50 }).toString('hex'),
        dismissAlarm,
    }).map(([key, value]) => `${key} = ${value}`).join('\n');
    await loadDeviceStatus(reply('{"l":100,"r":100}'), true);
    await executeAlarm(alarm);
    await executeAlarm({ ...alarm, side: 'right' });
    await loadDeviceStatus(reply('{"l":100,"r":100}'), true);
    calls.length = 0;
    const dismissed = await loadDeviceStatus(reply('{"l":101,"r":100}'), true);
    assert.deepEqual(calls, [], 'a firmware dismissal must not send a hardware command');
    assert.equal(activeAlarms.has('left'), false);
    assert.equal(dismissed.left.isAlarmVibrating, false);
    assert.equal(dismissed.right.isAlarmVibrating, true);
    await executeAlarm(alarm);
    await timers[0]();
    assert.equal(memoryDB.data.left.isAlarmVibrating, true);
    await timers[1]();
    await timers[2]();
    assert.equal(memoryDB.data.left.isAlarmVibrating, false);
});
for (const timing of ['before acceptance', 'after acceptance']) {
    test(`an old dismissal observed ${timing} does not clear a replacement alarm`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { loadDeviceStatus } = await import('./loadDeviceStatus.js');
        const { FirmwareAlarmDismiss } = await import('./firmwareAlarmDismiss.js');
        const observer = new FirmwareAlarmDismiss();
        const { activeAlarms, forgetActiveAlarm } = await import('../jobs/activeAlarms.js');
        t.after(() => forgetActiveAlarm('left'));
        const reply = (value) => Object.entries({
            tgHeatLevelL: '0', tgHeatLevelR: '0', heatTimeL: '3600', heatTimeR: '3600',
            heatLevelL: '0', heatLevelR: '0', sensorLabel: '20500-0001-J01-0000',
            waterLevel: 'true', priming: 'false', settings: cbor.encode({ gl: 20, gr: 20, lb: 50 }).toString('hex'),
            dismissAlarm: `{"l":${value},"r":100}`,
        }).map(([key, value]) => `${key} = ${value}`).join('\n');
        const readStatus = (value) => loadDeviceStatus(reply(value), false, observer);
        await executeAlarm(alarm);
        await readStatus(100);
        t.mock.method(franken, 'getDeviceStatus', async () => readStatus(100));
        let accept;
        let sent;
        const sending = new Promise(resolve => { sent = resolve; });
        t.mock.method(franken, 'callFunction', async () => {
            sent();
            await new Promise(resolve => { accept = resolve; });
        });
        const replacing = executeAlarm({ ...alarm, vibrationIntensity: 30 });
        await sending;
        if (timing === 'before acceptance')
            await readStatus(101);
        accept();
        await replacing;
        const replacement = activeAlarms.get('left');
        assert.equal(replacement?.vibrationIntensity, 30);
        const baseline = await readStatus(101);
        assert.equal(activeAlarms.get('left'), replacement);
        assert.equal(baseline.left.isAlarmVibrating, true);
        await readStatus(102);
        assert.equal(activeAlarms.has('left'), false);
    });
}
for (const side of ['left', 'right']) {
    test(`dismiss on an idle ${side} side sends no alarm command`, async () => {
        const other = side === 'left' ? 'right' : 'left';
        memoryDB.data[other].isAlarmVibrating = true;
        await updateDeviceStatus({ [side]: { isAlarmVibrating: false } });
        assert.deepEqual(calls, []);
        assert.equal(memoryDB.data[other].isAlarmVibrating, true);
    });
}
test('dismiss recognizes an active alarm even if its memory flag is false', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await executeAlarm(alarm);
    memoryDB.data.left.isAlarmVibrating = false;
    calls.length = 0;
    await updateDeviceStatus({ left: { isAlarmVibrating: false } });
    assert.deepEqual(calls.map(([command]) => command), ['ALARM_LEFT']);
});
test('dismiss cancels an idle snooze without vibrating either side', async () => {
    const { hasSnooze, setSnooze } = await import('../jobs/activeAlarms.js');
    setSnooze('left', 300_000, () => { });
    await updateDeviceStatus({ left: { isAlarmVibrating: false } });
    assert.equal(hasSnooze('left'), false);
    assert.deepEqual(calls, []);
});
//# sourceMappingURL=alarmDismiss.test.js.map