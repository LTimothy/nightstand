import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-pause-schedule-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const updates = [];
const options = [];
const alarms = [];
const errors = [];
let fail = false;
let onRead;
let onUpdate;
const status = { left: { isOn: false }, right: { isOn: false } };
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async (value, opts) => {
            if (fail)
                throw new Error('power write failed');
            updates.push(value);
            options.push(opts);
            await onUpdate?.();
            for (const side of ['left', 'right']) {
                const isOn = value[side]?.isOn;
                if (isOn !== undefined)
                    status[side].isOn = isOn;
            }
        } },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        FrankenCommandTimeoutError: class extends Error {
        },
        connectFrankenWithin: async () => ({
            getDeviceStatus: async () => { await onRead?.(); return status; },
        }),
        getDeviceStatusCoalesced: async () => { await onRead?.(); return status; },
        isFrankenConnected: () => true,
    },
});
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: {
        frankenCommands: { LEFT_TEMP_DURATION: '9', RIGHT_TEMP_DURATION: '10' },
        executeFunction: async (...args) => { alarms.push(args); },
    },
});
const { default: settingsDB } = await import('../db/settings.js');
const { default: schedulesDB } = await import('../db/schedules.js');
const { default: logger } = await import('../logger.js');
const powerJobs = await import('./powerScheduler.js');
const weeklyCalls = [];
mock.module(new URL('./powerScheduler.js', import.meta.url).href, {
    namedExports: { ...powerJobs, weeklyPowerOnJob: (...args) => async (at) => {
            weeklyCalls.push([...args, at]);
            return powerJobs.weeklyPowerOnJob(...args)(at);
        } },
});
const rhythmJobs = await import('./rhythms/runEvent.js');
const rhythmCalls = [];
mock.module(new URL('./rhythms/runEvent.js', import.meta.url).href, {
    namedExports: { ...rhythmJobs, runRhythmEvent: async (...args) => {
            rhythmCalls.push(args);
            return rhythmJobs.runRhythmEvent(...args);
        } },
});
const resumeJobs = await import('./resumeSchedule.js');
const { resumeSchedule } = resumeJobs;
const resumeCalls = [];
mock.module(new URL('./resumeSchedule.js', import.meta.url).href, {
    namedExports: { ...resumeJobs, resumeSchedule: async (...args) => {
            resumeCalls.push(args);
            return resumeSchedule(...args);
        } },
});
const { disableRhythms } = await import('./rhythms/handoff.js');
const { lastManualPowerChange, noteManualPowerChange } = await import('./manualPowerChange.js');
const { default: deviceRouter } = await import('../routes/deviceStatus/deviceStatus.js');
const { default: executeRouter } = await import('../routes/execute/execute.js');
const { scheduleAlarm, resetAlarmOccurrences } = await import('./alarmScheduler.js');
const { resetAlarmActivity } = await import('./alarmActivity.js');
const { scheduleTemperatures } = await import('./temperatureScheduler.js');
const { scheduleRhythms } = await import('./rhythms/scheduleRhythms.js');
const { clearEndedPause } = await import('./pauseResume.js');
const { setEngineActivation } = await import('./scheduleQueries.js');
const { resetOffTimes, armedEnd, runRhythmEvent } = await import('./rhythms/runEvent.js');
const { everyNight, testNight, testRhythmsDB } = await import('./rhythms/testSupport.js');
const { DEFAULT_SMART } = await import('../db/rhythmsSchema.js');
const { default: router } = await import('../routes/settings/settings.js');
const { startCurveController, stopCurveController, smartPowerOffFor } = await import('./rhythms/curveController.js');
const { resolveSleeps } = await import('./rhythms/resolve.js');
const { smartResolveHooks } = await import('./rhythms/curveController.js');
const { smartOffRuntime } = await import('./rhythms/smartOffRuntime.js');
const { isSchedulePaused } = await import('./schedulePause.js');
const expiry = '2026-10-04T22:00:00Z';
const now = Date.parse('2026-10-04T22:01:00Z');
beforeEach(async () => {
    mock.timers.enable({ apis: ['Date'], now });
    mock.method(logger, 'error', (error) => { errors.push(error); });
    updates.length = options.length = alarms.length = errors.length = 0;
    weeklyCalls.length = rhythmCalls.length = 0;
    resumeCalls.length = 0;
    noteManualPowerChange('left', new Date(0));
    noteManualPowerChange('right', new Date(0));
    fail = false;
    onRead = undefined;
    onUpdate = undefined;
    powerJobs.resetPowerOnTimes();
    resetAlarmOccurrences();
    resetAlarmActivity();
    status.left.isOn = status.right.isOn = false;
    resetOffTimes();
    settingsDB.data.timeZone = 'UTC';
    settingsDB.data.features.rhythms = false;
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].scheduleOverrides = {
            pause: { active: side === 'left', expiresAt: side === 'left' ? expiry : '' },
            temperatureSchedules: { disabled: false, expiresAt: '' },
            alarm: { disabled: false, expiresAt: '', timeOverride: '' },
        };
        for (const day of Object.keys(schedulesDB.data[side])) {
            schedulesDB.data[side][day] = testNight('20:00', '07:00', {
                temperatures: { '21:00': 74, '23:00': 70 }, alarms: ['21:30'],
            });
        }
    }
    await settingsDB.write();
    await schedulesDB.write();
    setEngineActivation({ active: false, reason: 'flag-off' });
});
afterEach(() => {
    Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
    stopCurveController();
    mock.restoreAll();
    mock.timers.reset();
});
after(() => rmSync(folder, { recursive: true, force: true }));
async function rhythms(smart = false) {
    settingsDB.data.features.rhythms = true;
    await settingsDB.write();
    const db = testRhythmsDB(schedulesDB.data, everyNight(schedulesDB.data.left.sunday));
    if (smart) {
        for (const rhythm of Object.values(db.left.rhythms)) {
            rhythm.temperatureMode = 'smart';
            rhythm.wake = '06:45';
            rhythm.smart = { ...DEFAULT_SMART, baseLevel: 0, offWhenUp: true };
        }
    }
    setEngineActivation({ active: true, db });
    return db;
}
it('resumes the weekly night with its power-on temperature and firmware end', async () => {
    assert.equal(await clearEndedPause('left', expiry), true);
    assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
    assert.equal(options[0].onUntil.toISOString(), '2026-10-05T07:05:00.000Z');
    assert.deepEqual(alarms, []);
});
it('resumes a Rhythms night with its power-on temperature and remaining firmware seconds', async () => {
    await rhythms();
    await clearEndedPause('left', expiry);
    assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
    assert.equal(armedEnd('left'), Date.parse('2026-10-05T07:00:00Z'));
    assert.deepEqual(alarms, []);
});
for (const engine of ['weekly', 'rhythms']) {
    for (const [label, time] of [
        ['before the night', '2026-10-04T19:00:00Z'], ['at the off time', '2026-10-05T07:00:00Z'],
        ['after the night', '2026-10-05T08:00:00Z'],
    ]) {
        it(`${engine}: does nothing ${label}`, async () => {
            if (engine === 'rhythms')
                await rhythms();
            mock.timers.setTime(Date.parse(time));
            await clearEndedPause('left', expiry);
            assert.deepEqual(updates, []);
        });
    }
    it(`${engine}: leaves an already on side alone`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        status.left.isOn = true;
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: leaves an away side off`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        settingsDB.data.left.awayMode = true;
        await settingsDB.write();
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: keeps a newer pause and does not turn on`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-10-05T10:00:00Z' };
        await settingsDB.write();
        assert.equal(await clearEndedPause('left', expiry), false);
        assert.equal(settingsDB.data.left.scheduleOverrides.pause.active, true);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: respects a manual temperature hold set during the status read`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        onRead = async () => {
            settingsDB.data.left.scheduleOverrides.temperatureSchedules = {
                disabled: true, expiresAt: '2026-10-05T06:00:00Z',
            };
            await settingsDB.write();
        };
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, [{ left: {
                    isOn: true,
                } }]);
    });
    it(`${engine}: logs a failed power-on without rejecting`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        fail = true;
        assert.equal(await clearEndedPause('left', expiry), true);
        assert.match(errors.map(String).join('\n'), /power write failed/);
    });
    it(`${engine}: rechecks a new pause saved during the status read`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        onRead = async () => {
            settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
            await settingsDB.write();
        };
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: does not turn on if the status read passes the off time`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        onRead = async () => { mock.timers.setTime(Date.parse('2026-10-05T07:00:00Z')); };
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: changes an active pause end without resuming or writing the device`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-10-04T23:30:00Z' };
        await settingsDB.write();
        const handler = router.stack.filter(layer => layer.route?.path === '/settings')[1]?.route?.stack[0].handle;
        assert.ok(handler);
        const writes = mock.method(settingsDB.adapter, 'write');
        let code = 0;
        const res = { status(value) { code = value; return this; }, json() { } };
        const pause = { active: true, expiresAt: '2026-10-04T23:10:00Z' };
        await handler({ body: { left: { scheduleOverrides: { pause } } } }, res, () => { });
        assert.equal(code, 200);
        assert.equal(writes.mock.callCount(), 1);
        await settingsDB.read();
        assert.deepEqual(settingsDB.data.left.scheduleOverrides.pause, pause);
        assert.deepEqual(resumeCalls, []);
        assert.deepEqual(weeklyCalls, []);
        assert.deepEqual(rhythmCalls, []);
        assert.deepEqual(updates, []);
        assert.deepEqual(alarms, []);
    });
    it(`${engine}: resumes early through the settings route`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
        await settingsDB.write();
        const handler = router.stack.filter(layer => layer.route?.path === '/settings')[1]?.route?.stack[0].handle;
        assert.ok(handler);
        let code = 0;
        const res = { status(value) { code = value; return this; }, json() { } };
        await handler({ body: { left: { scheduleOverrides: { pause: { active: false, expiresAt: '' } } } } }, res, () => { });
        assert.equal(code, 200);
        // The route answers before the resume finishes.
        for (let spin = 0; spin < 400 && updates.length < 1; spin++)
            await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(updates.length, 1);
        assert.equal(resumeCalls.length, 1);
        assert.equal(resumeCalls[0][0], 'left');
        assert.equal(engine === 'rhythms' ? rhythmCalls.length : weeklyCalls.length, 1);
        assert.deepEqual(alarms, []);
    });
}
it('resumes the Smart Schedule curve and retains When I get up handling', async () => {
    const db = await rhythms(true);
    const controller = startCurveController({
        now: () => new Date(),
        presence: () => ({ left: { present: true, lastUpdatedAt: new Date().toISOString() }, right: { present: false } }),
        awayMode: () => ({ left: false, right: true }),
        isPaused: (side, at) => isSchedulePaused(settingsDB.data, side, at),
        sleeps: (side, from, to) => resolveSleeps({ db, side, from, to, timeZone: 'UTC', ...smartResolveHooks }),
        applyLevel: async () => { }, retime: () => { }, recordHistory: async () => { },
        smartOff: smartOffRuntime(),
    });
    await clearEndedPause('left', expiry);
    assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 88 } }]);
    await controller.tick();
    assert.ok(controller.status('left', new Date()));
    assert.equal(smartPowerOffFor('left', '2026-10-04'), undefined);
    status.left.isOn = true;
    mock.timers.setTime(Date.parse('2026-10-05T07:00:00Z'));
    const sleep = resolveSleeps({ db, side: 'left', from: new Date(), to: new Date(), timeZone: 'UTC' })[0];
    await runRhythmEvent('left', sleep, { kind: 'power-off', at: new Date() });
    assert.ok(smartPowerOffFor('left', '2026-10-04'));
    assert.equal(updates.length, 1, 'the normal off keeps a resumed sleep on for someone in bed');
    status.left.isOn = false;
    settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: expiry };
    await settingsDB.write();
    await clearEndedPause('left', expiry);
    assert.equal(updates.length, 1, 'a later resume must not turn on past the set off');
});
it('respects a Smart Schedule manual hold set during the status read', async () => {
    const db = await rhythms(true);
    const controller = startCurveController({
        now: () => new Date(),
        presence: () => ({ left: { present: true }, right: { present: false } }),
        awayMode: () => ({ left: false, right: true }),
        isPaused: (side, at) => isSchedulePaused(settingsDB.data, side, at),
        sleeps: (side, from, to) => resolveSleeps({ db, side, from, to, timeZone: 'UTC', ...smartResolveHooks }),
        applyLevel: async () => { }, retime: () => { }, recordHistory: async () => { },
        smartOff: smartOffRuntime(),
    });
    onRead = async () => { assert.equal(controller.noteManualChange('left', new Date()), 'held'); };
    await clearEndedPause('left', expiry);
    assert.deepEqual(updates, [{ left: { isOn: true } }]);
});
it('resumes both sides when their pauses end together', async () => {
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: expiry };
    await settingsDB.write();
    assert.deepEqual(await Promise.all([clearEndedPause('left', expiry), clearEndedPause('right', expiry)]), [true, true]);
    assert.deepEqual(updates, [
        { left: { isOn: true, targetTemperatureF: 80 } }, { right: { isOn: true, targetTemperatureF: 80 } },
    ]);
});
it('leaves the side off and logs when its status cannot be read', async () => {
    onRead = async () => { throw new Error('status unavailable'); };
    assert.equal(await clearEndedPause('left', expiry), true);
    assert.deepEqual(updates, []);
    assert.match(errors.map(String).join(' '), /status unavailable/);
});
for (const engine of ['weekly', 'rhythms']) {
    it(`${engine}: resumes after midnight using the previous day's night`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        mock.timers.setTime(Date.parse('2026-10-05T01:01:00Z'));
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, [{ left: {
                    isOn: true, targetTemperatureF: 80,
                } }]);
    });
    it(`${engine}: uses the configured timezone across the repeated autumn hour`, async () => {
        settingsDB.data.timeZone = 'America/Los_Angeles';
        await settingsDB.write();
        schedulesDB.data.left.sunday = testNight('00:30', '02:30', { temperatures: { '01:15': 74 } });
        await schedulesDB.write();
        if (engine === 'rhythms')
            await rhythms();
        mock.timers.setTime(Date.parse('2026-11-01T09:30:00Z'));
        await clearEndedPause('left', expiry);
        assert.deepEqual(errors.map(String), []);
        assert.deepEqual(updates, [{ left: {
                    isOn: true, targetTemperatureF: 80,
                } }]);
        if (engine === 'weekly')
            assert.equal(options[0].onUntil.toISOString(), '2026-11-01T10:35:00.000Z');
    });
}
it('weekly resume calls the scheduled power-on function with the normal job inputs', async () => {
    await clearEndedPause('left', expiry);
    assert.equal(weeklyCalls.length, 1);
    assert.deepEqual(weeklyCalls[0], ['left', 'sunday', schedulesDB.data.left.sunday.power, 'UTC', new Date()]);
    assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
    const resumedOptions = options[0];
    powerJobs.resetPowerOnTimes();
    updates.length = options.length = 0;
    powerJobs.schedulePowerOn(settingsDB.data, 'left', 'sunday', schedulesDB.data.left.sunday.power);
    const job = schedule.scheduledJobs['left-sunday-20:00-power-on'];
    await job.invoke(new Date());
    assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
    assert.deepEqual(options, [resumedOptions]);
});
it('Rhythms resume calls the same power-on function and event as the scheduler', async () => {
    const db = await rhythms();
    mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
    scheduleRhythms(settingsDB.data, db, new Date());
    mock.timers.setTime(now);
    await clearEndedPause('left', expiry);
    assert.equal(rhythmCalls.length, 1);
    assert.equal(rhythmCalls[0].length, 3);
    const [side, sleep, event] = rhythmCalls[0];
    assert.equal(side, 'left');
    assert.equal(sleep.date, '2026-10-04');
    assert.deepEqual(event, { kind: 'power-on', at: new Date(), temperatureF: 80 });
    const job = schedule.scheduledJobs['rhythm-left-2026-10-04-power-on-2000-0'];
    assert.ok(job);
    powerJobs.resetPowerOnTimes();
    await job.invoke();
    assert.equal(rhythmCalls.length, 2);
    assert.deepEqual(rhythmCalls[1], [side, sleep, { ...event, at: new Date('2026-10-04T20:00:00Z') }]);
    assert.deepEqual(updates, [
        { left: { isOn: true, targetTemperatureF: 80 } },
        { left: { isOn: true, targetTemperatureF: 80 } },
    ]);
    const onUntil = new Date('2026-10-05T07:05:00Z');
    assert.deepEqual(options, [{ background: true, onUntil }, { background: true, onUntil }]);
});
function captureFollowUps() {
    const checks = [];
    const original = globalThis.setTimeout;
    mock.method(globalThis, 'setTimeout', (callback, delay) => {
        if (delay !== 180_000)
            return original(callback, delay);
        checks.push(callback);
        return { unref() { } };
    });
    return checks;
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
for (const engine of ['weekly', 'rhythms']) {
    const powerName = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
    for (const seconds of [0, 120, 121]) {
        it(`${engine}: checks the 120 second scheduled start window at ${seconds} seconds`, async () => {
            if (engine === 'rhythms')
                await rhythms();
            const messages = [];
            mock.method(logger, 'info', (message) => { messages.push(message); });
            const job = schedule.scheduleJob(powerName, new Date(now + Math.max(seconds, 1) * 1000), () => { });
            assert.ok(job);
            if (seconds === 0)
                mock.method(job, 'nextInvocation', () => new Date(now));
            await clearEndedPause('left', expiry);
            assert.equal(updates.length, seconds <= 120 ? 0 : 1);
            assert.equal(messages.filter(message => String(message).includes('checking the left side after its scheduled start')).length, seconds <= 120 ? 1 : 0);
        });
    }
    it(`${engine}: yields to a running start even with no imminent next invocation`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        const job = schedule.scheduleJob(powerName, new Date(now + 7 * 86400_000), () => { });
        assert.ok(job);
        Object.assign(job, { running: 1 });
        await clearEndedPause('left', expiry);
        assert.deepEqual(updates, []);
    });
    it(`${engine}: resumes well after the start with no pending power-on`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        mock.timers.setTime(Date.parse('2026-10-05T03:00:00Z'));
        await clearEndedPause('left', expiry);
        assert.equal(updates.length, 1);
        assert.equal(status.left.isOn, true);
    });
    for (const timing of ['during the settings read', 'during the status read']) {
        it(`${engine}: rechecks scheduled starts ${timing}`, async () => {
            if (engine === 'rhythms')
                await rhythms();
            settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
            await settingsDB.write();
            mock.method(settingsDB, 'read', async () => { });
            mock.method(schedulesDB, 'read', async () => { });
            const addStart = () => {
                assert.ok(schedule.scheduleJob(powerName, new Date(now + 1000), () => { }));
            };
            if (timing === 'during the status read') {
                onRead = async () => { addStart(); };
                await resumeSchedule('left');
            }
            else {
                mock.method(settingsDB, 'read', async () => { addStart(); });
                await resumeSchedule('left');
            }
            assert.deepEqual(updates, []);
        });
    }
    it(`${engine}: ignores pending starts for another side, night or engine`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        const names = engine === 'weekly'
            ? ['right-sunday-20:00-power-on', 'left-monday-20:00-power-on', 'left-sunday-21:00-power-on',
                'rhythm-left-2026-10-04-power-on-2000-0']
            : ['rhythm-right-2026-10-04-power-on-2000-0', 'rhythm-left-2026-10-05-power-on-2000-0',
                'left-sunday-20:00-power-on'];
        for (const name of names)
            assert.ok(schedule.scheduleJob(name, new Date(now + 1000), () => { }));
        await clearEndedPause('left', expiry);
        assert.equal(updates.length, 1);
    });
}
it('Rhythms resume yields to a late Smart Schedule pre-warm', async () => {
    const db = await rhythms(true);
    const sleep = resolveSleeps({ db, side: 'left', from: new Date(), to: new Date(), timeZone: 'UTC' })[0];
    mock.timers.setTime(sleep.start.getTime() + 1000);
    settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
    await settingsDB.write();
    scheduleRhythms(settingsDB.data, db, new Date());
    assert.ok(schedule.scheduledJobs['rhythm-left-2026-10-04-power-on-late']);
    await resumeSchedule('left');
    assert.deepEqual(updates, []);
});
for (const engine of ['weekly', 'rhythms']) {
    for (const first of ['scheduled', 'resume']) {
        it(`${engine}: ${first} first shares one power-on with resume and preserves the same-minute temperature`, async () => {
            mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
            settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
            schedulesDB.data.left.sunday = testNight('20:00', '07:00', { temperatures: { '20:00': 74 } });
            await settingsDB.write();
            await schedulesDB.write();
            if (engine === 'rhythms') {
                const db = await rhythms();
                scheduleRhythms(settingsDB.data, db, new Date());
            }
            else {
                const night = schedulesDB.data.left.sunday;
                powerJobs.schedulePowerOn(settingsDB.data, 'left', 'sunday', night.power);
                scheduleTemperatures(settingsDB.data, 'left', 'sunday', night.temperatures, night.power);
            }
            mock.timers.setTime(Date.parse('2026-10-04T20:00:00Z'));
            mock.method(settingsDB, 'read', async () => { });
            mock.method(schedulesDB, 'read', async () => { });
            const powerName = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
            const temperatureName = engine === 'weekly'
                ? 'left-sunday-20:00-74-temperature-adjustment' : 'rhythm-left-2026-10-04-temperature-2000-0';
            const power = schedule.scheduledJobs[powerName];
            const temperature = schedule.scheduledJobs[temperatureName];
            assert.ok(power);
            assert.ok(temperature);
            const entered = deferred();
            const release = deferred();
            let powerOnFinished = false;
            if (first === 'scheduled') {
                onRead = async () => { assert.equal(powerOnFinished, true, 'resume reads status after the scheduled start'); };
            }
            onUpdate = async () => {
                onUpdate = undefined;
                entered.resolve();
                await release.promise;
                powerOnFinished = true;
            };
            const checks = captureFollowUps();
            const scheduled = () => power.invoke(new Date());
            const resume = () => resumeSchedule('left');
            if (first === 'resume') {
                onUpdate = undefined;
                await resume();
                assert.deepEqual(updates, [], 'resume yields to the pending scheduled start');
                onUpdate = async () => { onUpdate = undefined; entered.resolve(); await release.promise; };
            }
            const firstRun = scheduled();
            await entered.promise;
            if (first === 'scheduled') {
                Object.assign(power, { running: 1 });
                if (engine === 'weekly') {
                    mock.method(schedule.scheduledJobs[powerName], 'nextInvocation', () => new Date(now + 7 * 86400_000));
                }
                else {
                    schedule.scheduledJobs[powerName].emit('run');
                    schedule.cancelJob(powerName);
                }
            }
            const secondRun = first === 'scheduled' ? resume() : Promise.resolve();
            try {
                await new Promise(resolve => setImmediate(resolve));
                await temperature.invoke(new Date());
            }
            finally {
                release.resolve();
            }
            await Promise.all([firstRun, secondRun]);
            power.emit('success');
            assert.equal(checks.length, 1);
            mock.timers.setTime(Date.parse('2026-10-04T20:03:00Z'));
            await checks[0]();
            const writes = updates;
            assert.equal(writes.filter(write => write.left.isOn).length, 1);
            assert.equal(writes.at(-1)?.left.targetTemperatureF, 74);
            assert.deepEqual(errors, []);
        });
    }
}
for (const engine of ['weekly', 'rhythms']) {
    it(`${engine}: a skipped or failed scheduled start does not prevent resume`, async () => {
        const db = engine === 'rhythms' ? await rhythms() : undefined;
        const start = new Date('2026-10-04T20:00:00Z');
        mock.timers.setTime(start.getTime());
        const scheduled = () => {
            if (!db)
                return powerJobs.weeklyPowerOnJob('left', 'sunday', schedulesDB.data.left.sunday.power, 'UTC')(start);
            const sleep = resolveSleeps({ db, side: 'left', from: start, to: start, timeZone: 'UTC' })[0];
            const event = sleep.events.find(candidate => candidate.kind === 'power-on');
            assert.ok(event);
            return runRhythmEvent('left', sleep, event);
        };
        await scheduled();
        assert.deepEqual(updates, []);
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        await settingsDB.write();
        fail = true;
        await scheduled();
        assert.deepEqual(updates, []);
        fail = false;
        await resumeSchedule('left');
        assert.equal(updates.length, 1);
        await resumeSchedule('left');
        assert.equal(updates.length, 1, 'an on side needs no resume');
        mock.timers.setTime(Date.parse('2026-10-05T01:00:00Z'));
        await resumeSchedule('left');
        assert.equal(updates.length, 1, 'the same night spans midnight');
        mock.timers.setTime(Date.parse('2026-10-05T20:00:00Z'));
        status.left.isOn = false;
        await resumeSchedule('left');
        assert.equal(updates.length, 2, 'a new night can start');
    });
    it(`${engine}: a failed resume status read releases the side`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        await settingsDB.write();
        onRead = async () => { throw new Error('status unavailable'); };
        await resumeSchedule('left');
        onRead = undefined;
        await resumeSchedule('left');
        assert.equal(updates.length, 1);
        assert.match(errors.map(String).join(' '), /status unavailable/);
    });
}
it('a waiting left resume does not block the right side', async () => {
    settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
    await settingsDB.write();
    const entered = deferred();
    const release = deferred();
    onRead = async () => {
        onRead = undefined;
        entered.resolve();
        await release.promise;
    };
    const left = resumeSchedule('left');
    await entered.promise;
    try {
        await resumeSchedule('right');
        assert.deepEqual(updates, [{ right: { isOn: true, targetTemperatureF: 80 } }]);
    }
    finally {
        release.resolve();
        await left;
    }
    assert.equal(updates.length, 2);
});
for (const engine of ['weekly', 'rhythms']) {
    for (const later of ['schedule edit', 'pause end', 'pause end after midnight', 'second pause end']) {
        it(`${engine}: powers on again after a manual off and ${later}`, async () => {
            mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
            settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
            await settingsDB.write();
            const arm = async () => {
                if (engine === 'rhythms') {
                    const db = await rhythms();
                    scheduleRhythms(settingsDB.data, db, new Date());
                }
                else {
                    powerJobs.schedulePowerOn(settingsDB.data, 'left', 'sunday', schedulesDB.data.left.sunday.power);
                }
            };
            const invokePower = async (time) => {
                const name = engine === 'weekly' ? `left-sunday-${time}-power-on`
                    : `rhythm-left-2026-10-04-power-on-${time.replace(':', '')}-0`;
                const job = schedule.scheduledJobs[name];
                assert.ok(job);
                await job.invoke(new Date());
            };
            await arm();
            mock.timers.setTime(Date.parse('2026-10-04T20:00:00Z'));
            if (later === 'second pause end') {
                settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-10-04T19:59:00Z' };
                await settingsDB.write();
                await clearEndedPause('left', '2026-10-04T19:59:00Z');
                assert.deepEqual(updates, [], 'the scheduled start owns this minute');
                await invokePower('20:00');
            }
            else {
                await invokePower('20:00');
            }
            assert.equal(updates.length, 1);
            status.left.isOn = false;
            if (later === 'schedule edit') {
                schedulesDB.data.left.sunday.power.on = '22:00';
                await schedulesDB.write();
                await arm();
                mock.timers.setTime(Date.parse('2026-10-04T22:00:00Z'));
                await invokePower('22:00');
            }
            else {
                settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: expiry };
                await settingsDB.write();
                mock.timers.setTime(later === 'pause end after midnight' ? Date.parse('2026-10-05T01:00:00Z') : now);
                await clearEndedPause('left', expiry);
            }
            const writes = updates;
            assert.equal(writes.filter(write => write.left.isOn).length, 2);
            assert.equal(writes[1].left.targetTemperatureF, 80);
            assert.deepEqual(errors, []);
        });
    }
}
for (const engine of ['weekly', 'rhythms']) {
    it(`${engine}: temperature, alarm and power-off jobs remain independent`, async () => {
        mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        settingsDB.data.left.alarmsEnabled = true;
        schedulesDB.data.left.sunday = testNight('20:00', '07:00', { temperatures: { '21:00': 74 }, alarms: ['21:30'] });
        await settingsDB.write();
        await schedulesDB.write();
        if (engine === 'rhythms') {
            const db = await rhythms();
            scheduleRhythms(settingsDB.data, db, new Date());
        }
        else {
            const night = schedulesDB.data.left.sunday;
            scheduleTemperatures(settingsDB.data, 'left', 'sunday', night.temperatures, night.power);
            scheduleAlarm(settingsDB.data, 'left', 'sunday', night);
            powerJobs.schedulePowerOff(settingsDB.data, 'left', 'sunday', night.power);
        }
        mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
        status.left.isOn = true;
        const invoke = async (weeklyName, rhythmName, time) => {
            mock.timers.setTime(Date.parse(time));
            const job = schedule.scheduledJobs[engine === 'weekly' ? weeklyName : rhythmName];
            assert.ok(job);
            await job.invoke(new Date());
        };
        try {
            await invoke('left-sunday-21:00-74-temperature-adjustment', 'rhythm-left-2026-10-04-temperature-2100-0', '2026-10-04T21:00:00Z');
            assert.deepEqual(updates, [{ left: { targetTemperatureF: 74 } }]);
            await invoke('left-sunday-21:30-0-alarm', 'rhythm-left-2026-10-04-alarm-2130-0', '2026-10-04T21:30:00Z');
            assert.equal(alarms.length, 1);
            resetAlarmActivity();
            await invoke('left-sunday-07:00-power-off', 'rhythm-left-2026-10-04-power-off-0700-0', '2026-10-05T07:00:00Z');
            assert.deepEqual(updates.at(-1), { left: { isOn: false } });
        }
        finally {
            resetAlarmActivity();
        }
    });
}
for (const engine of ['weekly', 'rhythms']) {
    for (const outcome of ['fails', 'is cancelled by a rebuild']) {
        it(`${engine}: follows up once when the imminent start ${outcome}`, async () => {
            mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
            const db = engine === 'rhythms' ? await rhythms() : undefined;
            if (db)
                scheduleRhythms(settingsDB.data, db, new Date());
            else
                powerJobs.schedulePowerOn(settingsDB.data, 'left', 'sunday', schedulesDB.data.left.sunday.power);
            const powerName = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
            const power = schedule.scheduledJobs[powerName];
            const checks = [];
            mock.method(globalThis, 'setTimeout', (callback, delay) => {
                assert.equal(delay, 180_000);
                checks.push(callback);
                return { unref() { } };
            });
            mock.timers.setTime(Date.parse('2026-10-04T20:00:00Z'));
            settingsDB.data.left.scheduleOverrides.pause.expiresAt = '2026-10-04T19:59:00Z';
            await settingsDB.write();
            await clearEndedPause('left', '2026-10-04T19:59:00Z');
            assert.deepEqual(updates, []);
            assert.equal(checks.length, 1, 'yield retains one follow-up');
            if (outcome === 'fails') {
                fail = true;
                await power.invoke(new Date());
                fail = false;
            }
            Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
            mock.timers.setTime(Date.parse('2026-10-04T20:03:00Z'));
            await checks[0]();
            assert.equal(updates.length, 1);
            assert.equal(status.left.isOn, true);
            assert.equal(checks.length, 1, 'the follow-up never yields again');
        });
    }
}
async function manualOff(side = 'left') {
    const handler = deviceRouter.stack.filter(layer => layer.route?.path === '/deviceStatus')[1]?.route?.stack[0].handle;
    assert.ok(handler);
    await handler({ body: { [side]: { isOn: false } } }, { status() { return this; }, end() { } }, () => { });
}
for (const away of ['left', 'right']) {
    for (const writeFails of [false, true]) {
        it(`handoff records both targets with ${away} away when the power write ${writeFails ? 'fails' : 'succeeds'}`, async () => {
            const db = await rhythms();
            db.right = everyNight(schedulesDB.data.right.sunday);
            settingsDB.data[away].awayMode = true;
            await settingsDB.write();
            const present = away === 'left' ? 'right' : 'left';
            status[present].isOn = true;
            fail = writeFails;
            const report = await disableRhythms({ powerOffNow: true }, async () => { });
            assert.equal(report.sides.find(plan => plan.side === present)?.action, 'powered-off');
            assert.equal(report.sides.find(plan => plan.side === away)?.action, 'none');
            assert.equal(report.sides.find(plan => plan.side === present)?.deviceUpdateFailed, writeFails ? true : undefined);
            assert.equal(lastManualPowerChange('left'), now);
            assert.equal(lastManualPowerChange('right'), now);
        });
    }
}
for (const engine of ['weekly', 'rhythms']) {
    for (const side of ['left', 'right']) {
        it(`${engine}: ${side} stays off after the owner turns it off through Rhythms handoff`, async () => {
            mock.timers.setTime(Date.parse('2026-10-04T19:00:00Z'));
            const db = testRhythmsDB(schedulesDB.data, everyNight(schedulesDB.data.left.sunday), everyNight(schedulesDB.data.right.sunday));
            settingsDB.data.features.rhythms = engine === 'rhythms';
            settingsDB.data[side].scheduleOverrides.pause = { active: true, expiresAt: '2026-10-04T19:59:00Z' };
            await settingsDB.write();
            if (engine === 'rhythms') {
                setEngineActivation({ active: true, db });
                scheduleRhythms(settingsDB.data, db, new Date());
            }
            else {
                powerJobs.schedulePowerOn(settingsDB.data, side, 'sunday', schedulesDB.data[side].sunday.power);
            }
            const powerName = engine === 'weekly' ? `${side}-sunday-20:00-power-on` : `rhythm-${side}-2026-10-04-power-on-2000-0`;
            const power = schedule.scheduledJobs[powerName];
            assert.ok(power);
            const checks = captureFollowUps();
            mock.timers.setTime(Date.parse('2026-10-04T20:00:00Z'));
            await clearEndedPause(side, '2026-10-04T19:59:00Z');
            assert.deepEqual(updates, []);
            assert.equal(checks.length, 1);
            await power.invoke(new Date());
            assert.equal(status[side].isOn, true);
            mock.timers.setTime(Date.parse('2026-10-04T20:01:00Z'));
            settingsDB.data.features.rhythms = true;
            await settingsDB.write();
            setEngineActivation({ active: true, db });
            const report = await disableRhythms({ powerOffNow: true }, async () => {
                Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
                setEngineActivation({ active: false, reason: 'flag-off' });
            });
            assert.equal(report.sides.find(plan => plan.side === side)?.action, 'powered-off');
            assert.equal(status[side].isOn, false);
            if (engine === 'rhythms') {
                settingsDB.data.features.rhythms = true;
                await settingsDB.write();
                setEngineActivation({ active: true, db });
            }
            mock.timers.setTime(Date.parse('2026-10-04T20:03:00Z'));
            await checks[0]();
            assert.equal(status[side].isOn, false);
            assert.deepEqual(updates.map(value => value[side]?.isOn), [true, false]);
            assert.equal(checks.length, 1);
        });
    }
}
for (const engine of ['weekly', 'rhythms']) {
    for (const change of [
        'manual off', 'raw manual off', 'manual off during status read', 'new pause', 'away',
        'engine', 'night ended', 'next night', 'already on', 'manual off from away side',
    ]) {
        it(`${engine}: follow-up respects ${change}`, async () => {
            if (engine === 'rhythms')
                await rhythms();
            const powerName = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
            assert.ok(schedule.scheduleJob(powerName, new Date(now + 1000), () => { }));
            const checks = captureFollowUps();
            await clearEndedPause('left', expiry);
            assert.equal(checks.length, 1);
            mock.timers.setTime(now + 60_000);
            if (change === 'manual off')
                await manualOff();
            if (change === 'manual off from away side') {
                settingsDB.data.right.awayMode = true;
                await settingsDB.write();
                await manualOff('right');
            }
            if (change === 'raw manual off') {
                const handler = executeRouter.stack[0].route?.stack[0].handle;
                assert.ok(handler);
                await handler({ body: { command: 'LEFT_TEMP_DURATION', arg: '0' } }, { json() { } }, () => { });
            }
            if (change === 'manual off during status read')
                onRead = async () => { await manualOff(); };
            if (change === 'new pause')
                settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
            if (change === 'away')
                settingsDB.data.left.awayMode = true;
            if (change === 'engine') {
                if (engine === 'weekly')
                    await rhythms();
                else
                    setEngineActivation({ active: false, reason: 'flag-off' });
            }
            if (change === 'already on')
                status.left.isOn = true;
            await settingsDB.write();
            const checkAt = change === 'night ended' ? Date.parse('2026-10-05T07:00:00Z')
                : change === 'next night' ? now + 86400_000 : now + 180_000;
            mock.timers.setTime(checkAt);
            await checks[0]();
            assert.equal(updates.filter(value => value.left?.isOn).length, 0);
            assert.equal(checks.length, 1);
        });
    }
    it(`${engine}: follow-up does not yield to a start still marked running`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        const name = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
        const job = schedule.scheduleJob(name, new Date(now + 1000), () => { });
        assert.ok(job);
        Object.assign(job, { running: 1 });
        const checks = captureFollowUps();
        await clearEndedPause('left', expiry);
        mock.timers.setTime(now + 180_000);
        await checks[0]();
        assert.equal(updates.length, 1);
        assert.equal(checks.length, 1);
    });
    it(`${engine}: a newer resume replaces the pending follow-up`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        const name = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
        const job = schedule.scheduleJob(name, new Date(now + 60_000), () => { });
        assert.ok(job);
        const checks = captureFollowUps();
        const cancelled = [];
        const clearTimer = globalThis.clearTimeout;
        mock.method(globalThis, 'clearTimeout', (timer) => { cancelled.push(timer); clearTimer(timer); });
        await clearEndedPause('left', expiry);
        mock.timers.setTime(now + 1000);
        await resumeSchedule('left');
        assert.equal(checks.length, 2);
        assert.equal(cancelled.length, 1);
        mock.timers.setTime(now + 180_000);
        await checks[0]();
        assert.deepEqual(updates, []);
        mock.timers.setTime(now + 181_000);
        await checks[1]();
        assert.equal(updates.length, 1);
    });
    it(`${engine}: a manual off before pause expiry permits the follow-up`, async () => {
        if (engine === 'rhythms')
            await rhythms();
        mock.timers.setTime(Date.parse(expiry) - 1000);
        await manualOff();
        mock.timers.setTime(now);
        const name = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
        assert.ok(schedule.scheduleJob(name, new Date(now + 1000), () => { }));
        const checks = captureFollowUps();
        await clearEndedPause('left', expiry);
        mock.timers.setTime(now + 180_000);
        await checks[0]();
        assert.equal(updates.filter(value => value.left?.isOn).length, 1);
    });
}
for (const engine of ['weekly', 'rhythms']) {
    for (const during of ['pending follow-up', 'resume status read', 'follow-up status read']) {
        it(`${engine}: shutdown during ${during} prevents resume dispatch`, async (t) => {
            mock.restoreAll();
            mock.method(logger, 'error', (error) => { errors.push(error); });
            mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
                namedExports: {
                    connectFrankenWithin: async () => { },
                    getDeviceStatusCoalesced: async () => { await onRead?.(); return status; },
                },
            });
            mock.module(new URL('./powerScheduler.js', import.meta.url).href, {
                namedExports: { weeklyPowerOnJob: (...args) => async (at) => {
                        weeklyCalls.push([...args, at]);
                        return powerJobs.weeklyPowerOnJob(...args)(at);
                    } },
            });
            mock.module(new URL('./rhythms/runEvent.js', import.meta.url).href, {
                namedExports: {
                    handedBack: rhythmJobs.handedBack,
                    runRhythmEvent: async (...args) => {
                        rhythmCalls.push(args);
                        return rhythmJobs.runRhythmEvent(...args);
                    },
                },
            });
            const resumes = await import(new URL(`./resumeSchedule.js?shutdown=${engine}-${during}`, import.meta.url).href);
            if (engine === 'rhythms')
                await rhythms();
            settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
            await settingsDB.write();
            const checks = captureFollowUps();
            const cancelled = [];
            t.mock.method(globalThis, 'clearTimeout', (timer) => { cancelled.push(timer); });
            if (during !== 'resume status read') {
                const name = engine === 'weekly' ? 'left-sunday-20:00-power-on' : 'rhythm-left-2026-10-04-power-on-2000-0';
                assert.ok(schedule.scheduleJob(name, new Date(now + 1000), () => { }));
                await resumes.resumeSchedule('left');
                assert.equal(checks.length, 1);
                Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
            }
            cancelled.length = 0;
            if (during === 'pending follow-up') {
                resumes.stopScheduleResumes();
                assert.equal(cancelled.length, 1, 'shutdown cancels the pending follow-up timer');
            }
            else {
                let statusStarted;
                let releaseStatus;
                const reading = new Promise(resolve => { statusStarted = resolve; });
                const release = new Promise(resolve => { releaseStatus = resolve; });
                onRead = async () => { statusStarted(); await release; };
                const pending = during === 'resume status read' ? resumes.resumeSchedule('left') : checks[0]();
                await reading;
                resumes.stopScheduleResumes();
                releaseStatus();
                await pending;
            }
            mock.timers.setTime(now + 180_000);
            if (during === 'pending follow-up')
                await checks[0]();
            assert.deepEqual(weeklyCalls, []);
            assert.deepEqual(rhythmCalls, []);
            assert.deepEqual(updates, []);
            await resumes.resumeSchedule('left');
            assert.deepEqual(weeklyCalls, [], 'new resumes after shutdown cannot dispatch');
            assert.deepEqual(rhythmCalls, [], 'new resumes after shutdown cannot dispatch');
            assert.deepEqual(errors, []);
        });
    }
}
//# sourceMappingURL=pauseResumeSchedule.test.js.map