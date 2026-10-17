import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-rhythm-events-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const updates = [];
const updateOptions = [];
const writes = { fail: false };
const commands = [];
const analyses = [];
const deviceStatus = { left: { isOn: true }, right: { isOn: true } };
const pod = { connected: true };
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: {
        updateDeviceStatus: async (value, options) => {
            if (writes.fail)
                throw new Error('Pod hardware is not connected; gave up after 10s');
            updates.push(value);
            updateOptions.push(options);
        },
    },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async (...args) => { commands.push(args); } },
});
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => {
            if (!pod.connected)
                throw new Error('Pod hardware is not connected; gave up after 120s');
            pod.onConnect?.();
            return { getDeviceStatus: async () => deviceStatus };
        },
        getDeviceStatusCoalesced: async () => deviceStatus,
    },
});
mock.module(new URL('../analyzeSleep.js', import.meta.url).href, {
    namedExports: { executeAnalyzeSleep: (...args) => { analyses.push(args); } },
});
const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { default: servicesDB } = await import('../../db/services.js');
const { default: memoryDB } = await import('../../db/memoryDB.js');
const { resolveSleeps, withPowerOff } = await import('./resolve.js');
const { everyNight, testNight, testRhythmsDB } = await import('./testSupport.js');
const { armExtensionStep, armedEnd, holdForHandBack, ANALYSIS_MAX_WINDOW_MS, REANALYSIS_DELAY_MS, firmwareSeconds, rearmRhythmSleep, resetOffTimes, runRhythmEvent, runSleepAnalysis, } = await import('./runEvent.js');
const { hasAlarmOccurrence, resetAlarmOccurrences } = await import('../alarmScheduler.js');
const { resetAlarmActivity, trackAlarm } = await import('../alarmActivity.js');
const { DEFAULT_SMART } = await import('../../db/rhythmsSchema.js');
const { smartPowerOffFor, startCurveController, stopCurveController } = await import('./curveController.js');
const { resetPowerOnTimes } = await import('../powerScheduler.js');
const { setEngineActivation } = await import('../scheduleQueries.js');
const { nextReboot } = await import('../rebootTime.js');
const { changesPath, flushHandChanges, forgetHandChanges } = await import('./handChanges.js');
const at = (iso) => new Date(iso);
const setNow = (iso) => mock.timers.setTime(Date.parse(iso));
const noTimers = () => ({ unref() { } });
const alarmCommands = (name) => commands.filter(([command]) => command === name).length;
function sleepOn(date) {
    const night = testNight('22:00', '06:00', { temperatures: { '02:00': 72 }, alarms: ['05:45'] });
    const from = at(`${date}T12:00:00Z`);
    const sleep = resolveSleeps({
        db: testRhythmsDB(schedulesDB.data, everyNight(night)),
        side: 'left', timeZone: 'UTC', from, to: new Date(from.getTime() + 24 * 3600_000),
    }).find(candidate => candidate.date === date);
    assert.ok(sleep, `no sleep resolved for ${date}`);
    return sleep;
}
function eventOf(sleep, kind) {
    const event = sleep.events.find(candidate => candidate.kind === kind);
    assert.ok(event, `no ${kind} event`);
    return event;
}
beforeEach(async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T12:00:00Z') });
    resetAlarmActivity();
    resetAlarmOccurrences();
    resetPowerOnTimes();
    resetOffTimes();
    pod.connected = true;
    pod.onConnect = undefined;
    writes.fail = false;
    updates.length = 0;
    updateOptions.length = 0;
    commands.length = 0;
    analyses.length = 0;
    deviceStatus.left.isOn = true;
    deviceStatus.right.isOn = true;
    settingsDB.data.timeZone = 'UTC';
    // Restarts at 13:30, clear of the sleeps here unless a test moves it.
    settingsDB.data.primePodDaily = { enabled: true, time: '14:30' };
    settingsDB.data.rebootDaily = true;
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].alarmsEnabled = true;
        settingsDB.data[side].scheduleOverrides = {
            temperatureSchedules: { disabled: false, expiresAt: '' },
            alarm: { disabled: false, timeOverride: '', expiresAt: '' },
            pause: { active: false, expiresAt: '' },
        };
    }
    await settingsDB.write();
    servicesDB.data.biometrics.enabled = true;
    await servicesDB.write();
    memoryDB.data.left = { isAlarmVibrating: false, analyzeSleep: {} };
    memoryDB.data.right = { isAlarmVibrating: false, analyzeSleep: {} };
    await memoryDB.write();
});
afterEach(() => mock.timers.reset());
after(() => rmSync(folder, { recursive: true, force: true }));
describe('power-on', () => {
    it('hands the firmware the sleep end plus five minutes in one timed write', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
        assert.deepEqual(updateOptions, [{ background: true, onUntil: at('2026-09-29T06:05:00Z') }]);
    });
    it('gives the same end however late the job runs, counted when the write is sent', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:02:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.deepEqual(updateOptions, [{ background: true, onUntil: at('2026-09-29T06:05:00Z') }]);
    });
    it('never asks for more than twelve hours', () => {
        assert.equal(firmwareSeconds(at('2026-09-29T14:00:00Z'), at('2026-09-28T22:00:00Z')), 43200);
        assert.equal(firmwareSeconds(at('2026-09-28T22:00:01Z'), at('2026-09-28T22:00:00Z')), 301);
    });
    it('does not power on once the sleep has ended', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.deepEqual(updates, []);
    });
    it('keeps a manual temperature while still setting the off time', async () => {
        settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: true, expiresAt: '2026-09-29T09:00:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.deepEqual(updates, [{ left: { isOn: true } }]);
        assert.deepEqual(updateOptions[0], { background: true, onUntil: at('2026-09-29T06:05:00Z') });
    });
});
describe('temperature and power-off', () => {
    it('sets the rhythm temperature', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T02:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'temperature'));
        assert.deepEqual(updates, [{ left: { targetTemperatureF: 72 } }]);
    });
    it('skips a temperature change while a manual change holds it', async () => {
        settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: true, expiresAt: '2026-09-29T09:00:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T02:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'temperature'));
        assert.deepEqual(updates, []);
    });
    it('turns the side off at the end', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('sends every write as scheduled work that waits out a reconnect', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        setNow('2026-09-29T02:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'temperature'));
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updateOptions, [{ background: true, onUntil: at('2026-09-29T06:05:00Z') }, { background: true }, { background: true }]);
    });
    it('leaves on a sleep that started in the minute this one ends', async () => {
        const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('06:00', '06:00')));
        const sleeps = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: at('2026-09-28T12:00:00Z'), to: at('2026-09-29T12:00:00Z') });
        const ending = sleeps.find(candidate => candidate.date === '2026-09-28');
        const starting = sleeps.find(candidate => candidate.date === '2026-09-29');
        assert.ok(ending && starting, 'two back-to-back sleeps');
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', starting, eventOf(starting, 'power-on'));
        await runRhythmEvent('left', ending, eventOf(ending, 'power-off'));
        assert.equal(updates.length, 1);
        assert.equal(updates[0].left.isOn, true);
    });
});
describe('alarm', () => {
    it('rings once per occurrence and records it', async (t) => {
        t.mock.method(globalThis, 'setTimeout', noTimers);
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T05:45:00Z');
        assert.equal(await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm')), 20_000);
        assert.equal(await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm')), 0);
        assert.equal(alarmCommands('ALARM_LEFT'), 1);
        assert.equal(hasAlarmOccurrence('left', 'rhythm:left:2026-09-28:05:45'), true);
    });
    it('skips an alarm that could only start more than three minutes late', async (t) => {
        t.mock.method(globalThis, 'setTimeout', noTimers);
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T05:49:00Z');
        assert.equal(await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm')), 0);
        assert.equal(alarmCommands('ALARM_LEFT'), 0);
        assert.equal(hasAlarmOccurrence('left', 'rhythm:left:2026-09-28:05:45'), false);
    });
    it('skips the alarms of a sleep whose override expired inside it', async () => {
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '05:00', expiresAt: '2026-09-30T05:02:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-29');
        setNow('2026-09-30T05:45:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm'));
        assert.deepEqual(commands, []);
    });
    it('rings when the override belongs to an earlier night', async (t) => {
        t.mock.method(globalThis, 'setTimeout', noTimers);
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: true, timeOverride: '', expiresAt: '2026-09-30T07:00:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-30');
        setNow('2026-10-01T05:45:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm'));
        assert.equal(alarmCommands('ALARM_LEFT'), 1);
    });
});
describe('pause', () => {
    it('leaves a paused side alone, power-off included', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        for (const kind of ['power-on', 'temperature', 'alarm', 'power-off']) {
            await runRhythmEvent('left', sleep, eventOf(sleep, kind));
        }
        assert.deepEqual(updates, []);
        assert.deepEqual(commands, []);
    });
    it('silences an alarm due exactly at the end of a pause even when the job starts late', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T05:45:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T05:45:02Z');
        assert.equal(await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm')), 0);
        assert.deepEqual(commands, []);
    });
    it('still turns the side off when the power-off is due exactly at the end of a pause', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T06:00:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('judges a power-off held back by an alarm at the time it was due', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T06:03:00+00:00' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        // A one-time alarm, which rings through a pause, held the power-off past the pause's end.
        setNow('2026-09-29T06:05:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, []);
    });
    it('writes nothing for a paused side when the next sleep starts as this one ends', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('06:00', '06:00')));
        const sleeps = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: at('2026-09-28T12:00:00Z'), to: at('2026-09-29T12:00:00Z') });
        const ending = sleeps.find(candidate => candidate.date === '2026-09-28');
        const starting = sleeps.find(candidate => candidate.date === '2026-09-29');
        assert.ok(ending && starting, 'two back-to-back sleeps');
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', starting, eventOf(starting, 'power-on'));
        await runRhythmEvent('left', ending, eventOf(ending, 'power-off'));
        assert.deepEqual(updates, []);
    });
});
describe('away mode', () => {
    it('drives the whole bed from the present side with one update', async () => {
        settingsDB.data.right.awayMode = true;
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
    });
    it('rings an alarm only on the present side', async (t) => {
        t.mock.method(globalThis, 'setTimeout', noTimers);
        settingsDB.data.right.awayMode = true;
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T05:45:00Z');
        assert.equal(await runRhythmEvent('left', sleep, eventOf(sleep, 'alarm')), 20_000);
        assert.equal(alarmCommands('ALARM_LEFT'), 1);
        assert.equal(alarmCommands('ALARM_RIGHT'), 0);
    });
    it("ignores the away side's own rhythm", async () => {
        settingsDB.data.left.awayMode = true;
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        await runSleepAnalysis('left', sleep);
        assert.deepEqual(updates, []);
        assert.deepEqual(analyses, []);
    });
});
describe('moving the off time of a sleep in progress', () => {
    const later = () => ({ ...sleepOn('2026-09-28'), end: at('2026-09-29T09:00:00Z') });
    beforeEach(() => setEngineActivation({ active: true, db: testRhythmsDB(schedulesDB.data, everyNight(null)) }));
    afterEach(() => setEngineActivation({ active: false, reason: 'flag-off' }));
    it('sends the new end plus five minutes as scheduled work', async () => {
        setNow('2026-09-28T23:00:00Z');
        await rearmRhythmSleep('left', later());
        assert.deepEqual(updates, [{ left: { secondsRemaining: 10 * 3600 + 300 } }]);
        assert.deepEqual(updateOptions, [{ background: true }]);
    });
    it('sends nothing when the power-on already sent that end', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        updates.length = 0;
        await rearmRhythmSleep('left', sleep);
        assert.deepEqual(updates, []);
    });
    it('never turns on a side that is off', async () => {
        deviceStatus.left.isOn = false;
        setNow('2026-09-28T23:00:00Z');
        await rearmRhythmSleep('left', later());
        assert.deepEqual(updates, []);
    });
    it('waits for the next plan when the Pod does not reconnect in time', async () => {
        pod.connected = false;
        setNow('2026-09-28T23:00:00Z');
        await rearmRhythmSleep('left', later());
        assert.deepEqual(updates, []);
        pod.connected = true;
        await rearmRhythmSleep('left', later());
        assert.equal(updates.length, 1);
    });
    it('sends nothing when Rhythms was turned off while it waited for the Pod', async () => {
        pod.onConnect = () => setEngineActivation({ active: false, reason: 'flag-off' });
        setNow('2026-09-28T23:00:00Z');
        await rearmRhythmSleep('left', later());
        assert.deepEqual(updates, []);
    });
    it('leaves a paused or away side alone', async () => {
        setNow('2026-09-28T23:00:00Z');
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T10:00:00+00:00' };
        await settingsDB.write();
        await rearmRhythmSleep('left', later());
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        settingsDB.data.left.awayMode = true;
        await settingsDB.write();
        await rearmRhythmSleep('left', later());
        assert.deepEqual(updates, []);
    });
});
describe('end-of-sleep analysis', () => {
    it('analyses the sleep with an hour either side', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T06:15:00Z');
        await runSleepAnalysis('left', sleep);
        assert.deepEqual(analyses, [['left', '2026-09-28T21:00:00.000Z', '2026-09-29T07:00:00.000Z']]);
    });
    it('re-analyses two hours after the end over the 25 hours before that', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-29T08:00:00Z');
        await runSleepAnalysis('left', sleep, REANALYSIS_DELAY_MS, ANALYSIS_MAX_WINDOW_MS);
        assert.deepEqual(analyses, [['left', '2026-09-28T07:00:00.000Z', '2026-09-29T08:00:00.000Z']]);
    });
    it('skips analysis without biometrics', async () => {
        servicesDB.data.biometrics.enabled = false;
        await servicesDB.write();
        await runSleepAnalysis('left', sleepOn('2026-09-28'));
        assert.deepEqual(analyses, []);
    });
});
describe('"When I get up" sleeps', () => {
    const inBed = { value: true };
    // 22:00 to 06:00 UTC with a 05:45 alarm, on Smart Schedule with "When I get up".
    function upSleepOn(date) {
        const side = everyNight(testNight('22:00', '06:00', { alarms: ['05:45'] }));
        side.rhythms['every-night'].temperatureMode = 'smart';
        side.rhythms['every-night'].smart = { ...DEFAULT_SMART, offWhenUp: true };
        const from = at(`${date}T12:00:00Z`);
        const sleep = resolveSleeps({
            db: testRhythmsDB(schedulesDB.data, side), side: 'left', timeZone: 'UTC', from, to: new Date(from.getTime() + 24 * 3600_000),
        }).find(candidate => candidate.date === date);
        assert.ok(sleep, `no sleep resolved for ${date}`);
        return sleep;
    }
    const startController = () => startCurveController({
        now: () => new Date(),
        presence: () => {
            const stamp = new Date().toISOString();
            return { left: { present: inBed.value, lastUpdatedAt: stamp, stateChangedAt: stamp }, right: { present: false } };
        },
        awayMode: () => ({ left: false, right: false }),
        isPaused: () => false,
        sleeps: () => [],
        applyLevel: async () => { },
        retime: () => { },
        recordHistory: async () => { },
        smartOff: {
            sideIsOn: async () => true,
            powerOff: async () => true,
            armTimer: async () => true,
            alarmPending: () => false,
            nextRestart: after => nextReboot(settingsDB.data, after),
        },
    });
    afterEach(() => {
        stopCurveController();
        inBed.value = true;
    });
    it('gives the firmware 15 minutes past the set off at power-on', async () => {
        const sleep = upSleepOn('2026-09-28');
        setNow('2026-09-28T21:30:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        assert.equal(updateOptions[0].onUntil.getTime(), sleep.end.getTime() + 900_000);
    });
    it('keeps the side on at the set off while someone is in bed, and turns it off at the latest', async () => {
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, []);
        const latest = smartPowerOffFor('left', '2026-09-28');
        assert.equal(latest?.toISOString(), '2026-09-29T09:00:00.000Z');
        setNow('2026-09-29T09:00:00Z');
        const later = withPowerOff(sleep, latest);
        await runRhythmEvent('left', later, eventOf(later, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('keeps the side on no later than 30 minutes before the daily restart', async () => {
        settingsDB.data.primePodDaily = { enabled: true, time: '09:00' };
        await settingsDB.write();
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, []);
        assert.equal(smartPowerOffFor('left', '2026-09-28')?.toISOString(), '2026-09-29T07:30:00.000Z');
    });
    it('turns off at the set time when the bed is empty', async () => {
        inBed.value = false;
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('decides after an alarm at the set off has rung, with presence at that moment', async () => {
        inBed.value = false;
        const sleep = upSleepOn('2026-09-28');
        startController();
        let ring = () => { };
        void trackAlarm('left', 'rhythm-left-2026-09-28-alarm-0600-0', () => new Promise(resolve => { ring = resolve; }));
        setNow('2026-09-29T06:00:00Z');
        const off = runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        // Still in bed when the alarm stops.
        setImmediate(() => {
            inBed.value = true;
            ring(0);
        });
        await off;
        assert.deepEqual(updates, []);
        assert.equal(smartPowerOffFor('left', '2026-09-28')?.toISOString(), '2026-09-29T09:00:00.000Z');
    });
    it('skips a paused set off as before, without keeping the side on', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, []);
        assert.equal(smartPowerOffFor('left', '2026-09-28'), undefined);
    });
    it('arms a short step and has the plan treat the latest off as armed', async () => {
        assert.equal(await armExtensionStep('left', at('2026-09-29T06:15:00Z'), at('2026-09-29T09:00:00Z'), at('2026-09-29T06:00:00Z')), true);
        assert.deepEqual(updates, [{ left: { secondsRemaining: 15 * 60 + 300 } }]);
        // Fail fast: a step that cannot reach the Pod now is dropped, not delivered late.
        assert.deepEqual(updateOptions, [{}]);
        assert.equal(armedEnd('left'), at('2026-09-29T09:00:00Z').getTime());
    });
    it('turns off at the set time when the controller cannot decide', async () => {
        const sleep = upSleepOn('2026-09-28');
        startCurveController({
            now: () => new Date(),
            presence: () => { throw new Error('presence unreadable'); },
            awayMode: () => ({ left: false, right: false }),
            isPaused: () => false,
            sleeps: () => [],
            applyLevel: async () => { },
            retime: () => { },
            recordHistory: async () => { },
            smartOff: {
                sideIsOn: async () => true,
                powerOff: async () => true,
                armTimer: async () => true,
                alarmPending: () => false,
                nextRestart: after => nextReboot(settingsDB.data, after),
            },
        });
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('never re-arms a kept-on side past its next step', async () => {
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        const latest = smartPowerOffFor('left', '2026-09-28');
        assert.ok(latest);
        updates.length = 0;
        // The plan now resolves the sleep to the latest off and re-arms whatever it has not armed.
        setNow('2026-09-29T06:00:01Z');
        await rearmRhythmSleep('left', withPowerOff(sleep, latest));
        assert.deepEqual(updates, []);
        assert.equal(armedEnd('left'), latest.getTime());
    });
    it('turns off at the latest even when the job runs a moment early', async () => {
        const sleep = upSleepOn('2026-09-28');
        startController();
        setNow('2026-09-29T06:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-off'));
        const later = withPowerOff(sleep, smartPowerOffFor('left', '2026-09-28'));
        setNow('2026-09-29T08:59:59.990Z');
        await runRhythmEvent('left', later, eventOf(later, 'power-off'));
        assert.deepEqual(updates, [{ left: { isOn: false } }]);
    });
    it('rejects a step the Pod did not take, so the controller tries again', async () => {
        writes.fail = true;
        await assert.rejects(armExtensionStep('left', at('2026-09-29T06:15:00Z'), at('2026-09-29T09:00:00Z'), at('2026-09-29T06:00:00Z')));
        assert.deepEqual(updates, []);
    });
    it('arms nothing while handing back before a stop', async () => {
        holdForHandBack(new Date());
        assert.equal(await armExtensionStep('left', at('2026-09-29T06:15:00Z'), at('2026-09-29T09:00:00Z'), at('2026-09-29T06:00:00Z')), false);
        assert.deepEqual(updates, []);
    });
});
describe('night notes', () => {
    beforeEach(async () => {
        // Set lines are written only while Rhythms is active.
        setEngineActivation({ active: true, db: testRhythmsDB(schedulesDB.data, everyNight(null)) });
        await forgetHandChanges();
    });
    afterEach(async () => {
        setEngineActivation({ active: false, reason: 'flag-off' });
        settingsDB.data.features.rhythmSuggestions = false;
        await settingsDB.write();
    });
    const nightLines = () => (existsSync(changesPath()) ? readFileSync(changesPath(), 'utf8').trim().split('\n') : [])
        .map(line => JSON.parse(line));
    it('writes one night line when a rhythm power-on runs with suggestions on', async () => {
        settingsDB.data.features.rhythmSuggestions = true;
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        await flushHandChanges();
        assert.deepEqual(nightLines().map(line => [line.kind, line.side, line.date]), [
            ['night', 'left', '2026-09-28'], ['set', 'left', '2026-09-28'],
        ]);
    });
    it('writes nothing with suggestions off', async () => {
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        await flushHandChanges();
        assert.deepEqual(nightLines(), []);
    });
    it('writes nothing when the power-on is skipped', async () => {
        settingsDB.data.features.rhythmSuggestions = true;
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        await flushHandChanges();
        assert.deepEqual(nightLines(), []);
    });
    it('writes nothing when the power-on write fails', async () => {
        settingsDB.data.features.rhythmSuggestions = true;
        await settingsDB.write();
        writes.fail = true;
        const sleep = sleepOn('2026-09-28');
        setNow('2026-09-28T22:00:00Z');
        await runRhythmEvent('left', sleep, eventOf(sleep, 'power-on'));
        await flushHandChanges();
        assert.deepEqual(nightLines(), []);
    });
    it('writes what each scheduled write set: the power-on, a step and the power-off', async () => {
        settingsDB.data.features.rhythmSuggestions = true;
        await settingsDB.write();
        const sleep = sleepOn('2026-09-28');
        const expected = [];
        for (const kind of ['power-on', 'temperature', 'power-off']) {
            const event = eventOf(sleep, kind);
            setNow(event.at.toISOString());
            await runRhythmEvent('left', sleep, event);
            const reason = { 'power-on': 'on', temperature: 'step', 'power-off': 'off' }[kind];
            expected.push([reason, 'temperatureF' in event ? event.temperatureF : null]);
        }
        await flushHandChanges();
        const sets = nightLines().filter(line => line.kind === 'set');
        assert.deepEqual(sets.map(line => [line.reason, line.targetF]), expected);
    });
});
//# sourceMappingURL=runEvent.test.js.map