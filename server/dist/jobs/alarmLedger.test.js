import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import nodeSchedule from 'node-schedule';
import { setRebuilding } from './rebuildState.js';
import { markCommandWritten } from '../8sleep/frankenErrors.js';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-alarm-ledger-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
const LEDGER = path.join(dataFolder, 'alarm-ledger.json');
let ledger;
let settingsDB;
let activity;
before(async () => {
    ledger = await import('./alarmLedger.js');
    activity = await import('./alarmActivity.js');
    ({ default: settingsDB } = await import('../db/settings.js'));
});
beforeEach(async () => {
    Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
    ledger.resetAlarmLedgerForTests();
    rmSync(LEDGER, { force: true, recursive: true });
    rmSync(`${LEDGER}.bad`, { force: true, recursive: true });
    await settingsDB.read();
    settingsDB.data.left.awayMode = false;
    settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
    await settingsDB.write();
});
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60 * 60_000);
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);
const writeLedger = (contents) => writeFileSync(LEDGER, JSON.stringify({ version: 1, started: [], missed: [], ...contents }));
describe('alarm job names', () => {
    it('recognises every kind of alarm job and nothing else', () => {
        const alarms = ['left-monday-06:30-0-alarm', 'right-alarm-override-07:00', 'left-one-off-alarm', 'rhythm-right-2026-10-05-alarm-0630-0'];
        for (const name of alarms) {
            assert.equal(ledger.isAlarmJobName(name), true, name);
        }
        for (const name of ['left-monday-21:00-power-on', 'rhythm-left-2026-10-05-power-off-0700-0', 'daily-reboot-13:00']) {
            assert.equal(ledger.isAlarmJobName(name), false, name);
        }
    });
});
describe('heartbeat', () => {
    it('saves when the server was alive and the alarms due in the next day', () => {
        nodeSchedule.scheduleJob('left-one-off-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        nodeSchedule.scheduleJob('left-monday-21:00-power-on', new Date(Date.now() + 3_600_000), () => undefined);
        ledger.startAlarmLedger(new Date());
        ledger.alarmLedgerHeartbeat(new Date());
        const saved = JSON.parse(readFileSync(LEDGER, 'utf8'));
        assert.equal(saved.upcoming.length, 1);
        assert.equal(saved.upcoming[0].jobName, 'left-one-off-alarm');
        assert.equal(saved.upcoming[0].side, 'left');
    });
});
describe('alarms missed while the server was not running', () => {
    it('reports an alarm due after the last heartbeat', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [{ side: 'left', at: at(5).toISOString(), jobName: 'left-one-off-alarm' }] });
        const found = ledger.startAlarmLedger(at(10));
        assert.equal(found.length, 1);
        assert.equal(found[0].reason, 'not-running');
        assert.deepEqual(ledger.listMissedAlarms(at(10)).map(m => m.at), [at(5).toISOString()]);
    });
    it('does not report one that finished before the server stopped', () => {
        writeLedger({
            aliveAt: T0.toISOString(),
            upcoming: [{ side: 'left', at: at(5).toISOString(), jobName: 'left-one-off-alarm' }],
            started: [{ jobName: 'left-one-off-alarm', at: at(5).toISOString(), done: true }],
        });
        assert.equal(ledger.startAlarmLedger(at(10)).length, 0);
    });
    it('reports one that started but never finished as possibly not rung', () => {
        writeLedger({
            aliveAt: T0.toISOString(),
            upcoming: [{ side: 'left', at: at(5).toISOString(), jobName: 'left-one-off-alarm' }],
            started: [{ jobName: 'left-one-off-alarm', at: at(5).toISOString(), done: false }],
        });
        assert.deepEqual(ledger.startAlarmLedger(at(10)).map(m => m.reason), ['unconfirmed']);
    });
    it('trusts a start saved by a version that did not record finishing', () => {
        writeLedger({
            aliveAt: T0.toISOString(),
            upcoming: [{ side: 'left', at: at(5).toISOString(), jobName: 'left-one-off-alarm' }],
            started: [{ jobName: 'left-one-off-alarm', at: at(5).toISOString() }],
        });
        assert.equal(ledger.startAlarmLedger(at(10)).length, 0);
    });
    it('does not report one still in the future, or one due before the last heartbeat', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [
                { side: 'left', at: at(30).toISOString(), jobName: 'left-one-off-alarm' },
                { side: 'left', at: at(-5).toISOString(), jobName: 'left-monday-06:30-0-alarm' },
            ] });
        assert.equal(ledger.startAlarmLedger(at(10)).length, 0);
    });
    it('does not report a side in away mode', async () => {
        settingsDB.data.left.awayMode = true;
        await settingsDB.write();
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [{ side: 'left', at: at(5).toISOString(), jobName: 'left-one-off-alarm' }] });
        assert.equal(ledger.startAlarmLedger(at(10)).length, 0);
    });
    it('starts clean from an unreadable file', () => {
        writeFileSync(LEDGER, '{not json');
        assert.deepEqual(ledger.startAlarmLedger(at(10)), []);
        assert.equal(existsSync(LEDGER), true);
    });
});
describe('missed alarms the server saw', () => {
    it('keeps one entry per alarm and reason, and dismisses by id', () => {
        ledger.startAlarmLedger(T0);
        ledger.noteMissedAlarm('right', at(1), 'late', at(4));
        ledger.noteMissedAlarm('right', at(1), 'late', at(4));
        const listed = ledger.listMissedAlarms(at(5));
        assert.equal(listed.length, 1);
        ledger.dismissMissedAlarms([listed[0].id]);
        assert.equal(ledger.listMissedAlarms(at(5)).length, 0);
    });
    it('forgets entries older than a week', () => {
        ledger.startAlarmLedger(T0);
        ledger.noteMissedAlarm('left', at(0), 'failed', at(0));
        ledger.noteMissedAlarm('left', at(8 * 24 * 60), 'failed', at(8 * 24 * 60));
        assert.equal(ledger.listMissedAlarms(at(8 * 24 * 60)).length, 1);
    });
});
const saved = () => JSON.parse(readFileSync(LEDGER, 'utf8'));
const upcoming = (jobName, minutes, side = 'left') => ({ side, at: at(minutes).toISOString(), jobName });
describe('why an alarm could not ring', () => {
    const named = (name) => Object.assign(new Error(name), { name });
    const written = (error) => {
        markCommandWritten(error);
        return error;
    };
    it('says late when the Pod answered too late, or did not answer before the alarm was sent', () => {
        for (const sending of [false, true]) {
            assert.equal(ledger.missedReasonForError(named('FrankenUnavailableError'), sending), 'late');
        }
        assert.equal(ledger.missedReasonForError(named('FrankenCommandTimeoutError'), false), 'late');
        assert.equal(ledger.missedReasonForError(named('FrankenConnectionClosedError'), false), 'late');
    });
    it('says unconfirmed for any error once the command was written to the Pod', () => {
        assert.equal(ledger.missedReasonForError(written(named('FrankenCommandTimeoutError')), true), 'unconfirmed');
        assert.equal(ledger.missedReasonForError(written(named('FrankenConnectionClosedError')), true), 'unconfirmed');
        assert.equal(ledger.missedReasonForError(written(new Error('socket reset')), true), 'unconfirmed');
    });
    it('says failed when the write did not reach the Pod, and late when the command timed out unsent', () => {
        assert.equal(ledger.missedReasonForError(new Error('write EPIPE'), true), 'failed');
        assert.equal(ledger.missedReasonForError(named('FrankenConnectionClosedError'), true), 'failed');
        assert.equal(ledger.missedReasonForError(named('FrankenCommandTimeoutError'), true), 'late');
    });
    it('says late for a connection reset on the side check, which is the connection dropping', () => {
        for (const code of ['ECONNRESET', 'EPIPE']) {
            assert.equal(ledger.missedReasonForError(Object.assign(new Error('read'), { code }), false), 'late');
        }
        assert.equal(ledger.missedReasonForError(Object.assign(new Error('write'), { code: 'EPIPE' }), true), 'failed');
    });
    it('says error when this server failed before the Pod was asked', () => {
        assert.equal(ledger.missedReasonForError(new Error('disk full'), false), 'error');
    });
});
describe('alarms kept across a restart that has not planned its jobs', () => {
    it('keeps the saved alarms until the jobs are planned, so a crash before then still reports them', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 30)] });
        assert.equal(ledger.startAlarmLedger(at(10)).length, 0);
        assert.equal(saved().upcoming.length, 1);
        ledger.resetAlarmLedgerForTests();
        const found = ledger.startAlarmLedger(at(40));
        assert.equal(found.length, 1);
        assert.equal(found[0].reason, 'not-running');
    });
    it('reports a saved alarm that fell due before planning finished', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 12)] });
        ledger.startAlarmLedger(at(10));
        ledger.alarmLedgerHeartbeat(new Date(at(12).getTime() + 2_000));
        assert.equal(ledger.listMissedAlarms(at(13)).length, 0, 'it is given a moment to start');
        assert.equal(saved().upcoming.length, 1, 'and stays saved meanwhile');
        ledger.alarmLedgerHeartbeat(at(14));
        assert.deepEqual(ledger.listMissedAlarms(at(14)).map(m => m.reason), ['not-running']);
        assert.equal(saved().upcoming.length, 0);
    });
    it('does not report one that started while the jobs were being planned', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 12)] });
        ledger.startAlarmLedger(at(10));
        ledger.noteAlarmStarted('left-one-off-alarm', at(12));
        ledger.alarmLedgerHeartbeat(at(14));
        assert.equal(ledger.listMissedAlarms(at(14)).length, 0);
    });
    it('lets go of a saved future alarm once planning shows its job is gone', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 30)] });
        ledger.startAlarmLedger(at(10));
        ledger.alarmLedgerHeartbeat(at(11));
        assert.equal(saved().upcoming.length, 0);
        assert.equal(ledger.listMissedAlarms(at(40)).length, 0);
    });
});
describe('alarms an override silences', () => {
    it('leaves a silenced alarm out of the saved upcoming list', () => {
        nodeSchedule.scheduleJob('left-monday-06:30-0-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        nodeSchedule.scheduleJob('left-one-off-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        ledger.setAlarmSuppression('left-monday-06:30-0-alarm', () => true);
        ledger.startAlarmLedger(new Date());
        ledger.alarmLedgerHeartbeat(new Date());
        assert.deepEqual(saved().upcoming.map((item) => item.jobName), ['left-one-off-alarm']);
    });
});
describe('writes before the ledger is started', () => {
    it('dismissing keeps the saved alarms and missed entries', () => {
        const missed = { id: 'left-x-late', side: 'left', at: at(1).toISOString(), reason: 'late', recordedAt: at(2).toISOString() };
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 30)], missed: [missed] });
        ledger.dismissMissedAlarms(['nothing']);
        assert.equal(saved().upcoming.length, 1);
        assert.equal(saved().missed.length, 1);
        assert.equal(saved().aliveAt, T0.toISOString());
    });
    it('recording keeps what was already saved', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 30)] });
        ledger.noteMissedAlarm('right', at(1), 'late', at(2));
        assert.equal(saved().upcoming.length, 1);
        assert.equal(saved().missed.length, 1);
        assert.equal(ledger.startAlarmLedger(at(40)).length, 1);
    });
});
describe('a damaged ledger file', () => {
    const damaged = [
        ['upcoming that is not a list', { aliveAt: T0.toISOString(), upcoming: null }],
        ['started that is not a list', { aliveAt: T0.toISOString(), upcoming: [], started: null }],
        ['an alarm with an unknown side', { aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 5, 'middle')] }],
        ['a time that is not a date', { aliveAt: 'soon', upcoming: [] }],
    ];
    for (const [name, contents] of damaged) {
        it(`is kept aside and replaced by an empty ledger: ${name}`, () => {
            writeLedger(contents);
            assert.deepEqual(ledger.startAlarmLedger(at(10)), []);
            assert.equal(existsSync(`${LEDGER}.bad`), true);
            assert.doesNotThrow(() => ledger.noteAlarmStarted('left-one-off-alarm', at(10)));
            assert.doesNotThrow(() => ledger.noteMissedAlarm('left', at(10), 'late', at(10)));
            assert.equal(ledger.listMissedAlarms(at(10)).length, 1);
            rmSync(`${LEDGER}.bad`, { force: true });
        });
    }
    it('never stops an alarm from running', async () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [], started: null });
        ledger.startAlarmLedger(at(10));
        let ran = false;
        await activity.trackAlarm('left', 'left-one-off-alarm', async () => { ran = true; return 0; });
        assert.equal(ran, true);
        rmSync(`${LEDGER}.bad`, { force: true });
    });
    it('does not throw when the file cannot be read or replaced', () => {
        mkdirSync(LEDGER);
        assert.doesNotThrow(() => ledger.startAlarmLedger(at(10)));
        assert.doesNotThrow(() => ledger.noteAlarmStarted('left-one-off-alarm', at(10)));
        rmSync(LEDGER, { recursive: true, force: true });
        rmSync(`${LEDGER}.bad`, { recursive: true, force: true });
    });
    it('ignores a missed entry with a reason it does not know, without discarding the file', () => {
        const known = { id: 'a', side: 'left', at: at(1).toISOString(), reason: 'late', recordedAt: at(2).toISOString() };
        const unknown = { ...known, id: 'b', reason: 'from-a-newer-version' };
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [], missed: [known, unknown] });
        ledger.startAlarmLedger(at(10));
        assert.deepEqual(ledger.listMissedAlarms(at(10)).map(m => m.id), ['a']);
        assert.equal(existsSync(`${LEDGER}.bad`), false);
    });
});
describe('the heartbeat timer', () => {
    it('never throws, so it cannot reach the shutdown handler', (t) => {
        let tick;
        t.mock.method(globalThis, 'setInterval', ((callback) => {
            tick = callback;
            return { unref() { } };
        }));
        const job = nodeSchedule.scheduleJob('left-one-off-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        job.nextInvocation = () => { throw new Error('broken job'); };
        ledger.startAlarmLedger(new Date());
        ledger.alarmLedgerHeartbeat(new Date());
        assert.ok(tick);
        assert.doesNotThrow(() => tick?.());
    });
});
describe('the time the server was last alive', () => {
    it('still reports an alarm seen five seconds after its time when the server then stops', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 12)] });
        ledger.startAlarmLedger(at(10));
        ledger.alarmLedgerHeartbeat(new Date(at(12).getTime() + 5_000));
        ledger.resetAlarmLedgerForTests();
        const found = ledger.startAlarmLedger(at(20));
        assert.equal(found.length, 1);
    });
});
describe('a heartbeat while the jobs are being re-planned', () => {
    it('leaves the saved alarms alone, since the job list is empty then', (t) => {
        let tick;
        t.mock.method(globalThis, 'setInterval', ((callback) => {
            tick = callback;
            return { unref() { } };
        }));
        nodeSchedule.scheduleJob('left-one-off-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        ledger.startAlarmLedger(new Date());
        ledger.alarmLedgerHeartbeat(new Date());
        assert.equal(saved().upcoming.length, 1);
        nodeSchedule.cancelJob('left-one-off-alarm');
        setRebuilding(true);
        try {
            tick?.();
            assert.equal(saved().upcoming.length, 1);
        }
        finally {
            setRebuilding(false);
        }
        tick?.();
        assert.equal(saved().upcoming.length, 0);
    });
});
describe('a ledger file that cannot be read right now', () => {
    it('is left where it is, not moved aside, and not overwritten', () => {
        mkdirSync(LEDGER);
        ledger.startAlarmLedger(at(10));
        ledger.noteMissedAlarm('left', at(10), 'late', at(10));
        assert.equal(existsSync(`${LEDGER}.bad`), false);
        assert.equal(readdirSync(LEDGER).length, 0, 'the entry in its place is untouched');
    });
    it('is read again once before giving up', (t) => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 5)] });
        const original = fs.readFileSync;
        let calls = 0;
        t.mock.method(fs, 'readFileSync', ((...args) => {
            calls += 1;
            if (calls === 1)
                throw Object.assign(new Error('input/output error'), { code: 'EIO' });
            return original(...args);
        }));
        syncBuiltinESMExports();
        try {
            assert.equal(ledger.startAlarmLedger(at(10)).length, 1);
        }
        finally {
            t.mock.restoreAll();
            syncBuiltinESMExports();
        }
        assert.equal(existsSync(`${LEDGER}.bad`), false);
    });
});
describe('leaving for another version', () => {
    // A rollback, a downgrade or a switch hands the alarms to a version that
    // keeps no record of them, so coming back must not report them as missed.
    it('forgets the saved alarms, so they are not reported on the way back', () => {
        nodeSchedule.scheduleJob('left-one-off-alarm', at(70), () => undefined);
        ledger.startAlarmLedger(at(55));
        ledger.alarmLedgerHeartbeat(at(56));
        assert.equal(saved().upcoming.length, 1);
        ledger.leaveAlarmLedger();
        assert.deepEqual(saved().upcoming, []);
        // A heartbeat before the server stops does not save them again.
        ledger.alarmLedgerHeartbeat(at(57));
        assert.deepEqual(saved().upcoming, []);
        nodeSchedule.cancelJob('left-one-off-alarm');
        ledger.resetAlarmLedgerForTests();
        assert.deepEqual(ledger.startAlarmLedger(at(24 * 60)), []);
        assert.deepEqual(ledger.listMissedAlarms(at(24 * 60)), []);
    });
    it('also forgets saved alarms from before a restart that were still being judged', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 30)] });
        ledger.startAlarmLedger(at(10));
        ledger.leaveAlarmLedger();
        ledger.resetAlarmLedgerForTests();
        assert.deepEqual(ledger.startAlarmLedger(at(60)), []);
    });
    it('keeps the alarms already reported as missed', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 5)] });
        ledger.startAlarmLedger(at(10));
        ledger.leaveAlarmLedger();
        ledger.resetAlarmLedgerForTests();
        ledger.startAlarmLedger(at(60));
        assert.deepEqual(ledger.listMissedAlarms(at(60)).map(m => m.at), [at(5).toISOString()]);
    });
});
describe('an alarm job from start to finish', () => {
    const restart = (now) => {
        ledger.resetAlarmLedgerForTests();
        return ledger.startAlarmLedger(now);
    };
    const due = () => writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 5)] });
    it('is saved as started and then as finished', async () => {
        ledger.startAlarmLedger(at(1));
        await activity.trackAlarm('left', 'left-one-off-alarm', async () => 0);
        assert.deepEqual(saved().started.map((run) => run.done), [true]);
    });
    it('a server stopped while the job ran reports the alarm after the restart', () => {
        due();
        ledger.startAlarmLedger(at(1));
        void activity.trackAlarm('left', 'left-one-off-alarm', () => new Promise(() => undefined));
        // The started entry carries the job's real start time; match it to the saved alarm.
        const started = saved().started;
        writeLedger({
            aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 5)],
            started: started.map(run => ({ ...run, at: at(5).toISOString() })),
        });
        assert.deepEqual(restart(at(10)).map(m => m.reason), ['unconfirmed']);
    });
    // Due at 5:00, waiting for the Pod, a heartbeat at 5:30 and a crash at 5:40.
    it('a server that stops after a heartbeat while the job ran still reports the alarm', () => {
        ledger.startAlarmLedger(at(4));
        ledger.alarmLedgerHeartbeat(at(4));
        ledger.noteAlarmStarted('left-one-off-alarm', at(5));
        ledger.alarmLedgerHeartbeat(new Date(at(5).getTime() + 30_000));
        assert.deepEqual(restart(new Date(at(5).getTime() + 40_000)).map(m => m.reason), ['unconfirmed']);
    });
    it('a job that finished before the heartbeat is not kept for the next start', () => {
        ledger.startAlarmLedger(at(4));
        ledger.alarmLedgerHeartbeat(at(4));
        ledger.noteAlarmFinished(ledger.noteAlarmStarted('left-one-off-alarm', at(5)));
        ledger.alarmLedgerHeartbeat(new Date(at(5).getTime() + 30_000));
        assert.deepEqual(saved().upcoming, []);
        assert.deepEqual(restart(new Date(at(5).getTime() + 40_000)), []);
    });
    it('a job that is still running in this server is not reported', () => {
        writeLedger({ aliveAt: T0.toISOString(), upcoming: [upcoming('left-one-off-alarm', 12)] });
        ledger.startAlarmLedger(at(10));
        ledger.noteAlarmStarted('left-one-off-alarm', at(12));
        ledger.alarmLedgerHeartbeat(at(14));
        assert.equal(ledger.listMissedAlarms(at(14)).length, 0);
    });
    it('a job that fails before it reaches the Pod is reported as an error', async () => {
        ledger.startAlarmLedger(new Date());
        const failing = async () => { throw new Error('settings unreadable'); };
        await assert.rejects(activity.trackAlarm('left', 'rhythm-left-2026-10-05-alarm-0630-0', failing));
        assert.deepEqual(ledger.listMissedAlarms().map(m => m.reason), ['error']);
        assert.deepEqual(saved().started.map((run) => run.done), [true]);
    });
});
describe('heartbeats that change nothing but the time', () => {
    after(() => {
        Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
        ledger.resetAlarmLedgerForTests();
    });
    it('do not rewrite the file', () => {
        nodeSchedule.scheduleJob('left-one-off-alarm', new Date(Date.now() + 3_600_000), () => undefined);
        ledger.startAlarmLedger(new Date());
        ledger.alarmLedgerHeartbeat(new Date());
        const first = readFileSync(LEDGER, 'utf8');
        ledger.alarmLedgerHeartbeat(new Date(Date.now() + 60_000));
        assert.equal(readFileSync(LEDGER, 'utf8'), first);
        nodeSchedule.scheduleJob('right-one-off-alarm', new Date(Date.now() + 7_200_000), () => undefined);
        ledger.alarmLedgerHeartbeat(new Date(Date.now() + 120_000));
        assert.equal(saved().upcoming.length, 2);
    });
    it('still lists an alarm missed after skipped heartbeats', () => {
        nodeSchedule.scheduleJob('left-one-off-alarm', at(90), () => undefined);
        ledger.startAlarmLedger(at(60));
        ledger.alarmLedgerHeartbeat(at(61));
        ledger.alarmLedgerHeartbeat(at(62));
        assert.equal(saved().aliveAt, at(61).toISOString());
        ledger.resetAlarmLedgerForTests();
        const found = ledger.startAlarmLedger(at(100));
        assert.equal(found.length, 1);
        assert.equal(found[0].reason, 'not-running');
    });
});
//# sourceMappingURL=alarmLedger.test.js.map