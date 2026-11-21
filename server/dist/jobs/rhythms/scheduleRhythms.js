import moment from 'moment-timezone';
import schedule from 'node-schedule';
import logger from '../../logger.js';
import { scheduleZone } from '../../db/timeZones.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import { getDeviceStatusCoalesced, isFrankenConnected } from '../../8sleep/frankenServer.js';
import { effectiveSides } from '../scheduleQueries.js';
import { resolveSleeps } from './resolve.js';
import { ANALYSIS_DELAY_MS, ANALYSIS_MAX_WINDOW_MS, REANALYSIS_DELAY_MS, armedEnd, rearmRhythmSleep, runRhythmEvent, runSleepAnalysis, } from './runEvent.js';
import { smartOffExtends, smartResolveHooks } from './curveController.js';
import { trackAlarm } from '../alarmActivity.js';
import { noteMissedAlarm, setAlarmSuppression } from '../alarmLedger.js';
import { isAlarmOverridden, rhythmSkipReason } from './gates.js';
import settingsDB from '../../db/settings.js';
import { forgetKeptAlarms, keptSleeps, rememberKeptAlarms } from './keptAlarms.js';
import { poweredOnSince, scheduleSleepAnalysis } from '../powerScheduler.js';
import { SLEEP_ANALYSIS_HOUR, SLEEP_ANALYSIS_MINUTE } from '../../sleepAnalysisSchedule.js';
export const RHYTHMS_HORIZON_MS = 48 * 60 * 60 * 1000;
export const RHYTHMS_HORIZON_JOB = 'rhythms-horizon';
// Weekly data can store a temperature or alarm after its night's power off,
// and the weekly engine fires it, so recent sleeps resolve too. It also keeps
// the analyses of a sleep that ended in the last two hours. Past instants are
// skipped.
export const RHYTHMS_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
export function rhythmJobName(side, date, kind, at, timeZone, n) {
    return `rhythm-${side}-${date}-${kind}-${moment.tz(at, timeZone).format('HHmm')}-${n}`;
}
const runningStarts = new Set();
export function hasRunningRhythmStart(side, date) {
    return [...runningStarts].some(job => job.name.startsWith(`rhythm-${side}-${date}-power-on-`));
}
// node-schedule keeps a dead entry for a date in the past, so past instants
// and names already planned are skipped before asking it. A failed job is
// logged: a rejected job becomes an unhandled rejection, which stops the server.
function scheduleOnce(name, at, now, run) {
    if (at.getTime() <= now.getTime() || schedule.scheduledJobs[name])
        return false;
    const job = () => run().catch((error) => {
        logger.error(`Rhythm job ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const scheduled = schedule.scheduleJob(name, at, job);
    if (scheduled) {
        // One-time jobs leave scheduledJobs before their promises settle.
        if (name.includes('-power-on-')) {
            scheduled.on('run', () => runningStarts.add(scheduled));
            scheduled.on('success', () => runningStarts.delete(scheduled));
            scheduled.on('error', () => runningStarts.delete(scheduled));
        }
        return true;
    }
    schedule.cancelJob(name);
    return false;
}
function scheduleSleep(settings, side, sleep, now, timeZone) {
    let count = 0;
    const seen = new Map();
    for (const event of sleep.events) {
        const n = seen.get(event.kind) ?? 0;
        seen.set(event.kind, n + 1);
        if (event.kind === 'alarm' && !settings[side].alarmsEnabled)
            continue;
        const name = rhythmJobName(side, sleep.date, event.kind, event.at, timeZone, n);
        // Alarm jobs register as they start, so a power-off due in the same
        // minute waits for them.
        const run = event.kind === 'alarm'
            ? () => trackAlarm(side, name, () => runRhythmEvent(side, sleep, event))
            : () => runRhythmEvent(side, sleep, event);
        if (scheduleOnce(name, event.at, now, run))
            count += 1;
        if (event.kind === 'alarm')
            setAlarmSuppression(name, due => isAlarmOverridden(settingsDB.data, side, sleep, due));
    }
    const analysisAt = new Date(sleep.end.getTime() + ANALYSIS_DELAY_MS);
    const analysisName = rhythmJobName(side, sleep.date, 'analysis', analysisAt, timeZone, 0);
    if (scheduleOnce(analysisName, analysisAt, now, () => runSleepAnalysis(side, sleep)))
        count += 1;
    // Someone still in bed at the first run gets a record cut off there. The
    // later run looks back the analyzer's full window and replaces it.
    const reanalysisAt = new Date(sleep.end.getTime() + REANALYSIS_DELAY_MS);
    const reanalysisName = rhythmJobName(side, sleep.date, 'analysis', reanalysisAt, timeZone, 1);
    const reanalyse = () => runSleepAnalysis(side, sleep, REANALYSIS_DELAY_MS, ANALYSIS_MAX_WINDOW_MS);
    if (scheduleOnce(reanalysisName, reanalysisAt, now, reanalyse))
        count += 1;
    return count;
}
const REARM_DELAY_MS = 1000;
// The power-on tells the firmware when to turn the side off. A sleep in
// progress that now ends at another time, or that this process never armed,
// has its end sent again, so a later end does not lose its alarm.
function scheduleRearm(side, sleeps, now) {
    const t = now.getTime();
    const current = sleeps.filter(sleep => sleep.start.getTime() <= t && t < sleep.end.getTime()).pop();
    // A sleep kept on past its set off has its timer moved in steps by the controller.
    if (!current || armedEnd(side) === current.end.getTime() || smartOffExtends(side, current.date))
        return 0;
    const name = `rhythm-${side}-${current.date}-rearm`;
    return scheduleOnce(name, new Date(t + REARM_DELAY_MS), now, () => rearmRhythmSleep(side, current)) ? 1 : 0;
}
// A Smart Schedule sleep turns on before its bedtime. One whose turn-on time
// had passed before it was planned (tonight switched to it during that time)
// turns on now, up to its bedtime.
function scheduleMissedPrewarm(side, sleeps, now) {
    const t = now.getTime();
    let count = 0;
    for (const sleep of sleeps) {
        const bedtime = sleep.smartCurve?.bedtime.getTime();
        if (bedtime === undefined || sleep.start.getTime() > t || t >= bedtime || poweredOnSince(side, sleep.start))
            continue;
        const powerOn = sleep.events.find(event => event.kind === 'power-on');
        if (!powerOn)
            continue;
        const at = new Date(t + REARM_DELAY_MS);
        const name = `rhythm-${side}-${sleep.date}-power-on-late`;
        const run = async () => (poweredOnSince(side, sleep.start) ? 0 : runRhythmEvent(side, sleep, { ...powerOn, at }));
        if (scheduleOnce(name, at, now, run))
            count += 1;
    }
    return count;
}
// The side may have been turned off by means no job sees (the Pod's own
// controls, the firmware timer), so look before ringing. A Pod that is not
// connected is left to the alarm itself, which waits a bounded time, checks
// the side is on and drops a late alarm.
async function ringKeptAlarm(side, sleep, event) {
    if (!isFrankenConnected())
        return runRhythmEvent(side, sleep, event);
    try {
        const status = await getDeviceStatusCoalesced();
        if (!status[side].isOn && !settingsDB.data.features.alarmsWhenOff) {
            logger.info(`Skipping the kept alarm for ${side}: the side is off`);
            if (!rhythmSkipReason(settingsDB.data, side, sleep, 'alarm', new Date(), event.at))
                noteMissedAlarm(side, event.at, 'side-off');
            forgetKeptAlarms(side);
            return 0;
        }
    }
    catch (error) {
        logger.warn(`Could not read the Pod, ringing the kept alarm for ${side} anyway: ${error instanceof Error ? error.message : String(error)}`);
    }
    return runRhythmEvent(side, sleep, event);
}
// Turning Rhythms off ends its jobs, so a sleep left running keeps its
// remaining alarms in memory and scheduleKeptAlarms plans them again on every
// rebuild.
export function keepSleepAlarms(side, sleep, now, timeZone) {
    const alarms = [];
    let n = 0;
    for (const event of sleep.events) {
        if (event.kind !== 'alarm')
            continue;
        if (event.at.getTime() > now.getTime())
            alarms.push({ name: rhythmJobName(side, sleep.date, 'alarm', event.at, timeZone, n), event });
        n += 1;
    }
    rememberKeptAlarms(side, { sleep, alarms });
}
export function scheduleKeptAlarms(now) {
    let count = 0;
    for (const [side, { sleep, alarms }] of keptSleeps()) {
        const ahead = alarms.filter(({ event }) => event.at.getTime() > now.getTime());
        if (ahead.length === 0) {
            forgetKeptAlarms(side);
            continue;
        }
        for (const { name, event } of ahead) {
            if (scheduleOnce(name, event.at, now, () => trackAlarm(side, name, () => ringKeptAlarm(side, sleep, event))))
                count += 1;
            setAlarmSuppression(name, due => isAlarmOverridden(settingsDB.data, side, sleep, due));
        }
    }
    return count;
}
const DAY_MS = 24 * 60 * 60 * 1000;
// A sleep that ended in the day before `at` has its own analyses. One kept on
// past its set off counts from the set off, since its analyses are still to come.
function sleptWithin(db, side, timeZone, at) {
    const from = new Date(at.getTime() - DAY_MS);
    return resolveSleeps({ db, side, timeZone, from, to: at, ...smartResolveHooks }).some(sleep => {
        const ended = Math.min(sleep.end.getTime(), (sleep.setOff ?? sleep.end).getTime());
        return ended > from.getTime() && ended <= at.getTime();
    });
}
function nextNoon(now, timeZone) {
    const noon = moment.tz(now, timeZone).hour(SLEEP_ANALYSIS_HOUR).minute(SLEEP_ANALYSIS_MINUTE).startOf('minute');
    if (!noon.isAfter(now))
        noon.add(1, 'day');
    return noon.toDate();
}
// The hourly job extends from whatever was planned last.
let latest = null;
function scheduleHorizon(timeZone, extend) {
    if (schedule.scheduledJobs[RHYTHMS_HORIZON_JOB])
        return;
    const rule = new schedule.RecurrenceRule();
    rule.minute = 0;
    rule.tz = scheduleZone(timeZone);
    schedule.scheduleJob(RHYTHMS_HORIZON_JOB, rule, extend);
}
// A side with no sleep ending in the day before noon, such as one with no
// rhythms or a night with no sleep, keeps the weekly noon analysis. Each run
// checks again, since a later day may have a sleep with its own analyses.
function keepNoonAnalysis(settings, side) {
    if (schedule.scheduledJobs[`daily-analyze-sleep-${side}`])
        return;
    scheduleSleepAnalysis(settings, side, at => {
        if (!latest?.settings.timeZone)
            return false;
        try {
            return sleptWithin(latest.db, side, latest.settings.timeZone, at);
        }
        catch (error) {
            logger.error(`Rhythms could not check the ${side} noon analysis: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    });
}
// Settings and data saves rebuild every job, so the hourly job only adds
// the sleeps that have come into range. A side that cannot be resolved is
// logged and skipped, so the other side and the rest of the rebuild still run.
export function scheduleRhythms(settings, db, now) {
    const timeZone = settings.timeZone;
    if (!timeZone)
        return { jobCount: 0, failedSides: [] };
    latest = { settings, db };
    const from = new Date(now.getTime() - RHYTHMS_LOOKBACK_MS);
    const to = new Date(now.getTime() + RHYTHMS_HORIZON_MS);
    let jobCount = 0;
    const failedSides = [];
    for (const side of SCHEDULE_SIDES) {
        if (effectiveSides(settings, side).length === 0) {
            logger.debug(`Rhythms: ${side} is away, its own rhythm is not scheduled`);
            continue;
        }
        let keepNoon = true;
        try {
            const sleeps = resolveSleeps({ db, side, timeZone, from, to, ...smartResolveHooks });
            for (const sleep of sleeps) {
                jobCount += scheduleSleep(settings, side, sleep, now, timeZone);
            }
            jobCount += scheduleRearm(side, sleeps, now);
            jobCount += scheduleMissedPrewarm(side, sleeps, now);
            keepNoon = !sleptWithin(db, side, timeZone, nextNoon(now, timeZone));
        }
        catch (error) {
            failedSides.push(side);
            logger.error(`Rhythms could not plan ${side}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (keepNoon)
            keepNoonAnalysis(settings, side);
    }
    scheduleHorizon(timeZone, () => {
        if (!latest)
            return;
        try {
            const added = scheduleRhythms(latest.settings, latest.db, new Date()).jobCount;
            logger.debug(`Rhythms horizon added ${added} job(s)`);
        }
        catch (error) {
            logger.error(`Rhythms horizon failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    return { jobCount, failedSides };
}
//# sourceMappingURL=scheduleRhythms.js.map