import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import nodeSchedule from 'node-schedule';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-pause-resume-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
const deviceUpdates = [];
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: {
        updateDeviceStatus: async (update) => {
            deviceUpdates.push(update);
        },
    },
});
let settingsDB;
let schedulePauseResume;
let clearEndedPause;
let PAUSE_RESUME_DELAY_MS;
let schedulePowerOn;
before(async () => {
    ({ default: settingsDB } = await import('../db/settings.js'));
    ({ schedulePauseResume, clearEndedPause, PAUSE_RESUME_DELAY_MS } = await import('./pauseResume.js'));
    ({ schedulePowerOn } = await import('./powerScheduler.js'));
});
const HOUR = 60 * 60 * 1000;
// node-schedule only arms jobs in the future, so these use the real clock.
const inHours = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
async function setPause(side, active, expiresAt = '') {
    await settingsDB.read();
    settingsDB.data[side].scheduleOverrides.pause = { active, expiresAt };
    await settingsDB.write();
}
async function storedPause(side) {
    await settingsDB.read();
    return settingsDB.data[side].scheduleOverrides.pause;
}
beforeEach(async () => {
    deviceUpdates.length = 0;
    Object.keys(nodeSchedule.scheduledJobs).forEach((name) => nodeSchedule.cancelJob(name));
    await settingsDB.read();
    settingsDB.data.timeZone = 'UTC';
    for (const side of ['left', 'right']) {
        settingsDB.data[side].awayMode = false;
        settingsDB.data[side].scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
        settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
    }
    await settingsDB.write();
});
after(() => {
    Object.keys(nodeSchedule.scheduledJobs).forEach((name) => nodeSchedule.cancelJob(name));
    rmSync(dataFolder, { recursive: true, force: true });
});
describe('schedulePauseResume', () => {
    it('arms a resume job a minute after the pause end', async () => {
        const expiresAt = inHours(2);
        await setPause('left', true, expiresAt);
        schedulePauseResume(settingsDB.data, 'left');
        const job = nodeSchedule.scheduledJobs['left-pause-resume'];
        assert.ok(job, 'no resume job was scheduled');
        assert.equal(PAUSE_RESUME_DELAY_MS, 60 * 1000);
        assert.equal(job.nextInvocation()?.getTime(), Date.parse(expiresAt) + PAUSE_RESUME_DELAY_MS);
        assert.equal(nodeSchedule.scheduledJobs['right-pause-resume'], undefined);
    });
    it('keeps the one minute delay when rebuilt just after the pause ends', async () => {
        const expiresAt = new Date(Date.now() - 30_000).toISOString();
        await setPause('left', true, expiresAt);
        schedulePauseResume(settingsDB.data, 'left');
        assert.equal(nodeSchedule.scheduledJobs['left-pause-resume'].nextInvocation()?.getTime(), Date.parse(expiresAt) + PAUSE_RESUME_DELAY_MS);
        assert.equal((await storedPause('left')).active, true);
    });
    it('arms nothing for an open-ended or inactive pause', async () => {
        await setPause('left', true, '');
        await setPause('right', false, inHours(2));
        schedulePauseResume(settingsDB.data, 'left');
        schedulePauseResume(settingsDB.data, 'right');
        assert.deepEqual(Object.keys(nodeSchedule.scheduledJobs), []);
    });
    it('clears the pause when the job fires outside a scheduled night', async () => {
        const expiresAt = inHours(2);
        await setPause('left', true, expiresAt);
        schedulePauseResume(settingsDB.data, 'left');
        await nodeSchedule.scheduledJobs['left-pause-resume'].invoke();
        assert.deepEqual(await storedPause('left'), { active: false, expiresAt: '' });
        assert.deepEqual(deviceUpdates, []);
    });
    it('keeps a newer pause saved after the job was armed', async () => {
        await setPause('left', true, inHours(2));
        schedulePauseResume(settingsDB.data, 'left');
        const newer = inHours(5);
        await setPause('left', true, newer);
        await nodeSchedule.scheduledJobs['left-pause-resume'].invoke();
        assert.deepEqual(await storedPause('left'), { active: true, expiresAt: newer });
    });
    it('keeps the pause readable at the end so an alarm due then stays silent', async () => {
        const expiresAt = inHours(2);
        await setPause('left', true, expiresAt);
        schedulePauseResume(settingsDB.data, 'left');
        const fireAt = nodeSchedule.scheduledJobs['left-pause-resume'].nextInvocation()?.getTime() ?? 0;
        assert.ok(fireAt > Date.parse(expiresAt), 'the clear is due at or before the pause end');
    });
    it('resolves false without throwing when the settings write fails', async (t) => {
        const expiresAt = inHours(2);
        await setPause('left', true, expiresAt);
        t.mock.method(settingsDB.adapter, 'write', async () => { throw new Error('disk full'); });
        assert.equal(await clearEndedPause('left', expiresAt), false);
        t.mock.restoreAll();
        assert.deepEqual(await storedPause('left'), { active: true, expiresAt });
    });
    for (const [label, expiresAt] of [['already ended', inHours(-1)], ['cannot be read', 'not a date']]) {
        it(`ends a pause whose end ${label} through a job a second away, not inline`, async () => {
            await setPause('left', true, expiresAt);
            const before = Date.now();
            schedulePauseResume(settingsDB.data, 'left');
            assert.equal((await storedPause('left')).active, true);
            const job = nodeSchedule.scheduledJobs['left-pause-resume'];
            const due = job.nextInvocation()?.getTime() ?? 0;
            assert.ok(due >= before + 1000 && due <= Date.now() + 1000, `due ${due - before} ms after the rebuild`);
            await job.invoke();
            assert.deepEqual(await storedPause('left'), { active: false, expiresAt: '' });
        });
    }
    it('lets the next scheduled event run after the resume', async () => {
        await setPause('left', true, inHours(2));
        schedulePowerOn(settingsDB.data, 'left', 'monday', { on: '21:00', off: '07:00', enabled: true, onTemperature: 82 });
        schedulePauseResume(settingsDB.data, 'left');
        await nodeSchedule.scheduledJobs['left-monday-21:00-power-on'].invoke();
        assert.deepEqual(deviceUpdates, []);
        await nodeSchedule.scheduledJobs['left-pause-resume'].invoke();
        await nodeSchedule.scheduledJobs['left-monday-21:00-power-on'].invoke();
        assert.deepEqual(deviceUpdates, [{ left: { isOn: true, targetTemperatureF: 82 } }]);
    });
});
//# sourceMappingURL=pauseResume.test.js.map