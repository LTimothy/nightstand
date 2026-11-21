import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import schedule from 'node-schedule';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-kept-alarms-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const commands = [];
const deviceStatus = { left: { isOn: true }, right: { isOn: true } };
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { } },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
    namedExports: { executeFunction: async (...args) => { commands.push(args); } },
});
let connected = true;
let statusFails = false;
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: {
        connectFrankenWithin: async () => {
            // The bounded wait ends with the Pod back four minutes late.
            if (!connected)
                mock.timers.setTime(Date.now() + 4 * 60_000);
            return { getDeviceStatus: async () => deviceStatus };
        },
        isFrankenConnected: () => connected,
        // Waits for a reconnect without limit.
        getDeviceStatusCoalesced: async () => {
            if (!connected)
                return new Promise(() => { });
            if (statusFails)
                throw new Error('Franken command timed out');
            return deviceStatus;
        },
    },
});
mock.module(new URL('../analyzeSleep.js', import.meta.url).href, { namedExports: { executeAnalyzeSleep: () => { } } });
const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { resolveSleeps } = await import('./resolve.js');
const { everyNight, testNight, testRhythmsDB } = await import('./testSupport.js');
const { keepSleepAlarms, scheduleKeptAlarms } = await import('./scheduleRhythms.js');
const { forgetKeptAlarms, dropKeptAlarms } = await import('./keptAlarms.js');
const { resetAlarmActivity, rhythmNightAlarms } = await import('../alarmActivity.js');
const { resetAlarmOccurrences } = await import('../alarmScheduler.js');
const ledger = await import('../alarmLedger.js');
const NOW = Date.parse('2026-09-29T05:45:00Z');
const SECOND = 'rhythm-left-2026-09-28-alarm-0600-1';
let sleep;
const alarmJobs = () => Object.keys(schedule.scheduledJobs).filter(name => name.includes('-alarm-'));
const cancelAll = () => Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
async function ringAt(name, at) {
    mock.timers.setTime(Date.parse(at));
    const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() { } }));
    try {
        await schedule.scheduledJobs[name].invoke();
    }
    finally {
        timer.mock.restore();
    }
}
beforeEach(async () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    settingsDB.data.timeZone = 'UTC';
    settingsDB.data.features.alarmsWhenOff = false;
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].alarmsEnabled = true;
        settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
        settingsDB.data[side].scheduleOverrides.alarm = { disabled: false, timeOverride: '', expiresAt: '' };
    }
    await settingsDB.write();
    sleep = resolveSleeps({
        db: testRhythmsDB(schedulesDB.data, everyNight(testNight('22:00', '06:30', { alarms: ['05:30', '06:00'] }))),
        side: 'left', timeZone: 'UTC', from: new Date(NOW), to: new Date(NOW),
    })[0];
    deviceStatus.left.isOn = true;
    connected = true;
    statusFails = false;
    commands.length = 0;
    resetAlarmActivity();
    resetAlarmOccurrences();
    cancelAll();
    dropKeptAlarms();
});
afterEach(() => {
    ledger.resetAlarmLedgerForTests();
    rmSync(path.join(folder, 'alarm-ledger.json'), { force: true });
    cancelAll();
    dropKeptAlarms();
    mock.timers.reset();
});
after(() => rmSync(folder, { recursive: true, force: true }));
describe('kept alarms', () => {
    it('schedules only the alarms still ahead, and again after a rebuild cancels every job', () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        assert.equal(scheduleKeptAlarms(new Date(NOW)), 1);
        assert.deepEqual(alarmJobs(), [SECOND]);
        cancelAll();
        assert.equal(scheduleKeptAlarms(new Date(NOW)), 1);
        assert.deepEqual(alarmJobs(), [SECOND]);
    });
    it('names the job like the rhythm alarm job, so a power-off in its minute waits for it', () => {
        assert.equal(rhythmNightAlarms('left', sleep.date)(SECOND), true);
    });
    it('rings like a rhythm alarm', async () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.equal(commands.filter(([name]) => name === 'ALARM_LEFT').length, 1);
    });
    it('stays quiet while the side is paused', async () => {
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T09:00:00Z' };
        await settingsDB.write();
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.deepEqual(commands, []);
    });
    it('stays quiet on an away side', async () => {
        settingsDB.data.left.awayMode = true;
        await settingsDB.write();
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.deepEqual(commands, []);
    });
    it('skips an alarm that could only start more than three minutes late', async () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:05:00Z');
        assert.deepEqual(commands, []);
    });
    it('is cancelled when the side was turned off before it fires', async () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        deviceStatus.left.isOn = false;
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.deepEqual(commands, []);
        assert.deepEqual(alarmJobs(), []);
        assert.equal(scheduleKeptAlarms(new Date(NOW)), 0);
    });
    it('rings on a side that is off when alarms ring with the side off', async () => {
        settingsDB.data.features.alarmsWhenOff = true;
        await settingsDB.write();
        ledger.startAlarmLedger(new Date(NOW));
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        deviceStatus.left.isOn = false;
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.equal(commands.filter(([name]) => name === 'ALARM_LEFT').length, 1);
        assert.deepEqual(ledger.listMissedAlarms(new Date(NOW)), []);
    });
    it('rings anyway when the Pod cannot be read', async () => {
        statusFails = true;
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.equal(commands.filter(([name]) => name === 'ALARM_LEFT').length, 1);
    });
    it('does not wait for a Pod that is not connected, and does not ring late', async () => {
        connected = false;
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        const settled = await Promise.race([ringAt(SECOND, '2026-09-29T06:00:00Z').then(() => true), delay(2_000, false)]);
        assert.equal(settled, true, 'the kept alarm waited for the Pod to reconnect');
        assert.deepEqual(commands, []);
    });
    it('is forgotten when the side is turned off', () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        forgetKeptAlarms('left');
        assert.deepEqual(alarmJobs(), []);
        assert.equal(scheduleKeptAlarms(new Date(NOW)), 0);
    });
    it('is dropped without touching jobs once a rhythm engine is active again', () => {
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        dropKeptAlarms();
        assert.deepEqual(alarmJobs(), [SECOND], 'dropping must not cancel a job the engine may own');
        cancelAll();
        assert.equal(scheduleKeptAlarms(new Date(NOW)), 0);
    });
    it('reports a side that was off as missed, but not one that is paused', async () => {
        ledger.startAlarmLedger(new Date(NOW));
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        deviceStatus.left.isOn = false;
        settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T09:00:00Z' };
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        assert.deepEqual(ledger.listMissedAlarms(new Date(NOW)), []);
        settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        await ringAt(SECOND, '2026-09-29T06:00:00Z');
        const [missed] = ledger.listMissedAlarms(new Date(NOW));
        assert.equal(missed.reason, 'side-off');
        assert.equal(missed.at, '2026-09-29T06:00:00.000Z');
    });
    it('is left out of the saved alarms while an override replaces it', () => {
        const saved = () => JSON.parse(readFileSync(path.join(folder, 'alarm-ledger.json'), 'utf8')).upcoming
            .map(item => item.jobName);
        keepSleepAlarms('left', sleep, new Date(NOW), 'UTC');
        scheduleKeptAlarms(new Date(NOW));
        ledger.startAlarmLedger(new Date(NOW));
        ledger.alarmLedgerHeartbeat(new Date(NOW));
        assert.deepEqual(saved(), [SECOND]);
        settingsDB.data.left.scheduleOverrides.alarm = { disabled: false, timeOverride: '06:30', expiresAt: '2026-09-29T06:30:00Z' };
        ledger.alarmLedgerHeartbeat(new Date(NOW));
        assert.deepEqual(saved(), []);
    });
});
//# sourceMappingURL=keptAlarms.test.js.map