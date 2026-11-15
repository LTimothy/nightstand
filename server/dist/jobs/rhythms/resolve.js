import moment from 'moment-timezone';
import { rhythmOffWhenUp } from '../../db/rhythmsSchema.js';
import { wakeFromNight } from '../../db/rhythmWake.js';
import { SCHEDULE_DAYS } from '../../db/scheduleKeys.js';
import { addDays, rhythmSleepBounds, wallClock } from '../../db/rhythmTimes.js';
import { compareTimes, isValidTime } from '../utils.js';
import { normalizeNight } from './night.js';
import { applySmartCurve } from './smartSleep.js';
// Longer than any caller needs, so a mistaken window cannot resolve years of sleeps.
export const MAX_RESOLVE_WINDOW_MS = 70 * 24 * 60 * 60 * 1000;
const KIND_ORDER = { 'power-on': 0, temperature: 1, alarm: 2, 'power-off': 3 };
const DATE_FORMAT = 'YYYY-MM-DD';
const weekdayOf = (date) => SCHEDULE_DAYS[moment.utc(date, DATE_FORMAT, true).day()];
// Times at or after power on belong to the start date, earlier ones to the next.
const dateForTime = (date, time, powerOn) => (compareTimes(time, powerOn) >= 0 ? date : addDays(date, 1));
function resolveNight(side, date, source, timeZone) {
    const night = normalizeNight(source.night);
    const { power } = night;
    if (!power.enabled || !isValidTime(power.on) || !isValidTime(power.off))
        return null;
    const wakeTime = source.wake !== undefined && isValidTime(source.wake) ? source.wake : wakeFromNight(night);
    const { start, end, wake } = rhythmSleepBounds(date, power, wakeTime, timeZone);
    // A short night starting in a spring-forward gap can lose its whole length.
    // The legacy engine skips that power on and leaves the side off.
    if (end <= start)
        return null;
    const events = [{ kind: 'power-on', at: start, temperatureF: power.onTemperature }];
    for (const [time, temperatureF] of Object.entries(night.temperatures)) {
        if (!isValidTime(time))
            continue;
        events.push({ kind: 'temperature', at: wallClock(dateForTime(date, time, power.on), time, timeZone), temperatureF });
    }
    night.alarms.filter(alarm => alarm.enabled).forEach((alarm, index) => {
        if (!isValidTime(alarm.time))
            return;
        events.push({ kind: 'alarm', at: wallClock(dateForTime(date, alarm.time, power.on), alarm.time, timeZone), alarm, index });
    });
    events.push({ kind: 'power-off', at: end });
    events.sort((a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const sleep = { side, date, rhythmId: source.rhythmId, start, end, wake, night, mode: source.mode, events };
    if (source.mode === 'smart' && source.smart)
        sleep.smart = { ...source.smart };
    if (source.offWhenUp)
        sleep.offWhenUp = true;
    if (sleep.smart) {
        if (source.offWhenUp)
            sleep.smart.offWhenUp = true;
        else
            delete sleep.smart.offWhenUp;
    }
    return sleep;
}
// Ends a sleep at its actual off: later while kept on for someone in bed,
// earlier once they got up. Anything due at or after an earlier end is dropped.
export function withPowerOff(sleep, at) {
    if (!at || at.getTime() === sleep.end.getTime() || at.getTime() <= sleep.start.getTime())
        return sleep;
    const events = sleep.events.filter(event => event.kind !== 'power-off' && event.at.getTime() < at.getTime());
    events.push({ kind: 'power-off', at });
    return { ...sleep, end: at, setOff: sleep.end, wake: new Date(Math.min(sleep.wake.getTime(), at.getTime())), events };
}
export const turnsOffWhenUp = (sleep) => sleep.offWhenUp === true;
// A sleep starting the day before `from` can still be running at `from`.
function resolveWindow(window, sourceFor) {
    const { side, timeZone, from, to } = window;
    // An invalid date formats as 'Invalid date', which would never end the loop.
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        return [];
    if (to.getTime() - from.getTime() > MAX_RESOLVE_WINDOW_MS)
        throw new RangeError('The window to resolve is longer than 70 days');
    const last = moment.tz(to, timeZone).format(DATE_FORMAT);
    const sleeps = [];
    for (let date = addDays(moment.tz(from, timeZone).format(DATE_FORMAT), -1); date <= last; date = addDays(date, 1)) {
        const source = sourceFor(date);
        const night = source ? resolveNight(side, date, source, timeZone) : null;
        const ended = night && withPowerOff(night, window.powerOffFor?.(side, date));
        // The pre-warm moves a Smart Schedule start earlier, so the curve goes on before the window check.
        const sleep = ended && applySmartCurve(ended, timeZone, window.coolStartFor?.(side, date));
        if (sleep && sleep.start <= to && sleep.end >= from)
            sleeps.push(sleep);
    }
    return sleeps;
}
export function resolveSleeps(args) {
    const plan = args.db[args.side];
    return resolveWindow(args, date => {
        const change = plan.changes.find(entry => entry.date === date);
        const rhythmId = change ? change.rhythmId : plan.week[weekdayOf(date)];
        const rhythm = rhythmId && Object.hasOwn(plan.rhythms, rhythmId) ? plan.rhythms[rhythmId] : undefined;
        if (!rhythm)
            return null;
        return {
            rhythmId: rhythm.id, night: rhythm.night, wake: rhythm.wake, mode: rhythm.temperatureMode, smart: rhythm.smart,
            offWhenUp: rhythmOffWhenUp(rhythm),
        };
    });
}
export function resolveLegacySleeps(args) {
    return resolveWindow(args, date => ({ rhythmId: null, night: args.schedules[args.side][weekdayOf(date)], mode: 'manual' }));
}
export function findOverlaps(args) {
    const sleeps = resolveSleeps(args);
    const overlaps = [];
    sleeps.forEach((sleep, index) => {
        for (const next of sleeps.slice(index + 1)) {
            if (next.start >= sleep.end)
                break;
            overlaps.push({ first: sleep.date, second: next.date });
        }
    });
    return overlaps;
}
// alarmsEnabled is a side setting, not schedule data, so callers apply it.
export function applyAlarmsEnabled(sleeps, alarmsEnabled) {
    if (alarmsEnabled)
        return sleeps;
    return sleeps.map(sleep => ({ ...sleep, events: sleep.events.filter(event => event.kind !== 'alarm') }));
}
//# sourceMappingURL=resolve.js.map