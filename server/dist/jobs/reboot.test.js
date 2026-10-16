import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
const reboots = [];
const logs = [];
const warnings = [];
let activeUnit = '';
let checkFailed = false;
let dailyJob;
mock.module('child_process', { namedExports: {
        // Report each reboot as failed so the reboot latch does not carry between tests.
        exec: (command, callback) => {
            reboots.push(command);
            callback(new Error('not rebooting under test'));
        },
        execFile: (_command, args, _options, callback) => {
            callback(checkFailed ? new Error('check failed') : null, args.includes(activeUnit) ? 'active' : 'inactive');
        },
    } });
mock.module(new URL('../logger.js', import.meta.url).href, { defaultExport: {
        warn: (message) => warnings.push(message),
        debug: () => { }, info: (message) => logs.push(message), error: () => { },
    } });
mock.module('node-schedule', { defaultExport: {
        RecurrenceRule: class {
        },
        scheduleJob: (name, _rule, callback) => {
            if (name.startsWith('daily-reboot'))
                dailyJob = callback;
        },
    } });
mock.module(new URL('../db/settings.js', import.meta.url).href, { defaultExport: { read: async () => { }, data: { rebootDaily: true } } });
mock.module(new URL('../db/services.js', import.meta.url).href, { defaultExport: {} });
mock.module(new URL('../serverStatus.js', import.meta.url).href, { defaultExport: { status: { alarmSchedule: {} } } });
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { } },
});
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
    namedExports: { connectFrankenWithin: async () => { throw new Error('No hardware connection under test'); } },
});
mock.module(new URL('./calibrateSensors.js', import.meta.url).href, { namedExports: { executeCalibrateSensors: () => { } } });
mock.module(new URL('./runMetricsRetention.js', import.meta.url).href, { namedExports: { runMetricsRetention: async () => { } } });
const { default: reboot } = await import('./reboot.js');
const { schedulePrimingRebootAndCalibration } = await import('./primeScheduler.js');
for (const unit of ['free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service']) {
    it(`refuses manual and skips daily reboot while ${unit} runs`, async () => {
        activeUnit = unit;
        reboots.length = 0;
        logs.length = 0;
        warnings.length = 0;
        await assert.rejects(reboot(), /already running/);
        const settings = {
            timeZone: 'UTC', primePodDaily: { enabled: true, time: '14:00' },
        };
        schedulePrimingRebootAndCalibration(settings);
        assert.ok(dailyJob);
        await dailyJob();
        assert.equal(reboots.length, 0);
        assert.ok(logs.some(message => /Skipping daily reboot.*already running/.test(message)));
        assert.equal(warnings.length, 0);
        activeUnit = '';
    });
}
it('fails closed when operation state cannot be read and reboots when idle', async () => {
    checkFailed = true;
    await assert.rejects(reboot(), /Cannot check/);
    checkFailed = false;
    await reboot();
    assert.deepEqual(reboots, ['sudo /sbin/reboot']);
});
it('warns when the daily reboot operation check fails', async () => {
    checkFailed = true;
    warnings.length = 0;
    reboots.length = 0;
    try {
        assert.ok(dailyJob);
        await dailyJob();
        assert.equal(reboots.length, 0);
        assert.ok(warnings.some(message => /Skipping daily reboot.*Cannot check/.test(message)));
    }
    finally {
        checkFailed = false;
    }
});
//# sourceMappingURL=reboot.test.js.map