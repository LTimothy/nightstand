import { test, mock, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
import net from 'node:net';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-franken-unavailable-'));
mkdirSync(path.join(folder, 'lowdb'));
const previousEnv = {
    DATA_FOLDER: process.env.DATA_FOLDER,
    ENV: process.env.ENV,
    FRANKEN_CONNECT_WAIT_MS: process.env.FRANKEN_CONNECT_WAIT_MS,
    FRANKEN_CONNECTION_TIMEOUT_MS: process.env.FRANKEN_CONNECTION_TIMEOUT_MS,
    FRANKEN_BACKGROUND_CONNECT_WAIT_MS: process.env.FRANKEN_BACKGROUND_CONNECT_WAIT_MS,
    FRANKEN_COMMAND_TIMEOUT_MS: process.env.FRANKEN_COMMAND_TIMEOUT_MS,
};
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.FRANKEN_CONNECT_WAIT_MS = '100';
process.env.FRANKEN_CONNECTION_TIMEOUT_MS = '200';
process.env.FRANKEN_BACKGROUND_CONNECT_WAIT_MS = '800';
process.env.FRANKEN_COMMAND_TIMEOUT_MS = '300';
// The firmware connects when the test says so, like a Pod whose firmware
// is restarting.
let deliver;
mock.module(new URL('./unixSocketServer.js', import.meta.url).href, {
    namedExports: { UnixSocketServer: class {
            static async start() {
                return {
                    waitForConnection: () => new Promise(resolve => { deliver = resolve; }),
                    close: async () => { },
                };
            }
        } },
});
const { disconnectFranken, isFrankenConnected, connectFrankenWithin, FrankenUnavailableError } = await import('./frankenServer.js');
const { FrankenSupersededError } = await import('./frankenErrors.js');
const { executeFunction } = await import('./deviceApi.js');
const { executeAlarm } = await import('../jobs/alarmScheduler.js');
const ledger = await import('../jobs/alarmLedger.js');
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const sockets = [];
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// The firmware's answer to a status request, with the left side heating.
const leftOnStatus = [
    'tgHeatLevelR = 0', 'tgHeatLevelL = 0', 'heatTimeL = 3600', 'heatLevelL = 0', 'heatTimeR = 0',
    'heatLevelR = 0', 'sensorLabel = test', 'waterLevel = true', 'priming = false', `settings = ${cbor.encode({}).toString('hex')}`,
].join('\n') + '\n\n';
async function connectFirmware(fault = {}) {
    const accepted = new Promise(resolve => listener.once('connection', resolve));
    const client = net.createConnection(listener.address().port, '127.0.0.1');
    const peer = await accepted;
    sockets.push(client, peer);
    const received = [];
    peer.on('data', data => {
        const message = data.toString();
        received.push(message);
        const injected = message === '14\n\n' ? fault.status : message.startsWith('5\n') ? fault.alarm : undefined;
        if (injected === 'close')
            peer.destroy();
        else if (injected === 'slow')
            setTimeout(() => peer.write(leftOnStatus), 150);
        else if (injected === undefined)
            peer.write(message === '14\n\n' ? leftOnStatus : data);
    });
    while (!deliver)
        await new Promise(resolve => setTimeout(resolve, 5));
    deliver(client);
    deliver = undefined;
    while (!isFrankenConnected() && received.length === 0)
        await new Promise(resolve => setTimeout(resolve, 5));
    return received;
}
afterEach(async () => {
    ledger.resetAlarmLedgerForTests();
    rmSync(path.join(folder, 'alarm-ledger.json'), { force: true });
    await disconnectFranken();
    deliver = undefined;
    sockets.splice(0).forEach(socket => socket.destroy());
});
after(async () => {
    await new Promise(resolve => listener.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
});
test('a command fails promptly while the firmware is disconnected', async () => {
    const startedAt = Date.now();
    await assert.rejects(executeFunction('TEMP_LEVEL_LEFT', '-45'), FrankenUnavailableError);
    assert.ok(Date.now() - startedAt < 2_000);
});
test('a command that gave up is never sent after the firmware reconnects', async () => {
    await assert.rejects(executeFunction('TEMP_LEVEL_LEFT', '-45'), FrankenUnavailableError);
    const received = await connectFirmware();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, []);
    await executeFunction('TEMP_LEVEL_RIGHT', '10');
    assert.deepEqual(received, ['12\n10\n\n']);
});
test('a manual alarm made during an outage does not vibrate on reconnect', async () => {
    await executeAlarm({ side: 'left', vibrationIntensity: 50, duration: 10, vibrationPattern: 'rise', force: true });
    const received = await connectFirmware();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, []);
});
test('a scheduled command waits through a reconnect and is sent once', async () => {
    const pending = executeFunction('TEMP_LEVEL_LEFT', '-45', { background: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    const received = await connectFirmware();
    await pending;
    assert.deepEqual(received, ['11\n-45\n\n']);
});
// The dismissal timer of a sent alarm would otherwise keep the process alive.
const unrefLongTimers = (t) => {
    const original = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', ((callback, ms, ...args) => {
        const timer = original(callback, ms, ...args);
        if (ms === 10_000)
            timer.unref();
        return timer;
    }));
};
const alarm = { side: 'left', vibrationIntensity: 50, duration: 10, vibrationPattern: 'rise' };
test('a scheduled alarm that would start minutes late is skipped', async (t) => {
    unrefLongTimers(t);
    ledger.startAlarmLedger(new Date());
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const ringing = executeAlarm(alarm, undefined, { background: true });
    await pause(50);
    clock += 4 * 60_000;
    const received = await connectFirmware();
    await ringing;
    await pause(50);
    assert.deepEqual(received, ['14\n\n'], 'the alarm should have checked the side and then stopped');
    assert.deepEqual(ledger.listMissedAlarms().map(item => item.reason), ['late']);
});
test('a scheduled alarm the Pod could not be reached for is reported as late', async () => {
    ledger.startAlarmLedger(new Date());
    assert.equal(await executeAlarm(alarm, undefined, { background: true }), 0);
    assert.deepEqual(ledger.listMissedAlarms().map(item => item.reason), ['late']);
    assert.equal(await executeAlarm({ ...alarm, force: true }), 0);
    assert.equal(ledger.listMissedAlarms().length, 1, 'a manual alarm is never reported');
});
const missedAfter = async (fault) => {
    ledger.startAlarmLedger(new Date());
    const ringing = executeAlarm(alarm, undefined, { background: true });
    await pause(50);
    await connectFirmware(fault);
    assert.equal(await ringing, 0);
    return ledger.listMissedAlarms().map(item => item.reason);
};
test('an alarm written to a Pod that then drops the connection is unconfirmed', async () => {
    assert.deepEqual(await missedAfter({ alarm: 'close' }), ['unconfirmed']);
});
test('an alarm written to a Pod that never answers is unconfirmed', async () => {
    assert.deepEqual(await missedAfter({ alarm: 'silent' }), ['unconfirmed']);
});
test('a Pod that does not answer the side check in time counts as late', async () => {
    assert.deepEqual(await missedAfter({ status: 'silent' }), ['late']);
});
test('a connection that drops during the side check counts as late', async () => {
    assert.deepEqual(await missedAfter({ status: 'close' }), ['late']);
});
test('a scheduled alarm that is on time is sent', async (t) => {
    unrefLongTimers(t);
    const ringing = executeAlarm(alarm, undefined, { background: true });
    await pause(50);
    const received = await connectFirmware();
    assert.ok(await ringing > 0);
    assert.equal(received.length, 2);
    assert.ok(received[1].startsWith('5\n'), JSON.stringify(received));
});
test('an alarm is not sent when the connection comes only after its deadline', async (t) => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const sending = executeFunction('ALARM_LEFT', 'a0', { background: true, notAfter: clock + 700 });
    const outcome = sending.then(() => undefined, (error) => error);
    await pause(50);
    clock += 2_000;
    const received = await connectFirmware();
    assert.ok(await outcome instanceof FrankenUnavailableError);
    await pause(50);
    assert.deepEqual(received, []);
});
test('a command whose deadline passes while it waits in the queue is never sent', async () => {
    const connecting = connectFrankenWithin({ background: true });
    const received = await connectFirmware({ status: 'slow' });
    const franken = await connecting;
    const status = franken.getDeviceStatus();
    await assert.rejects(executeFunction('ALARM_LEFT', 'aa', { background: true, notAfter: Date.now() + 50 }), FrankenUnavailableError);
    await status;
    assert.equal(received.some(message => message.startsWith('5\n')), false);
    await executeFunction('TEMP_LEVEL_RIGHT', '10');
    assert.ok(received.includes('12\n10\n\n'), 'the next command still runs');
});
test('a queued command still inside its deadline is sent after the slow one', async () => {
    const connecting = connectFrankenWithin({ background: true });
    const received = await connectFirmware({ status: 'slow' });
    const franken = await connecting;
    const status = franken.getDeviceStatus();
    await executeFunction('ALARM_LEFT', 'aa', { background: true, notAfter: Date.now() + 1_000 });
    await status;
    assert.ok(received.some(message => message.startsWith('5\n')));
});
test('a scheduled state command waits out an outage longer than the limit for other commands', async () => {
    const pending = executeFunction('LEFT_TEMP_DURATION', '0', { background: true, latest: true });
    await pause(1_200);
    const received = await connectFirmware();
    await pending;
    assert.deepEqual(received, ['9\n0\n\n']);
});
test('a state command without the background flag still gives up and is never replayed', async () => {
    await assert.rejects(executeFunction('LEFT_TEMP_DURATION', '0', { latest: true }), FrankenUnavailableError);
    const received = await connectFirmware();
    await pause(50);
    assert.deepEqual(received, []);
});
test('only the newest waiting state command for a setting is applied on reconnect', async () => {
    const on = executeFunction('LEFT_TEMP_DURATION', '43200', { background: true, latest: true });
    const onOutcome = on.then(() => undefined, (error) => error);
    await pause(20);
    const level = executeFunction('TEMP_LEVEL_LEFT', '10', { background: true, latest: true });
    const off = executeFunction('LEFT_TEMP_DURATION', '0', { background: true, latest: true });
    await pause(1_000);
    const received = await connectFirmware();
    await Promise.all([off, level]);
    assert.ok(await onOutcome instanceof FrankenSupersededError);
    assert.deepEqual([...received].sort(), ['11\n10\n\n', '9\n0\n\n']);
});
test('a deferred state command is worked out when it is finally sent', async (t) => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const until = clock + 3_600_000;
    const pending = executeFunction('LEFT_TEMP_DURATION', () => String(Math.ceil((until - Date.now()) / 1000)), {
        background: true, latest: true, notAfter: until,
    });
    await pause(50);
    clock += 600_000;
    const received = await connectFirmware();
    await pending;
    assert.deepEqual(received, ['9\n3000\n\n']);
});
test('a deferred state command is not sent once its end has passed', async (t) => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const until = clock + 3_600_000;
    let worked = false;
    const sending = executeFunction('LEFT_TEMP_DURATION', () => { worked = true; return '1'; }, {
        background: true, latest: true, notAfter: until,
    });
    const outcome = sending.then(() => undefined, (error) => error);
    await pause(50);
    clock = until + 1;
    const received = await connectFirmware();
    assert.ok(await outcome instanceof FrankenUnavailableError);
    await pause(50);
    assert.deepEqual(received, []);
    assert.equal(worked, false);
});
test('a deferred argument that throws fails the command and sends nothing', async () => {
    const sending = executeFunction('LEFT_TEMP_DURATION', () => { throw new Error('no end'); }, { background: true, latest: true });
    const outcome = sending.then(() => undefined, (error) => error);
    await pause(20);
    const received = await connectFirmware();
    assert.match(String(await outcome), /no end/);
    await pause(50);
    assert.deepEqual(received, []);
    await executeFunction('LEFT_TEMP_DURATION', '0', { background: true, latest: true });
    assert.deepEqual(received, ['9\n0\n\n']);
});
//# sourceMappingURL=frankenUnavailable.test.js.map