import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-cover-restore-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let restore;
before(async () => {
    moment.tz.setDefault('UTC');
    restore = await import('./coverRestore.js');
});
beforeEach(() => restore.resetCoverRestore());
const NOW = Date.parse('2026-01-01T03:00:00Z');
const MIN = 60_000;
const silent = { kind: 'silent', side: 'right', since: NOW - 15 * MIN };
const clear = (overrides = {}) => ({
    verdict: silent, now: NOW, podFive: true, frankenConnected: true, alarmNear: false, priming: false,
    operationBusy: false, lastAttemptAt: null, triedThisEpisode: false, source: 'button', ...overrides,
});
describe('restoreBlocker', () => {
    it('allows a restart when nothing blocks it', () => {
        assert.equal(restore.restoreBlocker(clear()), null);
        assert.equal(restore.restoreBlocker(clear({ source: 'auto' })), null);
    });
    it('blocks with each guard in order', () => {
        const notOffered = 'Restarting the cover service is not offered on this Pod.';
        assert.equal(restore.restoreBlocker(clear({ podFive: false, alarmNear: true })), notOffered);
        assert.equal(restore.restoreBlocker(clear({ frankenConnected: false })), notOffered);
        assert.equal(restore.restoreBlocker(clear({ verdict: { kind: 'bothSilent', since: NOW }, alarmNear: true })), '');
        const alarm = 'Not while an alarm is ringing or due in the next 10 minutes.';
        assert.equal(restore.restoreBlocker(clear({ alarmNear: true, priming: true })), alarm);
        assert.equal(restore.restoreBlocker(clear({ alarmNear: 'unknown' })), alarm);
        assert.equal(restore.restoreBlocker(clear({ priming: true, operationBusy: true })), 'Not while the Pod is priming.');
        assert.equal(restore.restoreBlocker(clear({ priming: 'unknown' })), 'Not while the Pod is priming.');
        assert.equal(restore.restoreBlocker(clear({ operationBusy: true })), 'Not while an update, rollback or restart is under way.');
    });
    it('holds the hourly limit', () => {
        assert.equal(restore.restoreBlocker(clear({ lastAttemptAt: NOW - 59 * MIN })), 'Restarted at 2:01 AM. It can run again after 3:01 AM.');
        assert.equal(restore.restoreBlocker(clear({ lastAttemptAt: NOW - 61 * MIN })), null);
    });
    it('says a restart did not help once the side stays silent 10 minutes after it', () => {
        const note = 'The restart at 2:45 AM did not bring it back. Restart the Pod from Settings.';
        const tried = { triedThisEpisode: true, lastAttemptAt: NOW - 15 * MIN };
        assert.equal(restore.restoreBlocker(clear({ ...tried, source: 'auto' })), note);
        assert.equal(restore.restoreBlocker(clear(tried)), note);
        // Inside the 10 minutes the button shows the hourly note instead.
        assert.match(restore.restoreBlocker(clear({ triedThisEpisode: true, lastAttemptAt: NOW - 5 * MIN })) ?? '', /^Restarted at /);
        // Auto never tries twice in one episode, even past the hour.
        assert.equal(restore.restoreBlocker(clear({ triedThisEpisode: true, lastAttemptAt: NOW - 90 * MIN, source: 'auto' })), 'The restart at 1:30 AM did not bring it back. Restart the Pod from Settings.');
    });
});
// A stand-in for the Pod: the stamp moves when the script runs.
function fakePod(overrides = {}, { autoOn = false, fails = false } = {}) {
    let stamp = null;
    const runs = [];
    return {
        runs,
        deps: {
            gather: async (verdict, source) => clear({
                verdict, source, lastAttemptAt: stamp, ...overrides, now: Date.now(),
            }),
            run: async () => {
                runs.push(Date.now());
                stamp = Date.now();
                if (fails)
                    throw new Error('restart failed');
            },
            autoOn: async () => autoOn,
            hold: async (work) => { await work(); },
        },
        age: (ms) => { if (stamp !== null)
            stamp -= ms; },
    };
}
describe('evaluateRestore', () => {
    it('reports nothing for a healthy cover', async () => {
        const pod = fakePod();
        assert.equal(await restore.evaluateRestore({ kind: 'ok' }, pod.deps), null);
        assert.equal(await restore.evaluateRestore({ kind: 'noRecords' }, pod.deps), null);
    });
    it('never runs when both sides are silent', async () => {
        const pod = fakePod({}, { autoOn: true });
        assert.deepEqual(await restore.evaluateRestore({ kind: 'bothSilent', since: NOW }, pod.deps), { available: false, note: '' });
        assert.deepEqual(pod.runs, []);
    });
    it('with the switch off offers the button and never runs on its own', async () => {
        const pod = fakePod();
        assert.deepEqual(await restore.evaluateRestore(silent, pod.deps), { available: true, note: '' });
        assert.deepEqual(pod.runs, []);
    });
    it('with the switch on runs once per episode', async () => {
        const pod = fakePod({}, { autoOn: true });
        const after = await restore.evaluateRestore(silent, pod.deps);
        assert.equal(pod.runs.length, 1);
        assert.equal(after?.available, false);
        assert.match(after?.note ?? '', /^Restarted at /);
        pod.age(2 * 60 * MIN);
        await restore.evaluateRestore(silent, pod.deps);
        assert.equal(pod.runs.length, 1, 'not again in the same episode');
        // The side reports again, then goes silent anew.
        await restore.evaluateRestore({ kind: 'ok' }, pod.deps);
        await restore.evaluateRestore(silent, pod.deps);
        assert.equal(pod.runs.length, 2);
    });
    it('counts a failed run as tried', async () => {
        const pod = fakePod({}, { autoOn: true, fails: true });
        await restore.evaluateRestore(silent, pod.deps);
        pod.age(2 * 60 * MIN);
        await restore.evaluateRestore(silent, pod.deps);
        assert.equal(pod.runs.length, 1);
    });
    it('does not run on its own near an alarm', async () => {
        const pod = fakePod({ alarmNear: 'unknown' }, { autoOn: true });
        assert.deepEqual(await restore.evaluateRestore(silent, pod.deps), { available: false, note: 'Not while an alarm is ringing or due in the next 10 minutes.' });
        assert.deepEqual(pod.runs, []);
    });
});
describe('restoreCover', () => {
    it('refuses with the note when blocked, and when no side is silent', async () => {
        const pod = fakePod({ priming: true });
        await assert.rejects(restore.restoreCover('button', pod.deps, silent), /Not while the Pod is priming\./);
        await assert.rejects(restore.restoreCover('button', pod.deps, { kind: 'ok' }), /nothing to restart/);
        assert.deepEqual(pod.runs, []);
    });
    it('runs from the button and then holds it for the hour', async () => {
        const pod = fakePod();
        await restore.restoreCover('button', pod.deps, silent);
        assert.equal(pod.runs.length, 1);
        await assert.rejects(restore.restoreCover('button', pod.deps, silent), /^Error: Restarted at|Restarted at/);
        assert.equal(pod.runs.length, 1);
    });
});
it('does not count a restart the operation hold refused as tried', async () => {
    restore.resetCoverRestore();
    const pod = fakePod();
    const silent = { kind: 'silent', side: 'left', since: Date.now() - 20 * 60_000 };
    await assert.rejects(restore.restoreCover('button', { ...pod.deps, hold: async () => { throw new Error('An update is running'); } }, silent), /An update is running/);
    assert.equal(pod.runs.length, 0);
    await restore.restoreCover('button', pod.deps, silent);
    assert.equal(pod.runs.length, 1);
});
it('remembers a restart that did not help across a gap in the records', async () => {
    restore.resetCoverRestore();
    const pod = fakePod({}, { autoOn: true });
    const silent = { kind: 'silent', side: 'left', since: Date.now() - 20 * 60_000 };
    await restore.evaluateRestore(silent, pod.deps);
    assert.equal(pod.runs.length, 1);
    await restore.evaluateRestore({ kind: 'ok', stale: true }, pod.deps);
    pod.age(2 * 60 * 60_000);
    await restore.evaluateRestore(silent, pod.deps);
    assert.equal(pod.runs.length, 1, 'no second automatic restart');
});
//# sourceMappingURL=coverRestore.test.js.map