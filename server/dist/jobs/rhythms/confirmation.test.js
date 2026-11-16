import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bridgeDropouts, confirmationAt, coolStartOverride, presenceRun, stepStart, upEarlyDue, } from './confirmation.js';
const MINUTE = 60_000;
const STALE = 5 * MINUTE;
const t = (hhmm, day = '2026-09-29') => Date.parse(`${day}T${hhmm}:00-07:00`);
const iso = (ms) => new Date(ms).toISOString();
const BEDTIME = new Date(t('22:45'));
const side = (present, changedAt, updatedAt) => ({
    present, stateChangedAt: iso(changedAt), lastUpdatedAt: iso(updatedAt),
});
const snapshot = (left, right = { present: false }) => ({ left, right });
const presentSince = (since) => ({ known: true, presentSince: since, absentSince: null });
const absentSince = (since) => ({ known: true, presentSince: null, absentSince: since });
const UNKNOWN = { known: false, presentSince: null, absentSince: null };
// Replays one run function minute by minute and returns the final state.
function replay(runAt, from, to, firstSightAt = from) {
    let state = { status: 'watching' };
    for (let now = from; now <= to; now += MINUTE) {
        state = stepStart(state, { run: runAt(now), bedtime: BEDTIME, now, firstSight: now === firstSightAt });
    }
    return state;
}
describe('presenceRun', () => {
    const now = t('23:00');
    it('is unknown before the first report', () => {
        assert.deepEqual(presenceRun(snapshot({ present: false }), ['left'], now, STALE), UNKNOWN);
    });
    it('is unknown when the last report is more than five minutes old', () => {
        assert.deepEqual(presenceRun(snapshot(side(true, t('22:00'), now - 6 * MINUTE)), ['left'], now, STALE), UNKNOWN);
    });
    it('starts a present run at the last state change', () => {
        assert.deepEqual(presenceRun(snapshot(side(true, t('22:40'), now)), ['left'], now, STALE), presentSince(t('22:40')));
    });
    it('ignores the other side unless it counts', () => {
        const both = snapshot(side(false, t('22:30'), now), side(true, t('22:10'), now));
        assert.deepEqual(presenceRun(both, ['left'], now, STALE), absentSince(t('22:30')));
        assert.deepEqual(presenceRun(both, ['left', 'right'], now, STALE), presentSince(t('22:10')));
    });
    it('takes the earliest present side and the latest exit', () => {
        const present = snapshot(side(true, t('22:40'), now), side(true, t('22:20'), now));
        assert.deepEqual(presenceRun(present, ['left', 'right'], now, STALE), presentSince(t('22:20')));
        const absent = snapshot(side(false, t('22:40'), now), side(false, t('22:50'), now));
        assert.deepEqual(presenceRun(absent, ['left', 'right'], now, STALE), absentSince(t('22:50')));
    });
    it('reads only the fresh side when the other is stale', () => {
        const stale = now - 6 * MINUTE;
        const stalePresent = snapshot(side(true, t('22:10'), stale), side(false, t('22:40'), now));
        assert.deepEqual(presenceRun(stalePresent, ['left', 'right'], now, STALE), absentSince(t('22:40')));
        const bothPresent = snapshot(side(true, t('22:10'), stale), side(true, t('22:30'), now));
        assert.deepEqual(presenceRun(bothPresent, ['left', 'right'], now, STALE), presentSince(t('22:30')));
    });
});
describe('bridgeDropouts', () => {
    // Feeds minute ticks through the bridge and returns the run seen at the last one.
    function bridged(runAt, from, to) {
        let kept = null;
        let run = UNKNOWN;
        for (let now = from; now <= to; now += MINUTE) {
            ({ run, kept } = bridgeDropouts(kept, runAt(now), now));
        }
        return run;
    }
    const gap = (back) => (now) => {
        if (now < t('22:49'))
            return presentSince(t('22:40'));
        if (now < t(back))
            return absentSince(t('22:49'));
        return presentSince(t(back));
    };
    it('keeps the run start through an absence of 3 minutes or less', () => {
        assert.deepEqual(bridged(gap('22:51'), t('22:30'), t('22:55')), presentSince(t('22:40')));
        assert.deepEqual(bridged(gap('22:52'), t('22:30'), t('22:55')), presentSince(t('22:40')));
    });
    it('restarts the run after a longer absence', () => {
        assert.deepEqual(bridged(gap('22:53'), t('22:30'), t('22:55')), presentSince(t('22:53')));
    });
    it('passes absence through, so nothing confirms during a gap', () => {
        assert.deepEqual(bridged(gap('22:53'), t('22:30'), t('22:50')), absentSince(t('22:49')));
    });
    it('bridges a gap that fell between two ticks', () => {
        const run = (now) => presentSince(now < t('22:50') ? t('22:40') : t('22:50'));
        assert.deepEqual(bridged(run, t('22:30'), t('22:55')), presentSince(t('22:40')));
    });
    it('forgets the run when presence goes unknown', () => {
        const run = (now) => {
            if (now < t('22:49'))
                return presentSince(t('22:40'));
            if (now < t('22:51'))
                return UNKNOWN;
            return presentSince(t('22:51'));
        };
        assert.deepEqual(bridged(run, t('22:30'), t('22:55')), presentSince(t('22:51')));
    });
});
describe('confirmationAt', () => {
    it('counts presence that started early only from the window opening', () => {
        assert.equal(confirmationAt(presentSince(t('20:00')), BEDTIME, t('22:30')), t('22:05'));
    });
    it('needs 20 unbroken minutes', () => {
        assert.equal(confirmationAt(presentSince(t('22:40')), BEDTIME, t('22:59')), null);
        assert.equal(confirmationAt(presentSince(t('22:40')), BEDTIME, t('23:00')), t('23:00'));
    });
    it('never confirms after the cap', () => {
        assert.equal(confirmationAt(presentSince(t('00:30', '2026-09-30')), BEDTIME, t('01:00', '2026-09-30')), null);
    });
    describe('a run that ended since the last look', () => {
        const SECOND = 1000;
        const ended = (since, exitAt) => ({ since, lastPresent: exitAt - 30 * SECOND, exitAt, endedAt: exitAt });
        it('confirms once it reached 20 minutes before the exit', () => {
            const kept = ended(t('22:40') + 30 * SECOND, t('23:00') + 45 * SECOND);
            assert.equal(confirmationAt(absentSince(t('23:00') + 45 * SECOND), BEDTIME, t('23:01'), kept), t('23:00') + 30 * SECOND);
        });
        it('does not confirm a run that ended short of 20 minutes', () => {
            const kept = ended(t('22:40') + 30 * SECOND, t('23:00') + 15 * SECOND);
            assert.equal(confirmationAt(absentSince(t('23:00') + 15 * SECOND), BEDTIME, t('23:01'), kept), null);
        });
        it('counts it only from the window opening and never past the cap', () => {
            const early = ended(t('21:00'), t('22:10'));
            assert.equal(confirmationAt(absentSince(t('22:10')), BEDTIME, t('22:30'), early), t('22:05'));
            const tooEarly = ended(t('21:00'), t('21:50'));
            assert.equal(confirmationAt(absentSince(t('21:50')), BEDTIME, t('22:30'), tooEarly), null);
            const late = ended(t('00:30', '2026-09-30'), t('00:55', '2026-09-30'));
            assert.equal(confirmationAt(absentSince(t('00:55', '2026-09-30')), BEDTIME, t('01:00', '2026-09-30'), late), null);
        });
        it('ignores a kept run that has not ended, and unknown presence', () => {
            const running = { since: t('22:00'), lastPresent: t('22:30'), exitAt: null };
            assert.equal(confirmationAt(absentSince(t('22:31')), BEDTIME, t('22:32'), running), null);
            assert.equal(confirmationAt(UNKNOWN, BEDTIME, t('23:30'), ended(t('22:00'), t('22:30'))), null);
        });
    });
});
describe('stepStart', () => {
    it('runs on the clock when presence is unknown at bedtime', () => {
        const state = replay(() => UNKNOWN, t('21:45'), t('22:50'));
        assert.deepEqual(state, { status: 'decided', coolStart: BEDTIME, confirmedAt: null, reason: 'unknown' });
    });
    it('keeps the clock when presence confirmed before bedtime', () => {
        const state = replay(() => presentSince(t('20:00')), t('21:45'), t('22:50'));
        assert.deepEqual(state, { status: 'decided', coolStart: BEDTIME, confirmedAt: new Date(t('22:05')), reason: 'confirmed' });
    });
    it('waits after bedtime, then delays the cool-down to the confirmation', () => {
        const run = (now) => (now >= t('22:40') ? presentSince(t('22:40')) : absentSince(t('19:00')));
        assert.deepEqual(replay(run, t('21:45'), t('22:50')), { status: 'waiting' });
        assert.deepEqual(replay(run, t('21:45'), t('23:05')), {
            status: 'decided', coolStart: new Date(t('23:00')), confirmedAt: new Date(t('23:00')), reason: 'confirmed',
        });
    });
    it('restarts the count after a break', () => {
        const run = (now) => {
            if (now < t('22:40'))
                return absentSince(t('19:00'));
            if (now < t('22:50'))
                return presentSince(t('22:40'));
            if (now < t('22:55'))
                return absentSince(t('22:50'));
            return presentSince(t('22:55'));
        };
        const state = replay(run, t('21:45'), t('23:20'));
        assert.deepEqual(state, { status: 'decided', coolStart: new Date(t('23:15')), confirmedAt: new Date(t('23:15')), reason: 'confirmed' });
    });
    it('starts at the cap when nothing confirms within two hours', () => {
        // Ten minutes in bed, ten minutes out, all night.
        const run = (now) => {
            const since = now - (now % (10 * MINUTE));
            return Math.floor(now / (10 * MINUTE)) % 2 === 0 ? presentSince(since) : absentSince(since);
        };
        const state = replay(run, t('21:45'), t('00:50', '2026-09-30'));
        assert.deepEqual(state, { status: 'decided', coolStart: new Date(t('00:45', '2026-09-30')), confirmedAt: null, reason: 'cap' });
    });
    it('a late entry that cannot confirm before the cap still starts at the cap', () => {
        const entry = t('00:30', '2026-09-30');
        const run = (now) => (now >= entry ? presentSince(entry) : absentSince(t('19:00')));
        const state = replay(run, t('21:45'), t('01:00', '2026-09-30'));
        assert.equal(state.status === 'decided' && state.reason, 'cap');
    });
    it('starts cooling from now when presence goes stale while waiting', () => {
        const run = (now) => (now < t('23:10') ? absentSince(t('19:00')) : UNKNOWN);
        const state = replay(run, t('21:45'), t('23:15'));
        assert.deepEqual(state, { status: 'decided', coolStart: new Date(t('23:10')), confirmedAt: null, reason: 'stale' });
    });
    it('keeps a decision when presence goes stale later', () => {
        const run = (now) => (now < t('23:30') ? presentSince(t('22:40')) : UNKNOWN);
        const state = replay(run, t('21:45'), t('23:45'));
        assert.equal(state.status === 'decided' && state.reason, 'confirmed');
        assert.equal(state.status === 'decided' && state.coolStart.getTime(), t('23:00'));
    });
    it('uses the clock when first seen after bedtime', () => {
        const state = replay(() => presentSince(t('23:00')), t('23:30'), t('23:40'));
        assert.deepEqual(state, { status: 'decided', coolStart: BEDTIME, confirmedAt: null, reason: 'not-observed' });
    });
    it('does not join a short entry between two ticks to a run that ended earlier', () => {
        // In bed 22:30:20 to 22:46:49, out, back 22:51:09 to 22:51:57 (between two looks), out again.
        // Seen on a real night: the run lasted 16.5 minutes and must not read as 21.6.
        const SECOND = 1000;
        const runAt = (now) => {
            if (now < t('22:30') + 20 * SECOND)
                return absentSince(t('19:00'));
            if (now < t('22:46') + 49 * SECOND)
                return presentSince(t('22:30') + 20 * SECOND);
            if (now < t('22:51') + 9 * SECOND)
                return absentSince(t('22:46') + 49 * SECOND);
            if (now < t('22:51') + 57 * SECOND)
                return presentSince(t('22:51') + 9 * SECOND);
            return absentSince(t('22:51') + 57 * SECOND);
        };
        let state = { status: 'watching' };
        let kept = null;
        for (let now = t('21:45'); now <= t('23:00'); now += MINUTE) {
            const bridged = bridgeDropouts(kept, runAt(now), now);
            kept = bridged.kept;
            state = stepStart(state, { run: bridged.run, kept, bedtime: BEDTIME, now, firstSight: now === t('21:45') });
        }
        assert.deepEqual(state, { status: 'waiting' });
    });
    it('confirms a run that reached 20 minutes and ended between two ticks', () => {
        // Present 22:40:30 to 23:00:45, looked at on the minute through bridgeDropouts as the controller does.
        const entry = t('22:40') + 30_000;
        const exit = t('23:00') + 45_000;
        const runAt = (now) => (now < entry ? absentSince(t('19:00')) : now < exit ? presentSince(entry) : absentSince(exit));
        let state = { status: 'watching' };
        let kept = null;
        for (let now = t('21:45'); now <= t('23:05'); now += MINUTE) {
            const bridged = bridgeDropouts(kept, runAt(now), now);
            kept = bridged.kept;
            state = stepStart(state, { run: bridged.run, kept, bedtime: BEDTIME, now, firstSight: now === t('21:45') });
        }
        assert.deepEqual(state, {
            status: 'decided', coolStart: new Date(t('23:00') + 30_000), confirmedAt: new Date(t('23:00') + 30_000), reason: 'confirmed',
        });
    });
    it('does nothing before the window opens', () => {
        const state = stepStart({ status: 'watching' }, { run: UNKNOWN, bedtime: BEDTIME, now: t('21:00'), firstSight: true });
        assert.deepEqual(state, { status: 'watching' });
    });
});
describe('coolStartOverride', () => {
    it('holds the curve at the cap while waiting', () => {
        assert.equal(coolStartOverride({ status: 'watching' }, BEDTIME), undefined);
        assert.equal(coolStartOverride({ status: 'waiting' }, BEDTIME)?.getTime(), t('00:45', '2026-09-30'));
        const decided = { status: 'decided', coolStart: new Date(t('23:00')), confirmedAt: null, reason: 'stale' };
        assert.equal(coolStartOverride(decided, BEDTIME)?.getTime(), t('23:00'));
    });
});
describe('upEarlyDue', () => {
    const wake = new Date(t('06:30', '2026-09-30'));
    const at = (hhmm) => t(hhmm, '2026-09-30');
    it('fires after 30 unbroken minutes of absence inside the window', () => {
        assert.equal(upEarlyDue(absentSince(at('05:20')), wake, at('05:49')), false);
        assert.equal(upEarlyDue(absentSince(at('05:20')), wake, at('05:50')), true);
    });
    it('counts absence only from the window opening', () => {
        assert.equal(upEarlyDue(absentSince(at('03:00')), wake, at('05:29')), false);
        assert.equal(upEarlyDue(absentSince(at('03:00')), wake, at('05:30')), true);
    });
    it('never fires on unknown presence, presence, or after wake', () => {
        assert.equal(upEarlyDue(UNKNOWN, wake, at('06:00')), false);
        assert.equal(upEarlyDue(presentSince(at('05:00')), wake, at('06:00')), false);
        assert.equal(upEarlyDue(absentSince(at('05:00')), wake, at('06:31')), false);
    });
});
//# sourceMappingURL=confirmation.test.js.map