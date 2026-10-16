import { EventEmitter } from 'node:events';
import schedule from 'node-schedule';
import { wait } from '../8sleep/promises.js';
import { isRebuilding } from './rebuildState.js';
import { noteAlarmFinished, noteAlarmStarted, noteMissedAlarm } from './alarmLedger.js';
// Tracks scheduled alarms per side from the moment their job fires until
// they stop ringing, so a power-off in the same minute can let them ring
// first. Without this, whichever job node-schedule ran first won: a power-off
// that ran first left the alarm to find the side off and skip.
// A scheduled alarm may wait out a hardware reconnect, but one that would
// start more than this after its due time is dropped rather than
// vibrating long after it.
export const ALARM_LATE_LIMIT_MS = 3 * 60_000;
// A due alarm job normally starts within milliseconds of the power-off.
const ALARM_START_WAIT_MS = 60_000;
// Longest a power-off waits for ringing alarms: the 300 s alarm maximum plus
// the time a scheduled alarm may spend reaching the hardware.
const ALARM_RING_WAIT_MS = 8 * 60_000;
const ringing = new Map();
const starts = new EventEmitter();
// Aborting ends every wait at once, so shutdown can turn sides off promptly.
let pendingWaits = new AbortController();
const isAlarmJob = (side, name) => name.startsWith(`${side}-`) && (name.endsWith('-alarm') || name.includes('-alarm-override-'));
const isRecurring = (name) => !name.includes('-alarm-override-') && !name.endsWith('-one-off-alarm');
// Runs a scheduled alarm job. run resolves to how long the alarm rings, or 0
// when it did not ring. Call it first thing in the job so a power-off never
// sees the job as neither due nor started.
export function trackAlarm(side, jobName, run) {
    const startedAt = new Date();
    const started = noteAlarmStarted(jobName, startedAt);
    const result = run();
    // A job that throws has not asked the Pod to ring.
    void result.then(() => noteAlarmFinished(started), () => {
        noteMissedAlarm(side, startedAt, 'error');
        noteAlarmFinished(started);
    });
    const done = result
        .then(ringMs => (ringMs > 0 ? wait(ringMs) : undefined))
        .catch(() => undefined);
    const sideRinging = ringing.get(side) ?? new Map();
    ringing.set(side, sideRinging);
    sideRinging.set(done, jobName);
    void done.finally(() => sideRinging.delete(done));
    starts.emit(jobName);
    return result.then(() => undefined);
}
// The alarm jobs of a night whose next run falls in [from, to).
function dueJobs(endsThisNight, from, to) {
    return Object.values(schedule.scheduledJobs).filter(job => {
        if (!endsThisNight(job.name))
            return false;
        const next = job.nextInvocation()?.getTime();
        return next !== undefined && next >= from && next < to;
    });
}
// Whether an alarm job of this side next runs within [from, to].
export function alarmDueBetween(side, from, to) {
    return dueJobs(name => isAlarmJob(side, name), from.getTime(), to.getTime() + 1).length > 0;
}
// Waits for the alarms of the night ending now, on this side, that are due in
// the same minute as a power-off or already ringing, to finish. The due check
// runs before the first await, while node-schedule still lists the alarm's
// pending run. endsThisNight picks the alarm jobs of that night.
export async function waitForNightAlarms(side, fireDate, endsThisNight) {
    const { signal } = pendingWaits;
    const minuteStart = Math.floor(fireDate.getTime() / 60_000) * 60_000;
    const due = dueJobs(endsThisNight, minuteStart, minuteStart + 60_000);
    const limits = [];
    const timed = (ms) => {
        const limit = wait(ms);
        limits.push(limit);
        return limit;
    };
    let onAbort = () => { };
    const aborted = new Promise(resolve => {
        onAbort = () => resolve();
        if (signal.aborted)
            resolve();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
    const waitForStarts = Promise.all(due.map(job => new Promise(resolve => {
        const limit = timed(ALARM_START_WAIT_MS);
        const done = () => {
            limit.cancel();
            starts.off(job.name, done);
            resolve();
        };
        void limit.then(done);
        starts.on(job.name, done);
    })));
    const waitForRinging = async () => {
        await waitForStarts;
        const running = [...(ringing.get(side) ?? [])].filter(([, name]) => endsThisNight(name)).map(([done]) => done);
        await Promise.race([Promise.all(running), timed(ALARM_RING_WAIT_MS)]);
    };
    try {
        await Promise.race([waitForRinging(), aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
        limits.forEach(limit => limit.cancel());
    }
}
// A recurring alarm belongs to the night named by day; an alarm on another
// day's schedule starts that day's night and is left out.
export function letAlarmsFinish(side, day, fireDate) {
    return waitForNightAlarms(side, fireDate, name => isAlarmJob(side, name)
        && (!isRecurring(name) || name.startsWith(`${side}-${day}-`)));
}
// The alarms of one Rhythms sleep, plus the per-night override and the
// one-time alarm, which can end any night.
export const rhythmNightAlarms = (side, sleepDate) => (name) => name.startsWith(`rhythm-${side}-${sleepDate}-alarm-`) || (isAlarmJob(side, name) && !isRecurring(name));
// Whether an alarm of this night is ringing or still due by `until`. While the
// jobs are re-planned the list is empty, so that counts as due.
export function nightAlarmPending(side, until, endsThisNight) {
    if (isRebuilding())
        return true;
    if ([...(ringing.get(side)?.values() ?? [])].some(endsThisNight))
        return true;
    return dueJobs(endsThisNight, -Infinity, until.getTime() + 1).length > 0;
}
// Ends every wait in progress, so the power-offs behind them go out at once.
export function abortAlarmWaits() {
    pendingWaits.abort();
    pendingWaits = new AbortController();
}
// Test isolation only: forget alarms whose ring timers a test never ran.
export function resetAlarmActivity() {
    ringing.clear();
}
//# sourceMappingURL=alarmActivity.js.map