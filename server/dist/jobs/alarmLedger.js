import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import schedule from 'node-schedule';
import { z } from 'zod';
import config from '../config.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { wasCommandWritten } from '../8sleep/frankenErrors.js';
import { isRebuilding } from './rebuildState.js';
import { isAlarmPaused } from './schedulePause.js';
const iso = z.string().refine(value => Number.isFinite(Date.parse(value)));
const side = z.enum(['left', 'right']);
const FileSchema = z.object({
    version: z.literal(1),
    aliveAt: iso.nullable().default(null),
    upcoming: z.array(z.object({ side, at: iso, jobName: z.string() })).default([]),
    started: z.array(z.object({ jobName: z.string(), at: iso, done: z.boolean().optional().catch(undefined) })).default([]),
    missed: z.array(z.unknown()).default([]),
});
const MissedSchema = z.object({
    id: z.string(), side, at: iso, reason: z.enum(['not-running', 'late', 'failed', 'unconfirmed', 'error', 'side-off']), recordedAt: iso,
});
const HORIZON_MS = 26 * 60 * 60_000;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const STARTED_MATCH_MS = 2 * 60_000;
// A saved alarm gets this long after its time to be seen starting.
const JUDGE_GRACE_MS = 10_000;
const MAX_MISSED = 20;
const MAX_STARTED = 50;
const HEARTBEAT_MS = 60_000;
// How long an unfinished job of this server is kept for the next start to judge.
const UNFINISHED_KEEP_MS = 60 * 60_000;
const ledgerFile = () => path.join(config.dbFolder, 'alarm-ledger.json');
const empty = () => ({ version: 1, aliveAt: null, upcoming: [], started: [], missed: [] });
let ledger = empty();
let loaded = false;
let running = false;
let planned = false;
// Saved alarms from before a restart that have not been judged yet.
let pending = [];
let timer;
// Jobs this server started, which settle themselves.
let startedHere = new Set();
const suppressions = new Map();
const messageOf = (error) => (error instanceof Error ? error.message : String(error));
// The ledger is bookkeeping: whatever goes wrong in it must never reach an
// alarm, a job plan or a route.
function guard(what, fallback, run) {
    try {
        return run();
    }
    catch (error) {
        logger.warn(`Alarm ledger ${what} failed: ${messageOf(error)}`);
        return fallback;
    }
}
export function isAlarmJobName(name) {
    return /^(left|right)-.+-alarm$/.test(name)
        || /^(left|right)-alarm-override-/.test(name)
        || /^rhythm-(left|right)-\d{4}-\d{2}-\d{2}-alarm-/.test(name);
}
const sideOf = (name) => (name.startsWith('right-') || name.startsWith('rhythm-right-') ? 'right' : 'left');
// Registers a test for a planned alarm job that is true while an override
// replaces it, so it is not saved as one that should ring.
export function setAlarmSuppression(jobName, suppressed) {
    suppressions.set(jobName, suppressed);
}
// Why an alarm that was meant to ring did not. sending is true once the
// alarm command was handed to the Pod. After it was fully written, whatever
// went wrong, the Pod may be ringing.
export function missedReasonForError(error, sending) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'FrankenUnavailableError')
        return 'late';
    const noAnswer = name === 'FrankenCommandTimeoutError';
    const code = error?.code;
    const dropped = name === 'FrankenConnectionClosedError' || code === 'ECONNRESET' || code === 'EPIPE';
    if (!sending)
        return noAnswer || dropped ? 'late' : 'error';
    if (wasCommandWritten(error))
        return 'unconfirmed';
    return noAnswer ? 'late' : 'failed';
}
function setAside(file, why) {
    logger.warn(`The alarm ledger could not be used (${why}); starting empty`);
    try {
        renameSync(file, `${file}.bad`);
    }
    catch (error) {
        logger.warn(`Could not move the alarm ledger aside: ${messageOf(error)}`);
    }
}
// Set when the file could not be read, so a good ledger on disk is never
// replaced by an empty one made in this run.
let unreadable = false;
// The ledger as last written, without aliveAt. With the same upcoming list a
// restart carries and judges the same alarms whatever aliveAt says, since each
// saved alarm is later than the aliveAt saved with it.
let savedShape;
const shape = () => JSON.stringify({ ...ledger, aliveAt: null });
function readLedgerFile(file) {
    for (let attempt = 1;; attempt += 1) {
        try {
            return readFileSync(file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            if (attempt < 2)
                continue;
            unreadable = true;
            logger.warn(`The alarm ledger could not be read, so it is left as it is: ${messageOf(error)}`);
            return undefined;
        }
    }
}
function load() {
    const file = ledgerFile();
    unreadable = false;
    const text = readLedgerFile(file);
    if (text === undefined)
        return empty();
    try {
        const parsed = FileSchema.parse(JSON.parse(text));
        // An entry from another version, with a reason this one does not know, is left out.
        const missed = parsed.missed.flatMap(item => {
            const entry = MissedSchema.safeParse(item);
            return entry.success ? [entry.data] : [];
        });
        return { ...parsed, missed };
    }
    catch (error) {
        setAside(file, messageOf(error));
        return empty();
    }
}
function ensureLoaded() {
    if (loaded)
        return;
    ledger = load();
    loaded = true;
}
function save() {
    if (unreadable)
        return;
    try {
        const file = ledgerFile();
        writeFileSync(`${file}.tmp`, JSON.stringify(ledger));
        renameSync(`${file}.tmp`, file);
        savedShape = shape();
    }
    catch (error) {
        logger.warn(`Could not save the alarm ledger: ${messageOf(error)}`);
    }
}
function upcomingAlarms(now, horizonMs = HORIZON_MS) {
    for (const name of suppressions.keys()) {
        if (!schedule.scheduledJobs[name])
            suppressions.delete(name);
    }
    return Object.values(schedule.scheduledJobs).flatMap(job => {
        if (!isAlarmJobName(job.name))
            return [];
        const next = job.nextInvocation()?.getTime();
        if (next === undefined || next <= now.getTime() || next > now.getTime() + horizonMs)
            return [];
        if (guard('suppression check', false, () => suppressions.get(job.name)?.(new Date(next)) === true))
            return [];
        return [{ side: sideOf(job.name), at: new Date(next).toISOString(), jobName: job.name }];
    });
}
const recent = (missed, now) => missed.filter(item => now.getTime() - Date.parse(item.recordedAt) < KEEP_MS).slice(-MAX_MISSED);
function entry(side, dueAt, reason, now) {
    return { id: `${side}-${dueAt.toISOString()}-${reason}`, side, at: dueAt.toISOString(), reason, recordedAt: now.toISOString() };
}
function add(found, now) {
    const known = new Set(ledger.missed.map(item => item.id));
    ledger.missed = recent([...ledger.missed, ...found.filter(item => !known.has(item.id))], now);
}
// The saved alarms that came due and never started, or started in an
// earlier run of the server that stopped before they finished, as missed
// alarms. Away and paused sides are left out, as they do not ring.
function unstarted(items, now) {
    const settings = settingsDB.data;
    const found = items.flatMap(item => {
        const due = Date.parse(item.at);
        const runs = ledger.started.filter(run => run.jobName === item.jobName && Math.abs(Date.parse(run.at) - due) <= STARTED_MATCH_MS);
        if (runs.some(run => run.done !== false || startedHere.has(run)))
            return [];
        if (settings[item.side].awayMode)
            return [];
        if (isAlarmPaused(settings, item.side, new Date(due)))
            return [];
        return [entry(item.side, new Date(item.at), runs.length > 0 ? 'unconfirmed' : 'not-running', now)];
    });
    add(found, now);
    for (const item of found) {
        logger.warn(`Missed the ${item.side} alarm due ${item.at}: ${item.reason === 'unconfirmed'
            ? 'the server stopped while it was being sent' : 'the server was not running'}`);
    }
    return found;
}
// The alarms due within windowMs from now. known is false when the live job
// list says nothing about what is due: the ledger is not running, jobs are not
// planned yet, or they are being re-planned. The alarms saved at the last plan
// then stand in for it.
export function alarmsDueWithin(now, windowMs) {
    const known = running && planned && !isRebuilding();
    const live = upcomingAlarms(now, windowMs).map(({ side, at }) => ({ side, at }));
    if (known)
        return { alarms: live, known };
    const t = now.getTime();
    const saved = [...ledger.upcoming, ...pending]
        .filter(item => Date.parse(item.at) > t && Date.parse(item.at) <= t + windowMs)
        .map(({ side, at }) => ({ side, at }));
    return { alarms: [...live, ...saved], known };
}
// Jobs of this server that started and have not finished, as saved alarms,
// so a crash before they finish still reports them after a later heartbeat.
function unfinishedHere(t) {
    return [...startedHere]
        .filter(run => run.done === false && ledger.started.includes(run) && t - Date.parse(run.at) < UNFINISHED_KEEP_MS)
        .map(run => ({ side: sideOf(run.jobName), at: run.at, jobName: run.jobName }));
}
function beat(now, jobsPlanned) {
    if (!running)
        return;
    if (jobsPlanned)
        planned = true;
    const t = now.getTime();
    const judgeable = pending.filter(item => Date.parse(item.at) + JUDGE_GRACE_MS <= t);
    unstarted(judgeable, now);
    // Once jobs are planned, a saved alarm still ahead is replaced by its live job.
    pending = pending.filter(item => !judgeable.includes(item) && (!planned || Date.parse(item.at) <= t));
    if (planned) {
        // Alive up to the earliest alarm still being judged or sent, so a crash now still reports it.
        const unfinished = unfinishedHere(t);
        const earliest = Math.min(t, ...[...pending, ...unfinished].map(item => Date.parse(item.at) - 1));
        ledger.aliveAt = new Date(earliest).toISOString();
        ledger.upcoming = [...upcomingAlarms(now), ...pending, ...unfinished];
    }
    else {
        ledger.upcoming = [...pending];
    }
    if (shape() !== savedShape)
        save();
}
// Call once, when the clock is valid and before jobs are planned: reports
// alarms that fell due between the last heartbeat and now, then starts the
// heartbeat. Saved alarms stay saved until alarmLedgerHeartbeat is called
// with the jobs planned, so a crash before then loses nothing.
export function startAlarmLedger(now) {
    return guard('start', [], () => {
        ledger = load();
        loaded = true;
        startedHere = new Set();
        const aliveAt = ledger.aliveAt ? Date.parse(ledger.aliveAt) : Number.NaN;
        const carried = Number.isFinite(aliveAt) ? ledger.upcoming.filter(item => Date.parse(item.at) > aliveAt) : [];
        const due = carried.filter(item => Date.parse(item.at) <= now.getTime());
        pending = carried.filter(item => Date.parse(item.at) > now.getTime());
        const found = unstarted(due, now);
        ledger.upcoming = [...pending];
        running = true;
        planned = false;
        save();
        if (!timer) {
            timer = setInterval(() => guard('heartbeat', undefined, () => {
                // While jobs are re-planned the job list is empty and says nothing about what is due.
                if (!isRebuilding())
                    beat(new Date(), false);
            }), HEARTBEAT_MS);
            timer.unref?.();
        }
        return found;
    });
}
// Call after the jobs have been planned, which is also when the alarms due in
// the next day are saved.
export function alarmLedgerHeartbeat(now) {
    guard('heartbeat', undefined, () => beat(now, true));
}
// Call before another version takes over. It keeps no record of the alarms
// it rings, so the saved ones would read as missed when this version comes
// back. Stops the heartbeat so they are not saved again before the server stops.
export function leaveAlarmLedger() {
    guard('leave', undefined, () => {
        ensureLoaded();
        running = false;
        if (timer)
            clearInterval(timer);
        timer = undefined;
        pending = [];
        ledger.aliveAt = null;
        ledger.upcoming = [];
        save();
    });
}
// Returns the saved entry, for noteAlarmFinished.
export function noteAlarmStarted(jobName, at) {
    return guard('start note', undefined, () => {
        if (!running || !isAlarmJobName(jobName))
            return undefined;
        const run = { jobName, at: at.toISOString(), done: false };
        ledger.started = [...ledger.started, run].slice(-MAX_STARTED);
        startedHere.add(run);
        save();
        return run;
    });
}
// The job rang, chose not to ring, or noted why it could not.
export function noteAlarmFinished(run) {
    guard('finish note', undefined, () => {
        if (!run || !ledger.started.includes(run))
            return;
        run.done = true;
        save();
    });
}
export function noteMissedAlarm(side, dueAt, reason, now = new Date()) {
    guard('note', undefined, () => {
        ensureLoaded();
        add([entry(side, dueAt, reason, now)], now);
        save();
    });
}
export function listMissedAlarms(now = new Date()) {
    return guard('list', [], () => {
        ensureLoaded();
        return recent(ledger.missed, now);
    });
}
export function dismissMissedAlarms(ids) {
    guard('dismiss', undefined, () => {
        ensureLoaded();
        const drop = new Set(ids);
        ledger.missed = ledger.missed.filter(item => !drop.has(item.id));
        save();
    });
}
export function resetAlarmLedgerForTests() {
    ledger = empty();
    loaded = false;
    unreadable = false;
    savedShape = undefined;
    running = false;
    planned = false;
    pending = [];
    startedHere = new Set();
    suppressions.clear();
    if (timer)
        clearInterval(timer);
    timer = undefined;
}
//# sourceMappingURL=alarmLedger.js.map