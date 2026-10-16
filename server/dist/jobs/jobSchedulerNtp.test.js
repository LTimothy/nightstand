import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-clock-sync-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
let dateValid = true;
let synchronized = false;
let syncReads = 0;
const changes = [];
mock.module('chokidar', { defaultExport: { watch: () => ({
            on: (_event, handler) => { changes.push(handler); },
        }) } });
mock.module('./isSystemDateValid.js', { namedExports: { isSystemDateValid: () => dateValid } });
mock.module('./clockSynchronization.js', { namedExports: { readNtpSynchronization: async () => { syncReads++; return synchronized; } } });
mock.module('../routes/deviceStatus/updateDeviceStatus.js', { namedExports: { updateDeviceStatus: async () => { } } });
const { default: config } = await import('../config.js');
const { default: status } = await import('../serverStatus.js');
const { default: settingsDB } = await import('../db/settings.js');
const { default: schedulesDB } = await import('../db/schedules.js');
settingsDB.data.timeZone = 'UTC';
await settingsDB.write();
schedulesDB.data.left.monday.power = { on: '21:00', off: '07:00', enabled: true, onTemperature: 82 };
schedulesDB.data.left.monday.alarm = {
    enabled: true, time: '06:30', duration: 180, vibrationIntensity: 50, vibrationPattern: 'double', alarmTemperature: 82,
};
await schedulesDB.write();
const realTimeout = globalThis.setTimeout;
const jobName = 'left-monday-06:30-0-alarm';
async function flush() {
    for (let turn = 0; turn < 6; turn++)
        await new Promise(resolve => realTimeout(resolve, 5));
}
async function waitForJobs() {
    const deadline = Date.now() + 5_000;
    while (!schedule.scheduledJobs[jobName] || status.status.jobs.status === 'started') {
        assert.ok(Date.now() < deadline, 'timed out waiting for jobs');
        await new Promise(resolve => realTimeout(resolve, 5));
    }
}
after(() => rmSync(folder, { recursive: true, force: true }));
for (const scenario of ['synced', 'unsynchronized', 'invalid-year', 'unavailable', 'local']) {
    it(`arms alarms from the year floor when ${scenario}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        t.after(() => schedule.gracefulShutdown());
        dateValid = scenario !== 'invalid-year';
        synchronized = scenario === 'unavailable' ? undefined : scenario === 'synced' || scenario === 'invalid-year';
        syncReads = 0;
        changes.length = 0;
        config.remoteDevMode = scenario === 'local';
        status.status.systemDate.status = 'not_started';
        status.status.systemDate.message = '';
        const scheduler = await import(`./jobScheduler.js?clock=${scenario}`);
        if (scenario === 'invalid-year') {
            await flush();
            assert.equal(schedule.scheduledJobs[jobName], undefined, 'NTP must not bypass the year floor');
            await scheduler.setupJobs();
            changes[0]('/tmp/lowdb/settingsDB.json');
            await flush();
            assert.equal(schedule.scheduledJobs[jobName], undefined, 'a settings edit must not bypass the year floor');
            dateValid = true;
            t.mock.timers.tick(5_000);
        }
        await waitForJobs();
        await flush();
        assert.ok(schedule.scheduledJobs[jobName]);
        assert.equal(status.status.systemDate.status, 'healthy');
        if (scenario === 'unavailable')
            assert.match(status.status.systemDate.message, /NTP.*unavailable/);
        else if (scenario === 'unsynchronized')
            assert.match(status.status.systemDate.message, /not synchronized.*wrong time/);
        else
            assert.equal(status.status.systemDate.message, '');
        const message = status.status.systemDate.message;
        status.updateSystemDate();
        assert.equal(status.status.systemDate.message, message, 'status reads must preserve clock warnings');
        if (scenario === 'local')
            assert.equal(syncReads, 0);
        if (scenario === 'unsynchronized') {
            const armedJob = schedule.scheduledJobs[jobName];
            synchronized = true;
            t.mock.timers.tick(300_000);
            await flush();
            assert.equal(status.status.systemDate.message, '', 'a later sync clears the warning');
            assert.equal(schedule.scheduledJobs[jobName], armedJob, 'sync checks must not disarm alarms');
            synchronized = false;
            t.mock.timers.tick(300_000);
            await flush();
            assert.match(status.status.systemDate.message, /not synchronized/);
            assert.equal(schedule.scheduledJobs[jobName], armedJob);
        }
    });
}
//# sourceMappingURL=jobSchedulerNtp.test.js.map