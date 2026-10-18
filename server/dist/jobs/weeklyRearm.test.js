import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, afterEach, after, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nodeSchedule from 'node-schedule';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-weekly-rearm-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
// An existing settings file, so Rhythms starts off as on an updated Pod.
writeFileSync(path.join(dataFolder, 'lowdb', 'settingsDB.json'), '{}');
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
// Firmware writes as sent, with a deferred argument worked out at the send.
// A command past its notAfter is refused, as the real connection does.
const sent = [];
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: {
        executeFunction: async (command, arg = 'empty', options = {}) => {
            if (options.notAfter !== undefined && Date.now() > options.notAfter)
                throw new Error('Pod hardware became available too late');
            sent.push([command, typeof arg === 'function' ? arg() : arg]);
        },
    },
});
let leftOn = true;
// Runs while the side's status is read, for things that happen meanwhile.
let duringStatusRead = () => { };
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => ({
            getDeviceStatus: async () => {
                duringStatusRead();
                return { left: { isOn: leftOn }, right: { isOn: false } };
            },
        }),
        isFrankenConnected: () => true,
        getDeviceStatusCoalesced: async () => ({ left: { isOn: leftOn }, right: { isOn: false } }),
    },
});
mock.module('chokidar', { defaultExport: { watch: () => ({ on: () => undefined }) } });
mock.module(new URL('./isSystemDateValid.js', import.meta.url).href, { namedExports: { isSystemDateValid: () => true } });
mock.module(new URL('./analyzeSleep.js', import.meta.url).href, { namedExports: { executeAnalyzeSleep: () => { } } });
let settingsDB;
let schedulesDB;
let schedulePowerOn;
let resetPowerOnTimes;
let scheduleWeeklyRearm;
let resetWeeklyArmed;
let firmwareTimer;
let serverStatus;
let setupJobs;
before(async () => {
    ({ default: settingsDB } = await import('../db/settings.js'));
    ({ default: schedulesDB } = await import('../db/schedules.js'));
    ({ schedulePowerOn, resetPowerOnTimes } = await import('./powerScheduler.js'));
    ({ scheduleWeeklyRearm } = await import('./weeklyRearm.js'));
    firmwareTimer = await import('./firmwareTimer.js');
    ({ resetWeeklyArmed } = firmwareTimer);
    ({ default: serverStatus } = await import('../serverStatus.js'));
    ({ setupJobs } = await import('./jobScheduler.js'));
});
const POWER = { on: '21:00', off: '07:00', enabled: true, onTemperature: 80 };
const FIRED = new Date('2026-10-05T21:00:00Z'); // a Monday
const AT_2300 = Date.parse('2026-10-05T23:00:00Z');
const REARM = 'left-weekly-rearm';
let setNow = () => { };
const cancelAll = () => Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
beforeEach(async (context) => {
    const { timers } = context.mock;
    timers.enable({ apis: ['Date'], now: FIRED.getTime() });
    setNow = ms => { timers.setTime(ms); };
    sent.length = 0;
    leftOn = true;
    duringStatusRead = () => { };
    cancelAll();
    resetPowerOnTimes();
    resetWeeklyArmed();
    await settingsDB.read();
    settingsDB.data.timeZone = 'UTC';
    settingsDB.data.features.rhythms = false;
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
        settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
        for (const day of Object.values(schedulesDB.data[side])) {
            day.power.enabled = false;
            day.alarms = [];
        }
    }
    await settingsDB.write();
    schedulesDB.data.left.monday.power = { ...POWER };
    await schedulesDB.write();
});
afterEach(cancelAll);
after(() => {
    cancelAll();
    rmSync(dataFolder, { recursive: true, force: true });
});
// Runs the scheduled power-on at 21:00, then moves to 23:00.
async function powerOnThenWait() {
    schedulePowerOn(settingsDB.data, 'left', 'monday', schedulesDB.data.left.monday.power);
    await nodeSchedule.scheduledJobs['left-monday-21:00-power-on'].invoke(FIRED);
    nodeSchedule.cancelJob('left-monday-21:00-power-on');
    sent.length = 0;
    setNow(AT_2300);
}
async function editMonday(change) {
    schedulesDB.data.left.monday.power = { ...schedulesDB.data.left.monday.power, ...change };
    await schedulesDB.write();
}
// Plans the re-arm the way a rebuild does and runs it now.
async function rearm() {
    const planned = scheduleWeeklyRearm(settingsDB.data, schedulesDB.data, 'left', new Date());
    const job = nodeSchedule.scheduledJobs[REARM];
    assert.equal(Boolean(job), planned);
    if (job) {
        job.cancel();
        await job.invoke();
    }
    return planned;
}
describe('re-arming tonight after a weekly schedule edit', () => {
    it('moves the firmware end later when tonight\'s off moves later', async () => {
        await powerOnThenWait();
        await editMonday({ off: '09:00' });
        assert.equal(await rearm(), true);
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(10 * 3600 + 300)]]);
    });
    it('moves the firmware end earlier when tonight\'s off moves earlier', async () => {
        await powerOnThenWait();
        await editMonday({ off: '05:00' });
        await rearm();
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(6 * 3600 + 300)]]);
    });
    it('runs out 12 hours from tonight\'s power-on, as a manual on would, when tonight\'s power schedule is turned off', async () => {
        await powerOnThenWait();
        await editMonday({ enabled: false });
        await rearm();
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(10 * 3600)]]);
        assert.equal(await rearm(), false, 'later rebuilds leave it alone');
    });
    it('counts those 12 hours from the power-on, not from the edit', async () => {
        await powerOnThenWait();
        setNow(Date.parse('2026-10-06T06:00:00Z'));
        await editMonday({ enabled: false });
        await rearm();
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(3 * 3600)]]);
    });
    it('keeps the armed end when those 12 hours are already over', async () => {
        await editMonday({ off: '10:00' });
        await powerOnThenWait();
        setNow(Date.parse('2026-10-06T09:30:00Z'));
        await editMonday({ enabled: false });
        assert.equal(await rearm(), false);
        assert.deepEqual(sent, []);
        assert.equal(firmwareTimer.armedNight('left')?.until, Date.parse('2026-10-06T10:05:00Z'));
    });
    it('leaves an end that waits for an alarm alone once the off time has come', async () => {
        nodeSchedule.scheduleJob('left-monday-06:58-0-alarm', new Date('2026-10-06T06:58:00Z'), () => { });
        await powerOnThenWait();
        assert.equal(firmwareTimer.armedNight('left')?.until, Date.parse('2026-10-06T07:08:00Z'));
        // The alarm has rung, so its job is gone by the time of the next rebuild.
        nodeSchedule.cancelJob('left-monday-06:58-0-alarm');
        setNow(Date.parse('2026-10-06T07:01:00Z'));
        assert.equal(await rearm(), false);
        assert.deepEqual(sent, []);
    });
    it('does not turn the side back on when the power-off lands between the status read and the write', async () => {
        setNow(Date.parse('2026-10-06T06:59:30Z'));
        duringStatusRead = () => setNow(Date.parse('2026-10-06T07:00:30Z'));
        serverStatus.status.powerSchedule.status = 'healthy';
        await rearm();
        assert.deepEqual(sent, []);
        assert.equal(serverStatus.status.powerSchedule.status, 'healthy');
    });
    it('stops when Rhythms is turned on while it runs', async () => {
        await powerOnThenWait();
        await editMonday({ off: '09:00' });
        duringStatusRead = () => { settingsDB.data.features.rhythms = true; };
        await rearm();
        assert.deepEqual(sent, []);
    });
    it('never stores or plans an end that is not a time', async () => {
        firmwareTimer.noteWeeklyArmed('left', 'monday', FIRED, new Date(Number.NaN));
        assert.equal(firmwareTimer.armedNight('left'), undefined);
        setNow(AT_2300);
        await editMonday({ off: 'xx:yy' });
        assert.equal(await rearm(), false);
        assert.deepEqual(sent, []);
    });
    it('writes nothing when another day is edited', async () => {
        await powerOnThenWait();
        schedulesDB.data.left.tuesday.power = { ...POWER, off: '09:00' };
        await schedulesDB.write();
        assert.equal(await rearm(), false);
        assert.deepEqual(sent, []);
    });
    it('writes nothing when the side is off', async () => {
        await powerOnThenWait();
        leftOn = false;
        await editMonday({ off: '09:00' });
        await rearm();
        assert.deepEqual(sent, []);
    });
    it('writes nothing while the schedule is paused', async () => {
        await powerOnThenWait();
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        await editMonday({ off: '09:00' });
        assert.equal(await rearm(), false);
        assert.deepEqual(sent, []);
    });
    it('arms a running night this process did not turn on, such as after a restart', async () => {
        setNow(AT_2300);
        await rearm();
        assert.deepEqual(sent, [['LEFT_TEMP_DURATION', String(8 * 3600 + 300)]]);
        assert.equal(await rearm(), false, 'an armed night is not written again');
    });
    it('leaves the side alone outside a running night', async () => {
        setNow(FIRED.getTime() - 3600_000);
        assert.equal(await rearm(), false);
    });
    it('is planned by a job rebuild', async () => {
        await powerOnThenWait();
        await editMonday({ off: '09:00' });
        await setupJobs();
        assert.ok(nodeSchedule.scheduledJobs[REARM], 'the rebuild did not plan a re-arm');
    });
});
//# sourceMappingURL=weeklyRearm.test.js.map