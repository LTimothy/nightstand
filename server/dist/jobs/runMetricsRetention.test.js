import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import schedule from 'node-schedule';
import { retentionCutoffs } from './metricsRetention.js';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-retention-job-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
let spaceKb = 200 * 1024;
let dfCalls = 0;
let diskError = false;
let pruneError = false;
let pruneStopped = 'complete';
let pruning = [];
const errors = [];
const reports = [];
mock.module(new URL('../logger.js', import.meta.url).href, {
    defaultExport: { debug() { }, info(message) { reports.push(message); }, warn() { },
        error(message) { errors.push(message); } },
});
mock.module('child_process', {
    namedExports: {
        exec: () => { throw new Error('Unexpected exec'); },
        execFile: Object.assign(() => { throw new Error('Unexpected callback invocation'); }, {
            [promisify.custom]: async (command, args) => {
                assert.equal(command, 'df');
                assert.deepEqual(args, ['-k', '-P', `${folder}/`]);
                dfCalls++;
                if (diskError)
                    throw new Error('df failed');
                return { stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n`
                        + `/dev/test 1000000 100000 ${spaceKb} 10% /persistent\n` };
            },
        })
    },
});
mock.module(new URL('../db/prisma.js', import.meta.url).href, { namedExports: { prisma: {} } });
mock.module(new URL('./metricsRetention.js', import.meta.url).href, { namedExports: {
        retentionCutoffs,
        pruneMetrics: async (_client, cutoffs) => {
            pruning.push(cutoffs);
            if (pruneError)
                throw new Error('database locked');
            return { vitals: 1, batches: 1, stopped: pruneStopped };
        },
    } });
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { throw new Error('Unexpected device command'); } },
});
mock.module(new URL('./reboot.js', import.meta.url).href, {
    defaultExport: async () => { throw new Error('Unexpected reboot'); },
});
mock.module(new URL('./calibrateSensors.js', import.meta.url).href, {
    namedExports: { executeCalibrateSensors: () => { throw new Error('Unexpected calibration'); } },
});
const { runMetricsRetention } = await import('./runMetricsRetention.js');
const { schedulePrimingRebootAndCalibration } = await import('./primeScheduler.js');
const { default: settings, updateSettings } = await import('../db/settings.js');
const { updateServices } = await import('../db/services.js');
beforeEach(async () => {
    spaceKb = 200 * 1024;
    diskError = false;
    pruneError = false;
    pruneStopped = 'complete';
    dfCalls = 0;
    pruning = [];
    errors.length = 0;
    reports.length = 0;
    await updateSettings(data => { data.features.metricsRetention = false; data.features.metricsLowDiskProtection = true; });
    writeFileSync(path.join(folder, 'free-sleep.db'), '');
});
after(async () => {
    Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
    rmSync(folder, { recursive: true, force: true });
});
test('off switch prevents disk checks and deletions', async () => {
    await updateSettings(data => { data.features.metricsRetention = false; data.features.metricsLowDiskProtection = false; });
    await runMetricsRetention();
    assert.equal(dfCalls, 0);
    assert.equal(pruning.length, 0);
});
test('missing database does not create one', async () => {
    rmSync(path.join(folder, 'free-sleep.db'));
    await runMetricsRetention();
    assert.equal(dfCalls, 0);
    assert.equal(pruning.length, 0);
});
test('uses available space for the low disk tier and coalesces concurrent runs', async () => {
    spaceKb = 149 * 1024;
    const now = new Date('2026-10-07T12:00:00Z');
    const first = runMetricsRetention(now);
    assert.equal(runMetricsRetention(now), first);
    await first;
    assert.equal(dfCalls, 1);
    assert.deepEqual(pruning, [retentionCutoffs(now, spaceKb * 1024)]);
});
test('disk errors and invalid readings prevent deletion', async () => {
    diskError = true;
    await runMetricsRetention();
    diskError = false;
    spaceKb = NaN;
    await runMetricsRetention();
    assert.equal(pruning.length, 0);
    assert.equal(errors.length, 2);
});
test('a failed prune is reported and can run again', async () => {
    pruneError = true;
    await runMetricsRetention();
    assert.match(errors[0], /database locked/);
    pruneError = false;
    await runMetricsRetention();
    assert.equal(pruning.length, 2);
});
test('a timed-out retention batch is reported once without retrying that daily run', async () => {
    pruneStopped = 'transaction timeout';
    await runMetricsRetention();
    assert.equal(pruning.length, 1);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /transaction timeout/);
    assert.equal(errors.length, 0);
});
test('daily retention job prunes even with biometrics, priming and both sides away', async () => {
    await updateServices({ biometrics: { enabled: false } });
    await updateSettings(data => {
        data.primePodDaily.enabled = false;
        data.left.awayMode = true;
        data.right.awayMode = true;
    });
    schedulePrimingRebootAndCalibration(settings.data);
    await schedule.scheduledJobs['daily-calibration-19:00-right'].invoke();
    await schedule.scheduledJobs['daily-calibration-18:30-left'].invoke();
    assert.equal(pruning.length, 0);
    await schedule.scheduledJobs['daily-metrics-retention'].invoke();
    assert.equal(pruning.length, 1);
});
//# sourceMappingURL=runMetricsRetention.test.js.map