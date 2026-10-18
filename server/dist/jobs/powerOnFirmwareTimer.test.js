import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nodeSchedule from 'node-schedule';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-power-timer-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
const sent = [];
let sendDelayMs = 0;
let tick = () => { };
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: {
        executeFunction: async (command, arg = 'empty', options = {}) => {
            if (sendDelayMs)
                tick(sendDelayMs);
            sent.push({ command, arg: typeof arg === 'function' ? arg() : arg, notAfter: options.notAfter });
        },
    },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: { connectFrankenWithin: async () => { throw new Error('No hardware connection under test'); } },
});
let settingsDB;
let schedulePowerOn;
let schedulePowerOff;
let resetPowerOnTimes;
let WEEKLY_FIRMWARE_MARGIN_SECONDS;
before(async () => {
    ({ default: settingsDB } = await import('../db/settings.js'));
    ({ schedulePowerOn, schedulePowerOff, resetPowerOnTimes } = await import('./powerScheduler.js'));
    ({ WEEKLY_FIRMWARE_MARGIN_SECONDS } = await import('./firmwareTimer.js'));
});
beforeEach(async () => {
    sent.length = 0;
    sendDelayMs = 0;
    Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
    resetPowerOnTimes();
    await settingsDB.read();
    settingsDB.data.timeZone = 'UTC';
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
        settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
    }
    await settingsDB.write();
});
after(() => {
    Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
    rmSync(dataFolder, { recursive: true, force: true });
});
const POWER = { on: '21:00', off: '07:00', enabled: true, onTemperature: 80 };
const FIRED = new Date('2026-10-05T21:00:00Z');
const OFF_AT = Date.parse('2026-10-06T07:00:00Z') + 300_000;
const job = (name) => nodeSchedule.scheduledJobs[name];
const minutes = (count) => count * 60_000;
describe('scheduled power-on', () => {
    beforeEach((context) => {
        const { timers } = context.mock;
        timers.enable({ apis: ['Date'], now: FIRED.getTime() });
        tick = ms => { timers.tick(ms); };
    });
    it('turns the side on until five minutes after the scheduled off, in one firmware write', async () => {
        assert.equal(WEEKLY_FIRMWARE_MARGIN_SECONDS, 300);
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.deepEqual(sent, [
            { command: 'LEFT_TEMP_DURATION', arg: String(10 * 3600 + 300), notAfter: OFF_AT },
            { command: 'TEMP_LEVEL_LEFT', arg: '-9', notAfter: undefined },
        ]);
    });
    it('counts the duration from when the command is sent, not when the job fired', async () => {
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        sendDelayMs = minutes(20);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.equal(sent[0].command, 'LEFT_TEMP_DURATION');
        assert.equal(sent[0].arg, String(10 * 3600 + 300 - 20 * 60));
    });
    it('never keeps the side on past five minutes after the off, however late the command goes out', async () => {
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        sendDelayMs = 10 * 3600_000 + 100_000;
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.equal(sent[0].arg, '200');
        // Later than OFF_AT, the command is not sent at all.
        assert.equal(sent[0].notAfter, OFF_AT);
    });
    it('keeps a manual temperature but still sends the off time', async () => {
        settingsDB.data.left.scheduleOverrides.temperatureSchedules = {
            disabled: true, expiresAt: new Date(FIRED.getTime() + 3600_000).toISOString(),
        };
        await settingsDB.write();
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.deepEqual(sent, [
            { command: 'LEFT_TEMP_DURATION', arg: String(10 * 3600 + 300), notAfter: OFF_AT },
        ]);
    });
    it('gives both sides the off time while one is away', async () => {
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        settingsDB.data.right.awayMode = true;
        await settingsDB.write();
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.deepEqual(sent.map(({ command, arg }) => [command, arg]), [
            ['LEFT_TEMP_DURATION', '36300'], ['RIGHT_TEMP_DURATION', '36300'],
            ['TEMP_LEVEL_LEFT', '-9'], ['TEMP_LEVEL_RIGHT', '-9'],
        ]);
    });
    it('leaves room for an alarm due in the three minutes before the off to start late and ring in full', async () => {
        const { ALARM_LATE_LIMIT_MS } = await import('./alarmActivity.js');
        const { ALARM_FIRMWARE_MARGIN_SECONDS } = await import('./firmwareTimer.js');
        // 300 s is the longest alarm the schedule accepts.
        assert.ok(ALARM_FIRMWARE_MARGIN_SECONDS * 1000 >= ALARM_LATE_LIMIT_MS + 300_000);
        nodeSchedule.scheduleJob('left-monday-06:58-0-alarm', new Date('2026-10-06T06:58:00Z'), () => { });
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.deepEqual(sent[0], {
            command: 'LEFT_TEMP_DURATION', arg: String(10 * 3600 + ALARM_FIRMWARE_MARGIN_SECONDS), notAfter: OFF_AT + 180_000,
        });
    });
    it('counts a one-off alarm at the off time too', async () => {
        nodeSchedule.scheduleJob('left-one-off-alarm', new Date('2026-10-06T07:00:00Z'), () => { });
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.equal(sent[0].arg, String(10 * 3600 + 480));
    });
    it('keeps the usual margin for an alarm well before the off, or on the other side', async () => {
        nodeSchedule.scheduleJob('left-monday-06:50-0-alarm', new Date('2026-10-06T06:50:00Z'), () => { });
        nodeSchedule.scheduleJob('right-monday-07:00-0-alarm', new Date('2026-10-06T07:00:00Z'), () => { });
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        assert.equal(sent[0].arg, String(10 * 3600 + 300));
    });
    it('leaves a side paused until resumed to turn off a few minutes after its scheduled off, not 12 hours after it came on', async () => {
        schedulePowerOn(settingsDB.data, 'left', 'monday', POWER);
        schedulePowerOff(settingsDB.data, 'left', 'monday', POWER);
        await job('left-monday-21:00-power-on').invoke(FIRED);
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        tick(10 * 3600_000);
        await job('left-monday-07:00-power-off').invoke(new Date('2026-10-06T07:00:00Z'));
        // The pause skips the power-off, so the firmware timer set at power-on
        // is what turns the side off.
        assert.deepEqual(sent.map(({ command, arg }) => [command, arg]), [
            ['LEFT_TEMP_DURATION', String(10 * 3600 + 300)], ['TEMP_LEVEL_LEFT', '-9'],
        ]);
    });
});
//# sourceMappingURL=powerOnFirmwareTimer.test.js.map