import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';
// Settings on disk as the server finds them at boot: one pause ended while
// the server was down, the other is still running.
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-pause-startup-'));
mkdirSync(path.join(folder, 'lowdb'));
const ended = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const running = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
writeFileSync(path.join(folder, 'lowdb', 'settingsDB.json'), JSON.stringify({
    timeZone: 'UTC',
    left: { scheduleOverrides: { pause: { active: true, expiresAt: ended } } },
    right: { scheduleOverrides: { pause: { active: true, expiresAt: running } } },
}));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
mock.module('chokidar', { defaultExport: { watch: () => ({ on: () => undefined }) } });
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
    namedExports: { updateDeviceStatus: async () => { } },
});
// A resume that waits on the Pod for as long as the test runs.
const resumes = [];
const releases = [];
mock.module(new URL('./resumeSchedule.js', import.meta.url).href, {
    namedExports: {
        resumeSchedule: (side) => {
            resumes.push(side);
            return new Promise(resolve => releases.push(resolve));
        },
        stopScheduleResumes: () => { },
    },
});
after(() => {
    releases.forEach(release => release());
    Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
    rmSync(folder, { recursive: true, force: true });
});
const until = async (done, what) => {
    const deadline = Date.now() + 5000;
    while (!done()) {
        assert.ok(Date.now() < deadline, what);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
it('plans every job before an ended pause is cleared and resumed', async () => {
    const { default: status } = await import('../serverStatus.js');
    await import('./jobScheduler.js');
    await until(() => status.status.jobs.status === 'healthy' || status.status.jobs.status === 'failed', 'scheduler did not finish');
    assert.equal(status.status.jobs.status, 'healthy');
    assert.equal(schedule.scheduledJobs['right-pause-resume']?.nextInvocation()?.getTime(), Date.parse(running) + 60 * 1000);
    const settings = () => JSON.parse(readFileSync(path.join(folder, 'lowdb', 'settingsDB.json'), 'utf8'));
    await until(() => settings().left.scheduleOverrides.pause.active === false, 'the ended pause was not cleared');
    assert.deepEqual(settings().left.scheduleOverrides.pause, { active: false, expiresAt: '' });
    assert.deepEqual(settings().right.scheduleOverrides.pause, { active: true, expiresAt: running });
    await until(() => resumes.length === 1, 'the side was not resumed');
    assert.deepEqual(resumes, ['left']);
});
//# sourceMappingURL=jobSchedulerPause.test.js.map