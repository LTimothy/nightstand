import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-engine-switch-'));
const lowdb = path.join(folder, 'lowdb');
mkdirSync(lowdb);
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T12:00:00Z') });
let change;
const commands = [];
mock.module('chokidar', {
    defaultExport: { watch: () => ({ on: (_event, handler) => { change = handler; } }) },
});
mock.module(new URL('../isSystemDateValid.js', import.meta.url).href, { namedExports: { isSystemDateValid: () => true } });
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { } },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async (command, arg, ...rest) => {
            commands.push([command, typeof arg === 'function' ? arg() : arg, ...rest]);
        } },
});
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => ({ getDeviceStatus: async () => ({ left: { isOn: true }, right: { isOn: true } }) }),
        isFrankenConnected: () => true,
        getDeviceStatusCoalesced: async () => ({ left: { isOn: true }, right: { isOn: true } }),
    },
});
// Delegates to the real resolver, except for a side a test makes fail.
const realResolve = await import('./resolve.js');
let failingSide = null;
mock.module(new URL('./resolve.js', import.meta.url).href, {
    namedExports: {
        ...realResolve,
        resolveSleeps: (args) => {
            if (args.side === failingSide)
                throw new Error(`cannot resolve ${args.side}`);
            return realResolve.resolveSleeps(args);
        },
    },
});
const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { default: serverStatus } = await import('../../serverStatus.js');
const { SCHEDULE_DAYS } = await import('../../db/scheduleKeys.js');
const { everyNight, testNight, testRhythmsDB } = await import('./testSupport.js');
const { smartManualChange } = await import('./curveController.js');
const LEGACY_PER_DAY = /^(left|right)-(sunday|monday|tuesday|wednesday|thursday|friday|saturday)-/;
const RHYTHM_NIGHT = testNight('22:00', '06:00', { temperatures: { '02:00': 72 }, alarms: ['05:45'], alarmIntensity: 35 });
const jobNames = () => Object.keys(schedule.scheduledJobs).sort();
const writeRhythms = (db) => writeFileSync(path.join(lowdb, 'rhythmsDB.json'), typeof db === 'string' ? db : JSON.stringify(db));
let setupJobs;
let baseline = [];
async function setFlag(value) {
    settingsDB.data.features.rhythms = value;
    await settingsDB.write();
}
async function waitFor(done, what) {
    const deadline = performance.now() + 5_000;
    while (!done()) {
        assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
before(async () => {
    settingsDB.data.timeZone = 'UTC';
    settingsDB.data.features.rhythms = false;
    await settingsDB.write();
    for (const day of SCHEDULE_DAYS) {
        schedulesDB.data.left[day] = testNight('21:00', '07:00', { temperatures: { '23:00': 70 }, alarms: ['06:30'] });
        schedulesDB.data.right[day] = testNight('22:00', '06:00');
    }
    await schedulesDB.write();
    ({ setupJobs } = await import('../jobScheduler.js'));
    await setupJobs();
    baseline = jobNames();
});
after(async () => {
    Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
    await schedule.gracefulShutdown();
    mock.timers.reset();
    rmSync(folder, { recursive: true, force: true });
});
describe('choosing the engine on every rebuild', () => {
    it('keeps the weekly jobs exactly while the flag is off, even with valid Rhythms data', async () => {
        assert.ok(baseline.includes('left-monday-21:00-power-on'));
        assert.ok(baseline.includes('daily-analyze-sleep-left'));
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(RHYTHM_NIGHT)));
        await setupJobs();
        assert.deepEqual(jobNames(), baseline);
        assert.equal(serverStatus.status.rhythmsSchedule, undefined);
    });
    it('keeps the weekly jobs and says why when the weekly schedule changed underneath', async () => {
        writeRhythms({ ...testRhythmsDB(schedulesDB.data, everyNight(RHYTHM_NIGHT)), legacyFingerprint: '0'.repeat(64) });
        await setFlag(true);
        await setupJobs();
        assert.deepEqual(jobNames(), baseline);
        assert.equal(serverStatus.status.rhythmsSchedule?.status, 'not_started');
        assert.match(serverStatus.status.rhythmsSchedule?.message ?? '', /weekly schedule changed/);
    });
    it('keeps the weekly jobs and fails the status when the data cannot be read', async () => {
        writeRhythms('{not json');
        await setupJobs();
        assert.deepEqual(jobNames(), baseline);
        assert.equal(serverStatus.status.rhythmsSchedule?.status, 'failed');
    });
    it('replaces the weekly and noon jobs with rhythm jobs when active', async () => {
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(RHYTHM_NIGHT)));
        await setupJobs();
        const names = jobNames();
        assert.equal(names.some(name => LEGACY_PER_DAY.test(name)), false);
        assert.equal(names.includes('daily-analyze-sleep-left'), false);
        // Right has no rhythm sleeps, so it keeps the noon analysis.
        assert.ok(names.includes('daily-analyze-sleep-right'));
        assert.ok(names.includes('rhythms-horizon'));
        assert.ok(names.includes('rhythm-left-2026-09-28-power-on-2200-0'));
        const shared = baseline.filter(name => !LEGACY_PER_DAY.test(name) && !name.startsWith('daily-analyze-sleep'));
        for (const name of shared)
            assert.ok(names.includes(name), `lost shared job ${name}`);
        assert.equal(serverStatus.status.rhythmsSchedule?.status, 'healthy');
        assert.equal(serverStatus.status.rhythmsSchedule?.message, '12 job(s) planned');
        assert.equal(serverStatus.status.jobs.status, 'healthy');
    });
    it("takes a replacement alarm's vibration from the rhythm", async () => {
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '05:00', expiresAt: '2026-09-29T06:00:00+00:00' };
        await settingsDB.write();
        await setupJobs();
        mock.timers.setTime(Date.parse('2026-09-29T05:00:00Z'));
        const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
        try {
            await schedule.scheduledJobs['left-alarm-override-05:00'].invoke();
        }
        finally {
            timer.mock.restore();
            mock.timers.setTime(Date.parse('2026-09-28T12:00:00Z'));
            settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            await settingsDB.write();
        }
        const { default: cbor } = await import('cbor');
        const payload = cbor.decodeFirstSync(Buffer.from(commands[0][1], 'hex'));
        assert.equal(payload.pl, 35);
        assert.equal(payload.du, 20);
    });
    it('finds the rhythm night of a replacement set for the turn-off minute', async () => {
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '06:00', expiresAt: '2026-09-29T06:00:00+00:00' };
        await settingsDB.write();
        await setupJobs();
        assert.ok(schedule.scheduledJobs['left-alarm-override-06:00'], 'the override at the turn-off minute was not scheduled');
        commands.length = 0;
        mock.timers.setTime(Date.parse('2026-09-29T06:00:00Z'));
        const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
        try {
            await schedule.scheduledJobs['left-alarm-override-06:00'].invoke();
        }
        finally {
            timer.mock.restore();
            mock.timers.setTime(Date.parse('2026-09-28T12:00:00Z'));
            settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            await settingsDB.write();
        }
        const { default: cbor } = await import('cbor');
        const payload = cbor.decodeFirstSync(Buffer.from(commands[0][1], 'hex'));
        assert.equal(payload.pl, 35, 'the replacement did not find the sleep that ends at its minute');
    });
    it('does not ring a replacement again at the end of a full-day sleep it opened', async () => {
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(testNight('13:00', '13:00', { alarms: ['13:30'] }))));
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '13:00', expiresAt: '2026-09-29T13:00:00+00:00' };
        await settingsDB.write();
        await setupJobs();
        const name = 'left-alarm-override-13:00';
        assert.equal(schedule.scheduledJobs[name]?.nextInvocation()?.getTime(), Date.parse('2026-09-28T13:00:00Z'));
        mock.timers.setTime(Date.parse('2026-09-28T13:00:00Z'));
        const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
        try {
            await schedule.scheduledJobs[name].invoke();
            mock.timers.setTime(Date.parse('2026-09-28T13:05:00Z'));
            await setupJobs();
            assert.equal(schedule.scheduledJobs[name], undefined, 'the replacement would ring again when the sleep it opened ends');
        }
        finally {
            timer.mock.restore();
            mock.timers.setTime(Date.parse('2026-09-28T12:00:00Z'));
            settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            await settingsDB.write();
        }
    });
    it('does not lose a switch that lands during a rebuild', async () => {
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(testNight('22:12', '06:00'))));
        await setFlag(false);
        await setupJobs();
        assert.deepEqual(jobNames(), baseline);
        let release;
        let blocked = false;
        const originalRead = schedulesDB.read.bind(schedulesDB);
        const readMock = mock.method(schedulesDB, 'read', async () => {
            await originalRead();
            if (!blocked) {
                blocked = true;
                await new Promise(resolve => { release = resolve; });
            }
        });
        try {
            change('schedulesDB.json');
            await waitFor(() => blocked, 'the rebuild to start');
            // Written to disk only: the blocked pass already holds the settings it read.
            const turnedOn = structuredClone(settingsDB.data);
            turnedOn.features.rhythms = true;
            writeFileSync(path.join(lowdb, 'settingsDB.json'), JSON.stringify(turnedOn));
            change('.settingsDB.json.tmp');
            release();
            await waitFor(() => Boolean(schedule.scheduledJobs['rhythm-left-2026-09-28-power-on-2212-0']), 'the rerun');
            assert.equal(jobNames().some(name => LEGACY_PER_DAY.test(name)), false);
        }
        finally {
            readMock.mock.restore();
        }
    });
    it('restores the weekly jobs exactly when the flag goes off again', async () => {
        await setFlag(false);
        await setupJobs();
        assert.deepEqual(jobNames(), baseline);
        assert.equal(serverStatus.status.rhythmsSchedule, undefined);
    });
    it('rings, keeps the other jobs and reports the side when a side cannot be resolved', async () => {
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(testNight('13:00', '13:00', { alarms: ['13:30'], alarmIntensity: 35 }))));
        settingsDB.data.features.rhythms = true;
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '13:00', expiresAt: '2026-09-29T13:00:00+00:00' };
        await settingsDB.write();
        await setupJobs();
        const name = 'left-alarm-override-13:00';
        assert.ok(schedule.scheduledJobs[name]);
        commands.length = 0;
        failingSide = 'left';
        mock.timers.setTime(Date.parse('2026-09-28T13:00:00Z'));
        const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
        try {
            await assert.doesNotReject(async () => { await schedule.scheduledJobs[name].invoke(); });
            const { default: cbor } = await import('cbor');
            assert.equal(cbor.decodeFirstSync(Buffer.from(commands[0][1], 'hex')).pl, 100, 'the default vibration was not used');
            // The override already rang and expires at the next 13:00, so the
            // rebuild looks up the sleep around that minute.
            mock.timers.setTime(Date.parse('2026-09-28T13:05:00Z'));
            await setupJobs();
            const names = jobNames();
            assert.ok(names.includes(name), 'the rebuild stopped at the replacement alarm');
            const shared = baseline.filter(job => !LEGACY_PER_DAY.test(job) && !job.startsWith('daily-analyze-sleep'));
            for (const job of shared)
                assert.ok(names.includes(job), `lost shared job ${job}`);
            assert.equal(serverStatus.status.rhythmsSchedule?.status, 'failed');
            assert.match(serverStatus.status.rhythmsSchedule?.message ?? '', /left side/);
            assert.equal(serverStatus.status.jobs.status, 'failed');
            assert.match(serverStatus.status.jobs.message, /1 side/);
        }
        finally {
            failingSide = null;
            timer.mock.restore();
            mock.timers.setTime(Date.parse('2026-09-28T12:00:00Z'));
            settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            await settingsDB.write();
        }
    });
    it('waits for a time zone before planning', async () => {
        writeRhythms(testRhythmsDB(schedulesDB.data, everyNight(RHYTHM_NIGHT)));
        settingsDB.data.timeZone = null;
        await settingsDB.write();
        try {
            await setupJobs();
            assert.equal(serverStatus.status.rhythmsSchedule?.status, 'not_started');
            assert.match(serverStatus.status.rhythmsSchedule?.message ?? '', /time zone/);
        }
        finally {
            settingsDB.data.timeZone = 'UTC';
            settingsDB.data.features.rhythms = false;
            await settingsDB.write();
        }
    });
    it('runs Smart Schedule only while Rhythms is active, even when a rebuild fails', async () => {
        const left = everyNight(testNight('11:30', '18:00'));
        left.rhythms['every-night'].temperatureMode = 'smart';
        writeRhythms(testRhythmsDB(schedulesDB.data, left));
        await setFlag(true);
        await setupJobs();
        assert.equal(smartManualChange('left'), 'held');
        await setFlag(false);
        await setupJobs();
        assert.equal(smartManualChange('left'), 'not-smart');
        await setFlag(true);
        await setupJobs();
        settingsDB.data.features.rhythms = false;
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '13:00', expiresAt: '2026-09-29T13:00:00+00:00' };
        await settingsDB.write();
        const failing = mock.method(schedule, 'scheduleJob', () => { throw new Error('cannot schedule'); });
        try {
            await setupJobs();
            assert.equal(serverStatus.status.jobs.status, 'failed');
            assert.equal(smartManualChange('left'), 'not-smart');
        }
        finally {
            failing.mock.restore();
            settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
            await settingsDB.write();
            await setupJobs();
        }
    });
});
//# sourceMappingURL=engineSwitch.test.js.map