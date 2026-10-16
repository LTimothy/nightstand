import assert from 'node:assert/strict';
import { after, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-prime-scheduler-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
let rebootError;
let primeError;
let statusError;
let priming = false;
let primeSends = 0;
let statusReads = 0;
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => {
            primeSends++;
            if (primeError)
                throw primeError;
        } },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: { connectFrankenWithin: async () => ({ getDeviceStatus: async () => {
                statusReads++;
                if (statusError)
                    throw statusError;
                return { isPriming: priming };
            } }) },
});
mock.module(new URL('./reboot.js', import.meta.url).href, {
    defaultExport: async () => { if (rebootError)
        throw rebootError; },
});
// Captures the callbacks instead of scheduling them, so no real timer can fire.
const jobs = new Map();
mock.module('node-schedule', { defaultExport: {
        RecurrenceRule: class {
        },
        scheduledJobs: {},
        scheduleJob: (name, _rule, callback) => { jobs.set(name, callback); },
    } });
const { schedulePrimingRebootAndCalibration } = await import('./primeScheduler.js');
const { default: settingsDB } = await import('../db/settings.js');
const { default: serverStatus } = await import('../serverStatus.js');
after(() => { rmSync(folder, { recursive: true, force: true }); });
beforeEach(async () => {
    jobs.clear();
    rebootError = undefined;
    primeError = undefined;
    statusError = undefined;
    priming = false;
    primeSends = 0;
    statusReads = 0;
    serverStatus.status.primeSchedule.status = 'not_started';
    serverStatus.status.primeSchedule.message = '';
    settingsDB.data.rebootDaily = true;
    settingsDB.data.timeZone = 'America/Los_Angeles';
    settingsDB.data.primePodDaily = { enabled: true, time: '14:00' };
    await settingsDB.write();
    serverStatus.status.alarmSchedule.status = 'healthy';
    serverStatus.status.alarmSchedule.message = 'Alarms scheduled';
    serverStatus.status.rebootSchedule.status = 'not_started';
    serverStatus.status.rebootSchedule.message = 'Previous failure';
});
async function runDailyReboot() {
    schedulePrimingRebootAndCalibration(settingsDB.data);
    const job = [...jobs].find(([name]) => name.startsWith('daily-reboot-'))?.[1];
    assert.ok(job, 'expected a daily reboot job');
    await job();
}
it('reports a failed daily reboot without changing alarm health', async () => {
    rebootError = new Error('Reboot failed');
    const alarmBefore = { ...serverStatus.status.alarmSchedule };
    await runDailyReboot();
    assert.equal(serverStatus.status.rebootSchedule.status, 'failed');
    assert.equal(serverStatus.status.rebootSchedule.message, 'Reboot failed');
    assert.deepEqual(serverStatus.status.alarmSchedule, alarmBefore);
});
it('reports a successful daily reboot without changing alarm health', async () => {
    const alarmBefore = { ...serverStatus.status.alarmSchedule };
    await runDailyReboot();
    assert.equal(serverStatus.status.rebootSchedule.status, 'healthy');
    assert.equal(serverStatus.status.rebootSchedule.message, '');
    assert.deepEqual(serverStatus.status.alarmSchedule, alarmBefore);
});
function startDailyPrime() {
    schedulePrimingRebootAndCalibration(settingsDB.data);
    const job = jobs.get('daily-priming-14:00');
    assert.ok(job);
    return job();
}
it('waits for priming confirmation before reporting success', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const running = startDailyPrime();
    await Promise.resolve();
    assert.equal(serverStatus.status.primeSchedule.status, 'started');
    assert.equal(statusReads, 0);
    t.mock.timers.tick(29_999);
    assert.equal(statusReads, 0);
    priming = true;
    t.mock.timers.tick(1);
    await running;
    assert.equal(serverStatus.status.primeSchedule.status, 'healthy');
    assert.equal(serverStatus.status.primeSchedule.message, '');
    assert.equal(statusReads, 1);
    assert.equal(primeSends, 1);
});
it('reports an unconfirmed daily prime on the prime row without resending', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const alarmBefore = { ...serverStatus.status.alarmSchedule };
    const running = startDailyPrime();
    await Promise.resolve();
    t.mock.timers.tick(30_000);
    await running;
    assert.equal(serverStatus.status.primeSchedule.status, 'failed');
    assert.match(serverStatus.status.primeSchedule.message, /did not report priming/);
    assert.equal(primeSends, 1);
    assert.deepEqual(serverStatus.status.alarmSchedule, alarmBefore);
});
it('reports a failed priming status read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    statusError = new Error('Status unavailable');
    const running = startDailyPrime();
    await Promise.resolve();
    t.mock.timers.tick(30_000);
    await running;
    assert.equal(serverStatus.status.primeSchedule.status, 'failed');
    assert.equal(serverStatus.status.primeSchedule.message, 'Status unavailable');
});
it('reports a prime command failure without waiting to read status', async () => {
    primeError = new Error('Prime unavailable');
    await startDailyPrime();
    assert.equal(serverStatus.status.primeSchedule.status, 'failed');
    assert.equal(serverStatus.status.primeSchedule.message, 'Prime unavailable');
    assert.equal(statusReads, 0);
});
//# sourceMappingURL=primeScheduler.test.js.map