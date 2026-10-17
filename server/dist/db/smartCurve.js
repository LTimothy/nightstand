const MINUTE = 60_000;
export const CURVE = {
    prewarmMinutes: { standard: 30, gentle: 20 },
    coolDelayMinutes: { night: 10, day: 5 },
    coolStepMinutes: { night: 15, day: 10 },
    warmStepMinutes: 10,
    leadMinutes: { standardMin: 30, standardMax: 45, gentle: 30, day: 25, short: 15, veryShort: 15 },
    afterWakeMinutes: 30,
    shortWindowMinutes: 180,
    veryShortWindowMinutes: 90,
    daySleepFromMinute: 9 * 60,
    daySleepToMinute: 17 * 60,
};
// Same linear mapping as the app's levelToFahrenheit (-10 = 55°F, 0 = 82.5°F, +10 = 110°F).
const NEUTRAL_F = 82.5;
export const F_PER_LEVEL = 27.5 / 10;
export function levelToF(level) {
    return Math.round(level * F_PER_LEVEL + NEUTRAL_F);
}
const formatters = new Map();
function minuteOfDay(date, timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        });
        formatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    return hour * 60 + minute;
}
export function isDaySleep(bedtime, wake, timeZone) {
    const midpoint = new Date((bedtime.getTime() + wake.getTime()) / 2);
    const minute = minuteOfDay(midpoint, timeZone);
    return minute >= CURVE.daySleepFromMinute && minute <= CURVE.daySleepToMinute;
}
export function prewarmMinutes(smart) {
    return CURVE.prewarmMinutes[smart.intensity];
}
// The clamp never excludes the base itself, so a base of +5 or more gets no warm bumps.
export function curveBounds(baseLevel) {
    return {
        min: Math.min(baseLevel, Math.max(baseLevel - 3, -8)),
        max: Math.max(baseLevel, Math.min(baseLevel + 2, 5)),
    };
}
// Delay only: never before bedtime, and whole minutes.
export function effectiveCoolStart(bedtime, coolStart) {
    return new Date(Math.max(bedtime.getTime(), Math.ceil(coolStart.getTime() / MINUTE) * MINUTE));
}
export function buildCurve(input) {
    const { smart } = input;
    const base = smart.baseLevel;
    const gentle = smart.intensity === 'gentle';
    const bedtime = input.bedtime.getTime();
    const wake = input.wake.getTime();
    const powerOff = input.powerOff.getTime();
    const coolStart = effectiveCoolStart(input.bedtime, input.coolStart).getTime();
    const windowMinutes = (wake - bedtime) / MINUTE;
    const day = isDaySleep(input.bedtime, input.wake, input.timeZone);
    const bounds = curveBounds(base);
    const clamp = (level) => Math.min(bounds.max, Math.max(bounds.min, level));
    const prewarmStart = bedtime - prewarmMinutes(smart) * MINUTE;
    const points = [];
    const push = (at, level, phase) => {
        if (at >= prewarmStart && at < powerOff)
            points.push({ at: new Date(at), level, phase });
    };
    const afterWake = wake + CURVE.afterWakeMinutes * MINUTE;
    // A sleep that turns off when the person gets up holds the wake level to the end.
    const after = () => {
        if (!smart.offWhenUp)
            push(afterWake, base, 'after');
    };
    if (windowMinutes < CURVE.veryShortWindowMinutes) {
        push(prewarmStart, base, 'prewarm');
        push(bedtime, base, 'bedtime');
        const warmAt = wake - CURVE.leadMinutes.veryShort * MINUTE;
        const wakeLevel = smart.warmUp && warmAt > bedtime ? clamp(base + 1) : base;
        if (wakeLevel !== base)
            push(warmAt, wakeLevel, 'warmup');
        push(wake, wakeLevel, 'wake');
        after();
        return points;
    }
    const short = windowMinutes < CURVE.shortWindowMinutes;
    const warmBump = gentle ? 1 : 2;
    const onLevel = clamp(short || day || !smart.warmStart ? base : base + warmBump);
    const holdLevel = clamp(short ? base - 1 : base - (gentle ? 1 : 2));
    const wakeLevel = clamp(short || day ? base + 1 : base + warmBump);
    const lead = short ? CURVE.leadMinutes.short
        : day ? CURVE.leadMinutes.day
            : gentle ? CURVE.leadMinutes.gentle
                : Math.min(CURVE.leadMinutes.standardMax, Math.max(CURVE.leadMinutes.standardMin, Math.round(windowMinutes / 10)));
    const holdEnd = smart.warmUp ? wake - lead * MINUTE : wake;
    const coolStep = (day ? CURVE.coolStepMinutes.day : CURVE.coolStepMinutes.night) * MINUTE;
    const coolFrom = coolStart + (day ? CURVE.coolDelayMinutes.day : CURVE.coolDelayMinutes.night) * MINUTE;
    // Keep the last cooling step at least one warm step away from the first warming step.
    const coolLimit = smart.warmUp ? holdEnd - CURVE.warmStepMinutes * MINUTE : wake;
    push(prewarmStart, onLevel, 'prewarm');
    push(bedtime, onLevel, 'bedtime');
    let level = onLevel;
    if (coolFrom < coolLimit) {
        push(coolFrom, level, 'cooldown');
        let at = coolFrom;
        while (level > holdLevel && at + coolStep < coolLimit) {
            at += coolStep;
            level -= 1;
            push(at, level, level === holdLevel ? 'hold' : 'cooldown');
        }
    }
    if (!smart.warmUp) {
        push(wake, level, 'wake');
        after();
        return points;
    }
    const steps = Math.max(0, wakeLevel - level);
    const warmStep = CURVE.warmStepMinutes;
    const stepTimes = [];
    // Spread the steps over the lead, or pack them 10 minutes apart ending at wake.
    for (let k = 1; k <= steps; k++) {
        stepTimes.push(lead / steps >= warmStep
            ? holdEnd + Math.floor((k * lead) / steps) * MINUTE
            : wake - (steps - k) * warmStep * MINUTE);
    }
    if (steps === 0 || stepTimes[0] > holdEnd)
        push(holdEnd, level, 'warmup');
    stepTimes.forEach((at, index) => {
        const next = level + index + 1;
        push(at, next, at === wake ? 'wake' : 'warmup');
    });
    if (steps === 0)
        push(wake, level, 'wake');
    after();
    return points;
}
// Level in effect at `at`: the last point at or before it, else the first point.
export function levelAt(points, at) {
    if (points.length === 0)
        return null;
    let current = points[0];
    for (const point of points) {
        if (point.at.getTime() > at.getTime())
            break;
        current = point;
    }
    return current.level;
}
export function phaseAt(points, at) {
    if (points.length === 0 || at.getTime() < points[0].at.getTime())
        return null;
    let current = points[0];
    for (const point of points) {
        if (point.at.getTime() > at.getTime())
            break;
        current = point;
    }
    return current.phase;
}
// The bed warms before bedtime only when the pre-warm is above neutral; a cool or neutral pre-warm just turns it on early.
export function warmsBeforeBedtime(points) {
    const first = points[0];
    return first?.phase === 'prewarm' && first.level > 0;
}
//# sourceMappingURL=smartCurve.js.map