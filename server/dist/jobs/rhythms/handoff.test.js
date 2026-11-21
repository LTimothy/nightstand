import assert from 'node:assert/strict';
import { after, afterEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-handoff-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const updates = [];
let statusReads = 0;
let updateFails = false;
let connected = true;
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: {
        updateDeviceStatus: async (value) => {
            if (updateFails)
                throw new Error('Pod hardware is not connected');
            updates.push(value);
        },
    },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async () => { } },
});
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => ({ getDeviceStatus: async () => ({ left: { isOn: true }, right: { isOn: true } }) }),
        isFrankenConnected: () => connected,
        getDeviceStatusCoalesced: async () => {
            statusReads += 1;
            return { left: { isOn: true }, right: { isOn: true } };
        },
    },
});
const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { SCHEDULE_DAYS } = await import('../../db/scheduleKeys.js');
const { everyNight, testNight, testRhythmsDB } = await import('./testSupport.js');
const { setEngineActivation } = await import('../scheduleQueries.js');
const { disableRhythms, planHandoff, planPauseAlarmOverrides, prepareToLeaveRhythms, toReport } = await import('./handoff.js');
const { DEFAULT_SMART } = await import('../../db/rhythmsSchema.js');
const { startCurveController, stopCurveController } = await import('./curveController.js');
const { armedEnd, rearmRhythmSleep, resetOffTimes, runRhythmEvent } = await import('./runEvent.js');
const { scheduleRhythms } = await import('./scheduleRhythms.js');
const { resolveSleeps } = await import('./resolve.js');
const { nextReboot } = await import('../rebootTime.js');
const NOW = new Date('2026-09-29T06:10:00Z');
const RHYTHM = testNight('22:00', '06:30', { alarms: ['06:00'] });
const LEGACY = testNight('23:00', '07:30', { alarms: ['07:15'] });
const OFF = testNight('23:00', '07:30', { enabled: false });
const LEGACY_END = new Date('2026-09-29T07:30:00Z');
function rhythmsFor(schedules, options) {
    const left = everyNight(options.rhythm ?? RHYTHM);
    if (options.smart)
        left.rhythms['every-night'].temperatureMode = 'smart';
    if (options.offWhenUp) {
        left.rhythms['every-night'].temperatureMode = 'smart';
        left.rhythms['every-night'].smart = { ...DEFAULT_SMART, offWhenUp: true };
    }
    return testRhythmsDB(schedules, left);
}
function plan(options = {}) {
    const settings = structuredClone(settingsDB.data);
    settings.timeZone = 'UTC';
    for (const side of ['left', 'right']) {
        settings[side].awayMode = false;
        settings[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
    }
    options.configure?.(settings);
    const schedules = structuredClone(schedulesDB.data);
    for (const day of SCHEDULE_DAYS) {
        schedules.left[day] = options.legacy ?? OFF;
        schedules.right[day] = OFF;
    }
    return planHandoff({
        settings,
        schedules,
        db: rhythmsFor(schedules, options),
        now: options.now ?? NOW,
        powerOffNow: options.powerOffNow ?? false,
        isOn: () => options.on ?? true,
        powerOffFor: options.powerOffFor,
        alarmRang: (side, id) => (options.rang ?? false) && side === 'left' && id === 'rhythm:left:2026-09-28:06:00',
    });
}
after(() => rmSync(folder, { recursive: true, force: true }));
describe('planHandoff', () => {
    it('lets the weekly night take over and skips its alarm after a rhythm alarm rang', () => {
        assert.deepEqual(plan({ legacy: LEGACY, rang: true }), [
            { side: 'left', action: 'legacy-takes-over', until: LEGACY_END, alarmOverrideExpiresAt: '2026-09-29T07:30:00Z' },
            { side: 'right', action: 'none' },
        ]);
    });
    it('leaves the weekly alarm alone when no rhythm alarm rang', () => {
        assert.deepEqual(plan({ legacy: LEGACY })[0], { side: 'left', action: 'legacy-takes-over', until: LEGACY_END });
    });
    it('sets no override when the weekly night has no alarm ahead', () => {
        const early = testNight('23:00', '07:30', { alarms: ['06:05'] });
        assert.deepEqual(plan({ legacy: early, rang: true })[0], { side: 'left', action: 'legacy-takes-over', until: LEGACY_END });
    });
    it('never replaces an alarm override the user already set', () => {
        const configure = (settings) => {
            settings.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '06:45', expiresAt: '2026-09-29T07:30:00+00:00' };
        };
        assert.equal(plan({ legacy: LEGACY, rang: true, configure })[0].alarmOverrideExpiresAt, undefined);
    });
    it('keeps the side on until the rhythm ends when the weekly schedule is off now, and carries the sleep', () => {
        const { keptSleep, ...rest } = plan()[0];
        assert.deepEqual(rest, { side: 'left', action: 'kept-on-until', until: new Date('2026-09-29T06:30:00Z') });
        assert.equal(keptSleep?.date, '2026-09-28');
        assert.equal(keptSleep?.events.filter(event => event.kind === 'alarm').length, 1);
    });
    it('carries no sleep unless it keeps the side on', () => {
        assert.equal(plan({ legacy: LEGACY })[0].keptSleep, undefined);
        assert.equal(plan({ powerOffNow: true })[0].keptSleep, undefined);
    });
    it('powers the side off when asked', () => {
        assert.deepEqual(plan({ legacy: LEGACY, rang: true, powerOffNow: true })[0], { side: 'left', action: 'powered-off' });
    });
    it('does nothing for a side that is already off', () => {
        assert.deepEqual(plan({ on: false })[0], { side: 'left', action: 'none' });
    });
    it('still skips the weekly alarm after a rhythm alarm rang on an off side when alarms ring when off', () => {
        const configure = (settings) => { settings.features.alarmsWhenOff = true; };
        assert.deepEqual(plan({ legacy: LEGACY, rang: true, on: false, configure }), [
            { side: 'left', action: 'none', alarmOverrideExpiresAt: '2026-09-29T07:30:00Z' },
            { side: 'right', action: 'none' },
        ]);
        assert.deepEqual(plan({ legacy: LEGACY, on: false, configure })[0], { side: 'left', action: 'none' });
        assert.deepEqual(plan({ on: false, configure })[0], { side: 'left', action: 'none' });
        const poweringOff = plan({ legacy: LEGACY, rang: true, on: false, powerOffNow: true, configure })[0];
        assert.equal(poweringOff.alarmOverrideExpiresAt, '2026-09-29T07:30:00Z');
        assert.deepEqual(plan({ legacy: LEGACY, rang: true, on: false })[0], { side: 'left', action: 'none' });
    });
    it('does nothing outside a rhythm sleep', () => {
        assert.deepEqual(plan({ rhythm: testNight('08:00', '16:00') })[0], { side: 'left', action: 'none' });
    });
    // RHYTHM's bedtime is 22:00; as a Smart Schedule sleep it turns on at 21:30.
    const PREWARM = new Date('2026-09-28T21:45:00Z');
    it('lets the weekly night starting at bedtime take over a Smart Schedule pre-warm, so its alarm rings once', () => {
        const weekly = testNight('22:00', '06:30', { alarms: ['06:00'] });
        assert.deepEqual(plan({ smart: true, now: PREWARM, legacy: weekly })[0], { side: 'left', action: 'legacy-takes-over', until: new Date('2026-09-29T06:30:00Z') });
    });
    it('keeps a Smart Schedule pre-warm on when no weekly night starts by its bedtime', () => {
        for (const legacy of [OFF, LEGACY]) {
            const { keptSleep, ...rest } = plan({ smart: true, now: PREWARM, legacy })[0];
            assert.deepEqual(rest, { side: 'left', action: 'kept-on-until', until: new Date('2026-09-29T06:30:00Z') });
            assert.equal(keptSleep?.events.filter(event => event.kind === 'alarm').length, 1);
        }
    });
    it('hands the whole bed over from the present side in away mode', () => {
        const configure = (settings) => { settings.right.awayMode = true; };
        assert.deepEqual(plan({ legacy: LEGACY, rang: true, configure }), [
            { side: 'left', action: 'legacy-takes-over', until: LEGACY_END, alarmOverrideExpiresAt: '2026-09-29T07:30:00Z' },
            { side: 'right', action: 'legacy-takes-over', until: LEGACY_END },
        ]);
    });
    it('keeps the alarms only of the present side in away mode', () => {
        const configure = (settings) => { settings.right.awayMode = true; };
        const [left, right] = plan({ configure });
        assert.equal(left.keptSleep?.date, '2026-09-28');
        assert.equal(right.action, 'kept-on-until');
        assert.equal(right.keptSleep, undefined);
    });
    it('reports dates as ISO strings', () => {
        assert.deepEqual(toReport([
            { side: 'left', action: 'kept-on-until', until: new Date('2026-09-29T06:30:00Z') },
            { side: 'right', action: 'powered-off' },
        ]), { sides: [
                { side: 'left', action: 'kept-on-until', until: '2026-09-29T06:30:00.000Z', alarmOverrideSet: false },
                { side: 'right', action: 'powered-off', alarmOverrideSet: false },
            ] });
    });
    it('keeps a "When I get up" sleep on to its actual off and sets its timer there', () => {
        const latest = new Date('2026-09-29T09:30:00Z');
        const powerOffFor = (side, date) => (side === 'left' && date === '2026-09-28' ? latest : undefined);
        const { keptSleep, ...rest } = plan({ offWhenUp: true, now: new Date('2026-09-29T06:40:00Z'), powerOffFor })[0];
        assert.deepEqual(rest, { side: 'left', action: 'kept-on-until', until: latest, rearm: true });
        assert.equal(keptSleep?.setOff?.toISOString(), '2026-09-29T06:30:00.000Z');
    });
    it('sets the timer of a "When I get up" sleep to its set off when handed over before it', () => {
        const [left] = plan({ offWhenUp: true });
        assert.equal(left.action, 'kept-on-until');
        assert.equal(left.rearm, true);
        assert.deepEqual(left.until, new Date('2026-09-29T06:30:00Z'));
    });
});
describe('planPauseAlarmOverrides', () => {
    // Monday 10:00; the weekly night Monday 23:00 to Tuesday 07:30 rings at 07:15.
    const MONDAY = new Date('2026-09-28T10:00:00Z');
    function pausedUntil(expiresAt, night = LEGACY) {
        const settings = structuredClone(settingsDB.data);
        settings.timeZone = 'UTC';
        for (const side of ['left', 'right']) {
            settings[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            settings[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
        }
        settings.left.scheduleOverrides.pause = { active: true, expiresAt };
        const schedules = structuredClone(schedulesDB.data);
        for (const day of SCHEDULE_DAYS) {
            schedules.left[day] = night;
            schedules.right[day] = OFF;
        }
        return planPauseAlarmOverrides({ settings, schedules, now: MONDAY });
    }
    it('leaves an alarm alone that rings after the pause ends', () => {
        assert.deepEqual(pausedUntil('2026-09-28T12:00:00Z'), []);
    });
    it('skips the next weekly alarm while the pause has no end', () => {
        assert.deepEqual(pausedUntil(''), [{ side: 'left', expiresAt: '2026-09-29T07:30:00Z' }]);
    });
    it('leaves a night alone when its last alarm rings after the pause ends', () => {
        const twoAlarms = testNight('23:00', '07:30', { alarms: ['07:00', '07:20'] });
        assert.deepEqual(pausedUntil('2026-09-29T07:10:00Z', twoAlarms), []);
        assert.deepEqual(pausedUntil('2026-09-29T07:20:00Z', twoAlarms), [{ side: 'left', expiresAt: '2026-09-29T07:30:00Z' }]);
    });
    it('skips a weekly alarm due inside the pause or at its end', () => {
        assert.deepEqual(pausedUntil('2026-09-29T08:00:00Z'), [{ side: 'left', expiresAt: '2026-09-29T07:30:00Z' }]);
        assert.deepEqual(pausedUntil('2026-09-29T07:15:00Z'), [{ side: 'left', expiresAt: '2026-09-29T07:30:00Z' }]);
    });
});
describe('prepareToLeaveRhythms', () => {
    it('does nothing while Rhythms is not running', async () => {
        setEngineActivation({ active: false, reason: 'flag-off' });
        statusReads = 0;
        updates.length = 0;
        assert.deepEqual(await prepareToLeaveRhythms('rollback'), { sides: [
                { side: 'left', action: 'none', alarmOverrideSet: false },
                { side: 'right', action: 'none', alarmOverrideSet: false },
            ] });
        assert.equal(statusReads, 0);
        assert.deepEqual(updates, []);
    });
    it('hands a sleep to the weekly night without turning Rhythms off', async () => {
        settingsDB.data.timeZone = 'UTC';
        settingsDB.data.features.rhythms = true;
        for (const side of ['left', 'right']) {
            settingsDB.data[side].awayMode = false;
            settingsDB.data[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
        }
        await settingsDB.write();
        for (const day of SCHEDULE_DAYS) {
            schedulesDB.data.left[day] = LEGACY;
            schedulesDB.data.right[day] = OFF;
        }
        await schedulesDB.write();
        setEngineActivation({ active: true, db: testRhythmsDB(schedulesDB.data, everyNight(RHYTHM)) });
        updates.length = 0;
        mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
        try {
            assert.deepEqual(await prepareToLeaveRhythms('downgrade'), { sides: [
                    { side: 'left', action: 'legacy-takes-over', until: '2026-09-29T07:30:00.000Z', alarmOverrideSet: false },
                    { side: 'right', action: 'none', alarmOverrideSet: false },
                ] });
        }
        finally {
            mock.timers.reset();
            setEngineActivation({ active: false, reason: 'flag-off' });
        }
        assert.deepEqual(updates, [{ left: { secondsRemaining: 80 * 60 + 300 } }]);
        await settingsDB.read();
        assert.equal(settingsDB.data.features.rhythms, true);
    });
    it('does not wait for a Pod that is not connected, and says which side it could not change', async () => {
        setEngineActivation({ active: true, db: testRhythmsDB(schedulesDB.data, everyNight(RHYTHM)) });
        statusReads = 0;
        updates.length = 0;
        connected = false;
        updateFails = true;
        mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
        try {
            assert.deepEqual(await prepareToLeaveRhythms('rollback'), { sides: [
                    { side: 'left', action: 'legacy-takes-over', until: '2026-09-29T07:30:00.000Z', alarmOverrideSet: false, deviceUpdateFailed: true },
                    { side: 'right', action: 'none', alarmOverrideSet: false },
                ] });
        }
        finally {
            mock.timers.reset();
            connected = true;
            updateFails = false;
            setEngineActivation({ active: false, reason: 'flag-off' });
        }
        assert.equal(statusReads, 0, 'read the Pod while it was not connected');
    });
    it('skips the weekly alarm of a paused side, because older versions ignore a pause', async () => {
        settingsDB.data.timeZone = 'UTC';
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
        await settingsDB.write();
        for (const day of SCHEDULE_DAYS) {
            schedulesDB.data.left[day] = LEGACY;
            schedulesDB.data.right[day] = OFF;
        }
        await schedulesDB.write();
        setEngineActivation({ active: false, reason: 'flag-off' });
        updates.length = 0;
        mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
        try {
            assert.deepEqual(await prepareToLeaveRhythms('rollback'), { sides: [
                    { side: 'left', action: 'none', alarmOverrideSet: true },
                    { side: 'right', action: 'none', alarmOverrideSet: false },
                ] });
        }
        finally {
            mock.timers.reset();
        }
        await settingsDB.read();
        assert.deepEqual(settingsDB.data.left.scheduleOverrides.alarm, { disabled: true, timeOverride: '', expiresAt: '2026-09-29T07:30:00Z' });
        assert.deepEqual(updates, []);
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
        await settingsDB.write();
    });
    // Runs when Rhythms is turned off, or before leaving for a version without the prepare-to-stop route.
    it('hands over a sleep kept on past its set off with its timer at the latest off', async () => {
        settingsDB.data.timeZone = 'UTC';
        settingsDB.data.features.rhythms = true;
        // A 10:30 prime restarts at 09:30, so the latest off is 09:00.
        const prime = settingsDB.data.primePodDaily;
        settingsDB.data.primePodDaily = { enabled: true, time: '10:30' };
        settingsDB.data.rebootDaily = true;
        for (const side of ['left', 'right']) {
            settingsDB.data[side].awayMode = false;
            settingsDB.data[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
        }
        await settingsDB.write();
        for (const day of SCHEDULE_DAYS) {
            schedulesDB.data.left[day] = OFF;
            schedulesDB.data.right[day] = OFF;
        }
        await schedulesDB.write();
        const left = everyNight(RHYTHM);
        left.rhythms['every-night'].temperatureMode = 'smart';
        left.rhythms['every-night'].smart = { ...DEFAULT_SMART, offWhenUp: true };
        const db = testRhythmsDB(schedulesDB.data, left);
        setEngineActivation({ active: true, db });
        const setOff = new Date('2026-09-29T06:30:00Z');
        const inBed = { present: true, lastUpdatedAt: setOff.toISOString(), stateChangedAt: setOff.toISOString() };
        const controller = startCurveController({
            now: () => setOff,
            presence: () => ({ left: inBed, right: { present: false } }),
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
        updates.length = 0;
        mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-29T06:40:00Z') });
        try {
            const [sleep] = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: new Date('2026-09-29T06:00:00Z'), to: setOff });
            assert.equal(controller.decideOff('left', sleep, setOff), 'keep');
            assert.deepEqual((await prepareToLeaveRhythms('rollback')).sides[0], {
                side: 'left', action: 'kept-on-until', until: '2026-09-29T09:00:00.000Z', alarmOverrideSet: false,
            });
        }
        finally {
            mock.timers.reset();
            stopCurveController();
            setEngineActivation({ active: false, reason: 'flag-off' });
            settingsDB.data.primePodDaily = prime;
        }
        assert.deepEqual(updates, [{ left: { secondsRemaining: (2 * 3600 + 20 * 60) + 300 } }]);
    });
});
describe('after handing sleeps back', () => {
    const WEEKLY = testNight('22:00', '07:30', { alarms: ['07:15'] });
    const setNow = (iso) => mock.timers.setTime(Date.parse(iso));
    async function engineWith(rhythm) {
        settingsDB.data.timeZone = 'UTC';
        settingsDB.data.features.rhythms = true;
        for (const side of ['left', 'right']) {
            settingsDB.data[side].awayMode = false;
            settingsDB.data[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
        }
        await settingsDB.write();
        for (const day of SCHEDULE_DAYS) {
            schedulesDB.data.left[day] = WEEKLY;
            schedulesDB.data.right[day] = OFF;
        }
        await schedulesDB.write();
        const db = testRhythmsDB(schedulesDB.data, everyNight(rhythm));
        setEngineActivation({ active: true, db });
        const [sleep] = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: new Date(), to: new Date() });
        return { db, sleep };
    }
    afterEach(() => {
        Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
        setEngineActivation({ active: false, reason: 'flag-off' });
        resetOffTimes();
        mock.timers.reset();
        updates.length = 0;
    });
    it('a plan that runs before the server stops does not send the rhythm end back over the handoff', async () => {
        mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-29T02:59:00Z') });
        const { db, sleep } = await engineWith(testNight('22:00', '06:00'));
        await rearmRhythmSleep('left', sleep);
        updates.length = 0;
        setNow('2026-09-29T02:59:59Z');
        await prepareToLeaveRhythms('rollback');
        assert.deepEqual(updates, [{ left: { secondsRemaining: 16501 } }]);
        setNow('2026-09-29T03:00:00Z');
        scheduleRhythms(settingsDB.data, db, new Date());
        await schedule.scheduledJobs['rhythm-left-2026-09-28-rearm']?.invoke();
        assert.deepEqual(updates, [{ left: { secondsRemaining: 16501 } }], 'the rhythm end was sent back over the handoff');
        // A server that is still running some minutes later did not stop, so its own sleep gets its end back.
        setNow('2026-09-29T03:15:00Z');
        scheduleRhythms(settingsDB.data, db, new Date());
        await schedule.scheduledJobs['rhythm-left-2026-09-28-rearm'].invoke();
        assert.deepEqual(updates.at(-1), { left: { secondsRemaining: 2 * 3600 + 45 * 60 + 300 } });
    });
    it('a rhythm power-off due before the server stops leaves the side to the weekly night', async () => {
        mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-29T02:59:59Z') });
        const { sleep } = await engineWith(testNight('22:00', '03:00'));
        await prepareToLeaveRhythms('rollback');
        assert.deepEqual(updates, [{ left: { secondsRemaining: 16501 } }]);
        setNow('2026-09-29T03:00:00Z');
        const powerOff = sleep.events.find(event => event.kind === 'power-off');
        assert.ok(powerOff);
        await runRhythmEvent('left', sleep, powerOff);
        assert.deepEqual(updates, [{ left: { secondsRemaining: 16501 } }], 'the side was turned off over the handoff');
    });
    it('turning Rhythms off forgets the rhythm end it replaced, so turning it back on sends it again', async () => {
        mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-29T02:59:00Z') });
        const { sleep } = await engineWith(testNight('22:00', '06:00'));
        await rearmRhythmSleep('left', sleep);
        assert.equal(armedEnd('left'), sleep.end.getTime());
        const report = await disableRhythms({ powerOffNow: false }, async () => { });
        assert.equal(report.sides[0].action, 'legacy-takes-over');
        assert.equal(armedEnd('left'), undefined);
    });
});
//# sourceMappingURL=handoff.test.js.map