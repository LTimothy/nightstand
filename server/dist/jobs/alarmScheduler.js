import schedule from 'node-schedule';
import cbor from 'cbor';
import moment from 'moment-timezone';
import logger from '../logger.js';
import serverStatus from '../serverStatus.js';
import schedulesDB from '../db/schedules.js';
import settingsDB, { updateSettings } from '../db/settings.js';
import { dailyAlarmSchedules } from '../db/scheduleAlarms.js';
import { executeFunction } from '../8sleep/deviceApi.js';
import { compareTimes, getDayIndexForTime, isValidTime, logJob } from './utils.js';
import { connectFrankenWithin } from '../8sleep/frankenServer.js';
import { nightBounds } from './nightBounds.js';
import { emitJobEvent } from './jobEvents.js';
import { describePause, isAlarmPaused } from './schedulePause.js';
import { ALARM_LATE_LIMIT_MS, trackAlarm } from './alarmActivity.js';
import { alarmPatternFor } from './alarmPattern.js';
import { missedReasonForError, noteMissedAlarm, setAlarmSuppression } from './alarmLedger.js';
import { recordActiveAlarm } from './activeAlarms.js';
import { alarmOverrideSilences } from './alarmOverrideGate.js';
const alarmOccurrences = new Map();
// Overrides that have already run, so a rebuild cannot ring them again.
const overrideRuns = new Map();
const OCCURRENCE_RETENTION_MS = 48 * 60 * 60 * 1000;
// Resolves to how long the alarm rings in milliseconds, or 0 if it did not ring.
export const executeAlarm = async ({ vibrationIntensity, duration, vibrationPattern, side, force = false }, occurrenceId, { dueAt, ...options } = {}) => {
    const due = dueAt ?? Date.now();
    // Reserve recurring occurrences before awaiting I/O; manual alarms can repeat.
    const occurrenceKey = !force && occurrenceId ? `${side}:${occurrenceId}` : undefined;
    const cutoff = Date.now() - OCCURRENCE_RETENTION_MS;
    for (const [key, timestamp] of alarmOccurrences) {
        if (timestamp < cutoff)
            alarmOccurrences.delete(key);
    }
    if (occurrenceKey && alarmOccurrences.has(occurrenceKey))
        return 0;
    if (occurrenceKey)
        alarmOccurrences.set(occurrenceKey, Date.now());
    let fired = false;
    let sending = false;
    emitJobEvent({ jobName: `alarm-${side}`, status: 'started' });
    try {
        const min10Duration = Math.max(10, duration);
        // Exit is side is in away mode
        await settingsDB.read();
        if (settingsDB.data[side].awayMode && !force) {
            if (settingsDB.data[side].awayMode) {
                logger.debug('Not executing alarm, this side is in away mode!');
                return 0;
            }
        }
        // Exit if side is off
        const franken = await connectFrankenWithin(options);
        const resp = await franken.getDeviceStatus();
        if (!resp[side].isOn && !force) {
            logger.debug('Not executing alarm, side is off!');
            if (options.background)
                noteMissedAlarm(side, new Date(due), 'side-off');
            return 0;
        }
        const currentTime = moment.tz(settingsDB.data.timeZone);
        const alarmTimeEpoch = currentTime.unix();
        const alarmPayload = {
            pl: vibrationIntensity,
            du: min10Duration,
            pi: alarmPatternFor(resp.hubVersion, resp.coverVersion, vibrationPattern),
            tt: alarmTimeEpoch,
        };
        const cborPayload = cbor.encode(alarmPayload);
        const hexPayload = cborPayload.toString('hex');
        const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
        const lateMs = Date.now() - due;
        const notAfter = options.background ? due + ALARM_LATE_LIMIT_MS : undefined;
        if (notAfter !== undefined && lateMs > ALARM_LATE_LIMIT_MS) {
            const message = `Skipped the ${side} alarm: the Pod was reachable only ${Math.round(lateMs / 1_000)}s after its time`;
            logger.warn(message);
            emitJobEvent({ jobName: `alarm-${side}`, status: 'fail', message });
            noteMissedAlarm(side, new Date(due), 'late');
            return 0;
        }
        logger.debug(`Executing alarm... ${JSON.stringify(alarmPayload)}`);
        sending = true;
        await executeFunction(command, hexPayload, { ...options, notAfter });
        fired = true;
        await recordActiveAlarm(side, { vibrationIntensity, duration, vibrationPattern }, min10Duration);
        serverStatus.status.alarmSchedule.status = 'healthy';
        serverStatus.status.alarmSchedule.message = '';
        emitJobEvent({ jobName: `alarm-${side}`, status: 'ok' });
        return min10Duration * 1_000;
    }
    catch (error) {
        serverStatus.status.alarmSchedule.status = 'failed';
        const message = error instanceof Error ? error.message : String(error);
        serverStatus.status.alarmSchedule.message = message;
        logger.error(error);
        emitJobEvent({ jobName: `alarm-${side}`, status: 'fail', message });
        // Once the Pod has the alarm it may be ringing, so a later error is not a miss.
        if (options.background && !fired)
            noteMissedAlarm(side, new Date(due), missedReasonForError(error, sending));
        return 0;
    }
    finally {
        if (occurrenceKey && !fired)
            alarmOccurrences.delete(occurrenceKey);
    }
};
// True once an alarm with this occurrence id has rung (or is ringing) in this process.
export function hasAlarmOccurrence(side, occurrenceId) {
    return alarmOccurrences.has(`${side}:${occurrenceId}`);
}
// Test isolation only.
export const resetAlarmOccurrences = () => alarmOccurrences.clear();
/**
 * Next occurrence of HH:mm in tz (today or tomorrow depending on 'now').
 * If the HH:mm is already passed for 'now', schedule for tomorrow.
 */
function nextOccurrenceHhMm(tz, hhmm) {
    const now = moment.tz(tz);
    const [h, m] = hhmm.split(':').map(Number);
    const candidate = now.clone().hour(h).minute(m).second(0).millisecond(0);
    if (candidate.isSameOrBefore(now)) {
        candidate.add(1, 'day');
    }
    return candidate;
}
/**
 * One-off alarm: stand-alone alarm that fires once at a specific datetime then
 * auto-disables itself. Independent of the per-day-of-week recurring alarm.
 *
 * The fireAt field is an ISO 8601 string including offset (e.g.
 * "2026-04-30T07:00:00-07:00"). After firing we flip enabled=false and write
 * the settings back, which triggers chokidar to setupJobs() and the rebuilt
 * scheduler skips this branch.
 */
export function scheduleOneOffAlarm(settingsData, side) {
    const o = settingsData[side]?.oneOffAlarm;
    if (!o?.enabled)
        return null;
    if (!o.fireAt)
        return null;
    const fireAt = moment(o.fireAt);
    if (!fireAt.isValid()) {
        logger.warn(`One-off alarm for ${side} has invalid fireAt: ${o.fireAt}`);
        return null;
    }
    const now = moment();
    if (!fireAt.isAfter(now)) {
        // Disable only this expired occurrence; keep concurrent user saves.
        logger.debug(`One-off alarm for ${side} fireAt is in the past; disabling.`);
        updateSettings(draft => {
            if (draft[side].oneOffAlarm.fireAt !== o.fireAt || !draft[side].oneOffAlarm.enabled)
                return false;
            draft[side].oneOffAlarm.enabled = false;
        })
            .catch((err) => logger.warn(`Failed to clear stale one-off alarm: ${err}`));
        return null;
    }
    logger.debug(`Scheduling one-off alarm for ${side} at ${fireAt.format()}`);
    const jobName = `${side}-one-off-alarm`;
    schedule.scheduleJob(jobName, fireAt.toDate(), (fireDate) => trackAlarm(side, jobName, async () => {
        try {
            return await executeAlarm({
                side,
                vibrationIntensity: o.vibrationIntensity,
                duration: o.duration,
                vibrationPattern: o.vibrationPattern,
            }, undefined, { background: true, dueAt: fireDate?.getTime() });
        }
        finally {
            // Auto-disable after firing (or after attempt) so the user doesn't
            // need to come back and manually toggle it off, which is the whole
            // point of a "one-off" alarm.
            try {
                await updateSettings(draft => {
                    if (draft[side].oneOffAlarm.fireAt !== o.fireAt || !draft[side].oneOffAlarm.enabled)
                        return false;
                    draft[side].oneOffAlarm.enabled = false;
                });
            }
            catch (err) {
                logger.error(`Failed to auto-disable one-off alarm for ${side}: ${err}`);
            }
        }
    }));
}
// An override may ring at the very end of its night (the turn-off minute).
// In a full-day schedule that same time also opened the night; an override
// that already ran then must not ring again at the end.
function openedItsNight(side, occurrence) {
    for (const offset of [-1, 0]) {
        const date = occurrence.clone().startOf('day').add(offset, 'day');
        const daily = schedulesDB.data?.[side]?.[date.format('dddd').toLowerCase()];
        if (!daily?.power.enabled)
            continue;
        const { start, end } = nightBounds(date, daily.power);
        if (end.isSame(occurrence))
            return !occurrence.clone().subtract(1, 'day').isBefore(start);
    }
    return false;
}
// The same rule for a Rhythms sleep: it ends at this minute and began a
// full day earlier.
function rhythmOpenedItsNight(sleep, occurrence) {
    return !!sleep && sleep.end.getTime() === occurrence.valueOf()
        && !occurrence.clone().subtract(1, 'day').isBefore(sleep.start);
}
// A Rhythms lookup that fails counts as no sleep, so it can never reject
// inside a job or stop a rebuild after every job was cancelled.
function rhythmSleepFor(lookup, side, at) {
    try {
        return lookup(at);
    }
    catch (error) {
        logger.error(`Could not find the ${side} Rhythms sleep at ${at.toISOString()}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
export function scheduleAlarmOverride(settingsData, side, rhythmSleepAt) {
    if (!settingsData[side].alarmsEnabled)
        return null;
    const alarmOverride = settingsData[side]?.scheduleOverrides?.alarm;
    if (!alarmOverride || alarmOverride.disabled)
        return null;
    if (!alarmOverride.timeOverride || !alarmOverride.expiresAt)
        return null;
    const now = moment.tz(settingsData.timeZone);
    const expiresAt = moment.tz(alarmOverride.expiresAt, settingsData.timeZone);
    if (!expiresAt.isAfter(now))
        return null;
    const next = nextOccurrenceHhMm(settingsData.timeZone, alarmOverride.timeOverride);
    if (next.isAfter(expiresAt))
        return null;
    const overrideKey = `${side}:${alarmOverride.timeOverride}:${alarmOverride.expiresAt}`;
    for (const [key, ranAt] of overrideRuns) {
        if (ranAt < Date.now() - OCCURRENCE_RETENTION_MS)
            overrideRuns.delete(key);
    }
    const opened = () => (rhythmSleepAt
        ? rhythmOpenedItsNight(rhythmSleepFor(rhythmSleepAt, side, next.toDate()), next)
        : openedItsNight(side, next));
    if (next.isSame(expiresAt) && overrideRuns.has(overrideKey) && opened())
        return null;
    logger.debug(`Alarm override is set! Scheduling alarm for ${next.format()}`);
    const jobName = `${side}-alarm-override-${alarmOverride.timeOverride}`;
    schedule.scheduleJob(jobName, next.toDate(), (fireDate) => trackAlarm(side, jobName, async () => {
        overrideRuns.set(overrideKey, Date.now());
        try {
            await settingsDB.read();
            if (isAlarmPaused(settingsDB.data, side, fireDate ?? moment().toDate())) {
                logger.info(`Skipping ${side} alarm override at ${alarmOverride.timeOverride}, schedule paused ${describePause(settingsDB.data, side)}`);
                return 0;
            }
        }
        catch (error) {
            logger.error(error);
            noteMissedAlarm(side, fireDate ?? next.toDate(), 'error');
            return 0;
        }
        // The replacement belongs to a night starting today or yesterday, not
        // necessarily the calendar date on which it rings.
        let sourceAlarm;
        if (rhythmSleepAt) {
            const first = rhythmSleepFor(rhythmSleepAt, side, next.toDate())?.events.find(event => event.kind === 'alarm');
            sourceAlarm = first?.kind === 'alarm' ? first.alarm : undefined;
        }
        for (const offset of rhythmSleepAt ? [] : [-1, 0]) {
            const date = next.clone().startOf('day').add(offset, 'day');
            const dayKey = date.format('dddd').toLowerCase();
            const daily = schedulesDB.data?.[side]?.[dayKey];
            if (!daily?.power.enabled)
                continue;
            const { start, end } = nightBounds(date, daily.power);
            if (!next.isBetween(start, end, undefined, '[]'))
                continue;
            sourceAlarm = dailyAlarmSchedules(daily).filter(alarm => alarm.enabled)
                .sort((a, b) => {
                const minutes = (time) => {
                    const [h, m] = time.split(':').map(Number);
                    return h * 60 + m + (compareTimes(time, daily.power.on) < 0 ? 1440 : 0);
                };
                return minutes(a.time) - minutes(b.time);
            })[0];
            if (sourceAlarm)
                break;
        }
        const { vibrationIntensity, duration, vibrationPattern } = sourceAlarm ?? {
            vibrationIntensity: 100,
            duration: 60,
            vibrationPattern: 'rise',
        };
        return executeAlarm({
            side,
            vibrationIntensity,
            duration,
            vibrationPattern,
        }, undefined, { background: true, dueAt: fireDate?.getTime() });
    }));
}
export const scheduleAlarm = (settingsData, side, day, dailySchedule) => {
    // Recurring alarms stay coupled to the day's power schedule; the runtime
    // isOn check inside executeAlarm still skips a manually-off pod.
    if (!dailySchedule.power.enabled)
        return;
    if (!settingsData[side].alarmsEnabled)
        return;
    if (settingsData[side].awayMode)
        return;
    if (settingsData.timeZone === null)
        return;
    const enabledAlarms = dailyAlarmSchedules(dailySchedule).filter(alarm => alarm.enabled);
    enabledAlarms.forEach((alarm, alarmIndex) => {
        const alarmRule = new schedule.RecurrenceRule();
        const { time } = alarm;
        // Schedule data written before the API validated alarm entries, or edited
        // by hand, can be missing a time. Skip that alarm instead of throwing, so
        // one bad entry cannot take down the rest of the pod's jobs.
        if (!isValidTime(time)) {
            logger.warn(`Skipping ${side} ${day} alarm ${alarmIndex}: invalid time ${JSON.stringify(time)}`);
            return;
        }
        // Resolve the alarm's day from its own time against the day's power on,
        // not from power.off: an alarm and the power off can sit on opposite
        // sides of midnight, and keying off power.off moved the alarm to another
        // weekday whenever the off time changed.
        const dayIndex = getDayIndexForTime(day, time, dailySchedule.power.on);
        alarmRule.dayOfWeek = dayIndex;
        const [alarmHour, alarmMinute] = time.split(':').map(Number);
        alarmRule.hour = alarmHour;
        alarmRule.minute = alarmMinute;
        alarmRule.tz = settingsData.timeZone;
        logJob('Scheduling alarm job', side, day, dayIndex, time);
        const jobName = `${side}-${day}-${time}-${alarmIndex}-alarm`;
        schedule.scheduleJob(jobName, alarmRule, (fireDate) => trackAlarm(side, jobName, async () => {
            try {
                logJob('Executing alarm job', side, day, dayIndex, time);
                await settingsDB.read();
                const now = moment.tz(settingsData.timeZone);
                if (isAlarmPaused(settingsDB.data, side, fireDate ?? now.toDate())) {
                    logger.info(`Skipping ${side} ${day} alarm at ${time}, schedule paused ${describePause(settingsDB.data, side)}`);
                    return 0;
                }
                const overrideExpiresAt = settingsDB.data[side].scheduleOverrides.alarm.expiresAt;
                if (alarmOverrideSilences(overrideExpiresAt, settingsData.timeZone, time, dailySchedule.power, now)) {
                    logJob(`Detected alarm override! Skipping alarm! Override expires at: ${overrideExpiresAt}`, side, day, dayIndex, time);
                    return 0;
                }
                return await executeAlarm({
                    side,
                    vibrationIntensity: alarm.vibrationIntensity,
                    duration: alarm.duration,
                    vibrationPattern: alarm.vibrationPattern,
                }, `recurring:${day}:${time}:${now.format('YYYY-MM-DD')}`, { background: true, dueAt: fireDate?.getTime() });
            }
            catch (error) {
                serverStatus.status.alarmSchedule.status = 'failed';
                const message = error instanceof Error ? error.message : String(error);
                serverStatus.status.alarmSchedule.message = message;
                logger.error(error);
                noteMissedAlarm(side, fireDate ?? new Date(), 'error');
                return 0;
            }
        }));
        setAlarmSuppression(jobName, due => alarmOverrideSilences(settingsDB.data[side].scheduleOverrides.alarm.expiresAt, settingsData.timeZone, time, dailySchedule.power, moment.tz(due, settingsData.timeZone)));
    });
};
//# sourceMappingURL=alarmScheduler.js.map