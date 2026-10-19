import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
// config.ts throws if these aren't set, and reading it is what settingsDB.ts
// needs to resolve its lowdb path, must run before the dynamic imports
// below. A fresh temp dir keeps this test isolated from any real
// settingsDB.json on the machine running it.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-updateDeviceStatus-test-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
// Keep firmware commands local to the test.
const executeFunctionMock = mock.fn(async (...args) => { void args; });
mock.module('../../8sleep/deviceApi.js', {
    namedExports: { executeFunction: executeFunctionMock },
});
const alarmCommandMock = mock.fn(async (command, arg) => { void command; void arg; });
const alarmConnectionMock = mock.fn(async (options, key) => {
    void options;
    void key;
    return { callFunction: alarmCommandMock };
});
mock.module('../../8sleep/frankenServer.js', {
    namedExports: { connectFrankenWithin: alarmConnectionMock },
});
const { updateDeviceStatus } = await import('./updateDeviceStatus.js');
const { default: settingsDB } = await import('../../db/settings.js');
const { FrankenSupersededError } = await import('../../8sleep/frankenErrors.js');
const { keptSleeps, rememberKeptAlarms } = await import('../../jobs/rhythms/keptAlarms.js');
const { wasSentSince } = await import('../../8sleep/sentTargets.js');
describe('updateDeviceStatus', () => {
    it('notes the target it sends, so the monitor does not read it as a change on the bed', async () => {
        const before = Date.now();
        await updateDeviceStatus({ left: { targetTemperatureF: 73 } });
        assert.equal(wasSentSince('left', 73, before), true);
        assert.equal(wasSentSince('right', 73, before), false);
    });
    it('preserves all canonical and off-grid temperature writes with firmware readout on and off', async () => {
        const targets = [55, 58, 61, 63, 66, 69, 72, 74, 77, 80, 83, 85, 88, 91, 94, 96, 99, 102, 105, 107, 110, 82.5, 79.3];
        const expected = [-100, -89, -78, -71, -60, -49, -38, -31, -20, -9, 2, 9, 20, 31, 42, 49, 60, 71, 82, 89, 100, 0, -12];
        try {
            for (const enabled of [false, true]) {
                settingsDB.data.features.firmwareTargetReadout = enabled;
                await settingsDB.write();
                for (const [index, target] of targets.entries()) {
                    executeFunctionMock.mock.resetCalls();
                    await updateDeviceStatus({ left: { targetTemperatureF: target }, right: { targetTemperatureF: target } });
                    assert.deepEqual(executeFunctionMock.mock.calls.map(call => call.arguments.slice(0, 2)), [
                        ['TEMP_LEVEL_LEFT', String(expected[index])], ['TEMP_LEVEL_RIGHT', String(expected[index])],
                    ]);
                }
            }
        }
        finally {
            settingsDB.data.features.firmwareTargetReadout = false;
            await settingsDB.write();
        }
    });
    for (const payload of [{ isOn: true }, { isOn: true, secondsRemaining: 0 }]) {
        it(`keeps the manual power-on default for ${JSON.stringify(payload)}`, async () => {
            executeFunctionMock.mock.resetCalls();
            await updateDeviceStatus({ left: payload });
            assert.deepEqual(executeFunctionMock.mock.calls.map(call => call.arguments.slice(0, 2)), [['LEFT_TEMP_DURATION', '43200']]);
        });
    }
    it('clamps an explicit targetTemperatureF of 0 to the minimum', async () => {
        executeFunctionMock.mock.resetCalls();
        await updateDeviceStatus({ left: { targetTemperatureF: 0 } });
        const levelCall = executeFunctionMock.mock.calls.find((call) => call.arguments[0] === 'TEMP_LEVEL_LEFT');
        assert.ok(levelCall, 'expected TEMP_LEVEL_LEFT to be sent for an explicit 0 target');
        assert.equal(levelCall.arguments[1], '-100');
    });
    for (const side of ['left', 'right']) {
        for (const [target, level] of [[54, '-100'], [55, '-100'], [110, '100'], [111, '100']]) {
            it(`bounds an internal ${side} target of ${target} F`, async () => {
                executeFunctionMock.mock.resetCalls();
                await updateDeviceStatus({ [side]: { targetTemperatureF: target } });
                assert.deepEqual(executeFunctionMock.mock.calls.map(call => call.arguments.slice(0, 2)), [
                    [side === 'left' ? 'TEMP_LEVEL_LEFT' : 'TEMP_LEVEL_RIGHT', level],
                ]);
            });
        }
    }
    it('still applies a normal positive targetTemperatureF', async () => {
        executeFunctionMock.mock.resetCalls();
        await updateDeviceStatus({ right: { targetTemperatureF: 82.5 } });
        const levelCall = executeFunctionMock.mock.calls.find((call) => call.arguments[0] === 'TEMP_LEVEL_RIGHT');
        assert.ok(levelCall);
        assert.equal(levelCall.arguments[1], '0');
    });
    it('marks power and set point commands as state, and alarm clearing as not', async () => {
        executeFunctionMock.mock.resetCalls();
        alarmCommandMock.mock.resetCalls();
        alarmConnectionMock.mock.resetCalls();
        const { default: memoryDB } = await import('../../db/memoryDB.js');
        memoryDB.data.left.isAlarmVibrating = true;
        await updateDeviceStatus({ left: { isOn: false, targetTemperatureF: 80, isAlarmVibrating: false } }, { background: true });
        const options = (command) => executeFunctionMock.mock.calls
            .find(call => call.arguments[0] === command)?.arguments[2];
        assert.equal(options('LEFT_TEMP_DURATION')?.latest, true);
        assert.equal(options('TEMP_LEVEL_LEFT')?.latest, true);
        assert.equal(alarmCommandMock.mock.calls[0]?.arguments[0], 'ALARM_LEFT');
        assert.deepEqual(alarmConnectionMock.mock.calls[0]?.arguments, [{ background: true }, 'ALARM_LEFT']);
    });
    it('stops quietly when a newer update replaced this one while the Pod was unreachable', async () => {
        executeFunctionMock.mock.resetCalls();
        executeFunctionMock.mock.mockImplementationOnce(async () => { throw new FrankenSupersededError(); });
        await updateDeviceStatus({ left: { isOn: true, targetTemperatureF: 80 } }, { background: true });
        assert.equal(executeFunctionMock.mock.callCount(), 1, 'the set point of a replaced power-on must not be sent');
    });
    it('mirrors a timed power-on to both sides while one side is away', async () => {
        settingsDB.data.right.awayMode = true;
        await settingsDB.write();
        executeFunctionMock.mock.resetCalls();
        try {
            await updateDeviceStatus({ left: { isOn: true, targetTemperatureF: 80, secondsRemaining: 29100 } }, { background: true });
        }
        finally {
            settingsDB.data.right.awayMode = false;
            await settingsDB.write();
        }
        // The third argument is the command options, pinned by the tests above.
        assert.deepEqual(executeFunctionMock.mock.calls.map(call => call.arguments.slice(0, 2)), [
            ['LEFT_TEMP_DURATION', '43200'], ['RIGHT_TEMP_DURATION', '43200'],
            ['TEMP_LEVEL_LEFT', '-9'], ['TEMP_LEVEL_RIGHT', '-9'],
            ['LEFT_TEMP_DURATION', '29100'], ['RIGHT_TEMP_DURATION', '29100'],
        ]);
    });
    it('turns a side on until a set time in one duration write, counted when it is sent', async (t) => {
        const now = Date.parse('2026-10-05T21:00:00Z');
        t.mock.timers.enable({ apis: ['Date'], now });
        const onUntil = new Date(now + 10 * 3600_000);
        const sent = [];
        executeFunctionMock.mock.resetCalls();
        executeFunctionMock.mock.mockImplementation(async (command, arg) => {
            // The Pod answers 15 minutes late.
            t.mock.timers.tick(15 * 60_000);
            sent.push([command, typeof arg === 'function' ? arg() : String(arg)]);
        });
        try {
            await updateDeviceStatus({ left: { isOn: true, targetTemperatureF: 80 } }, { background: true, onUntil });
        }
        finally {
            executeFunctionMock.mock.restore();
        }
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(10 * 3600 - 15 * 60)], ['TEMP_LEVEL_LEFT', '-9']]);
        const options = executeFunctionMock.mock.calls[0].arguments[2];
        assert.equal(options.latest, true);
        assert.equal(options.notAfter, onUntil.getTime(), 'a power-on that can only go out after its end is not sent');
        assert.equal(options.onUntil, undefined);
    });
    it('caps a set end at the firmware maximum', async () => {
        executeFunctionMock.mock.resetCalls();
        const onUntil = new Date(Date.now() + 13 * 3600_000);
        await updateDeviceStatus({ right: { isOn: true } }, { background: true, onUntil });
        const [command, arg] = executeFunctionMock.mock.calls[0].arguments;
        assert.equal(command, 'RIGHT_TEMP_DURATION');
        assert.equal(typeof arg === 'function' ? arg() : arg, '43200');
        assert.equal(executeFunctionMock.mock.callCount(), 1);
    });
    it('treats an end that is not a time as a plain power-on', async () => {
        executeFunctionMock.mock.resetCalls();
        await updateDeviceStatus({ left: { isOn: true } }, { background: true, onUntil: new Date(Number.NaN) });
        assert.deepEqual(executeFunctionMock.mock.calls.map(call => call.arguments.slice(0, 2)), [['LEFT_TEMP_DURATION', '43200']]);
        const options = executeFunctionMock.mock.calls[0].arguments[2];
        assert.equal(options.notAfter, undefined);
    });
    it('forgets the kept alarms of a side that is turned off', async () => {
        const name = 'rhythm-left-2026-09-28-alarm-0600-0';
        schedule.scheduleJob(name, new Date(Date.now() + 60_000), () => { });
        rememberKeptAlarms('left', { sleep: {}, alarms: [{ name, event: {} }] });
        await updateDeviceStatus({ left: { isOn: false } });
        assert.equal(schedule.scheduledJobs[name], undefined);
        assert.deepEqual(keptSleeps(), []);
    });
    it('forgets the kept alarms of both sides when one is away, since both turn off', async () => {
        const names = ['rhythm-left-2026-09-28-alarm-0600-0', 'rhythm-right-2026-09-28-alarm-0600-0'];
        names.forEach(name => schedule.scheduleJob(name, new Date(Date.now() + 60_000), () => { }));
        rememberKeptAlarms('left', { sleep: {}, alarms: [{ name: names[0], event: {} }] });
        rememberKeptAlarms('right', { sleep: {}, alarms: [{ name: names[1], event: {} }] });
        settingsDB.data.right.awayMode = true;
        await settingsDB.write();
        try {
            await updateDeviceStatus({ left: { isOn: false } });
        }
        finally {
            settingsDB.data.right.awayMode = false;
            await settingsDB.write();
        }
        names.forEach(name => assert.equal(schedule.scheduledJobs[name], undefined));
        assert.deepEqual(keptSleeps(), []);
    });
});
//# sourceMappingURL=updateDeviceStatus.test.js.map