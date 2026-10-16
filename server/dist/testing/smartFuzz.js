import moment from 'moment-timezone';
import { DEFAULT_SMART } from '../db/rhythmsSchema.js';
import { curveBounds, CURVE, isDaySleep, levelAt, phaseAt, prewarmMinutes } from '../db/smartCurve.js';
export const MINUTE = 60_000;
export const FUZZ_SEED = Number(process.env.FUZZ_SEED ?? 20261006) >>> 0;
export const FUZZ_RUNS = Number(process.env.FUZZ_RUNS ?? 1024);
export const FUZZ_EDITOR_RUNS = Number(process.env.FUZZ_EDITOR_RUNS ?? 32);
if (!Number.isSafeInteger(FUZZ_RUNS) || FUZZ_RUNS < 1)
    throw new Error('FUZZ_RUNS must be a positive integer');
if (!Number.isSafeInteger(FUZZ_EDITOR_RUNS) || FUZZ_EDITOR_RUNS < 1)
    throw new Error('FUZZ_EDITOR_RUNS must be a positive integer');
export const ZONES = ['America/Los_Angeles', 'Asia/Kolkata', 'Australia/Adelaide', 'UTC'];
export const DATES = ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01', '2026-09-28', '2026-04-05', '2026-10-04'];
export const SLEEP_CASES = [
    { timeZone: 'America/Los_Angeles', date: '2026-03-08', on: '02:33', wake: '03:06', off: '03:06' },
    { timeZone: 'America/Los_Angeles', date: '2026-03-08', on: '02:50', wake: '03:20', off: '04:00' },
    { timeZone: 'UTC', date: '2026-09-28', on: '20:00', wake: '20:00', off: '20:00' },
    { timeZone: 'America/Los_Angeles', date: '2026-03-07', on: '20:00', wake: '20:00', off: '20:00' },
    { timeZone: 'America/Los_Angeles', date: '2026-10-31', on: '20:00', wake: '20:00', off: '20:00' },
    { timeZone: 'UTC', date: '2026-09-28', on: '12:00', wake: '12:10', off: '12:10' },
    { timeZone: 'UTC', date: '2026-09-28', on: '20:00', wake: '20:29', off: '20:45' },
    { timeZone: 'Australia/Adelaide', date: '2026-04-05', on: '01:50', wake: '03:20', off: '04:00' },
    { timeZone: 'Australia/Adelaide', date: '2026-10-04', on: '01:50', wake: '03:20', off: '04:00' },
    { timeZone: 'Australia/Adelaide', date: '2026-10-04', on: '02:50', wake: '03:20', off: '04:00' },
];
export function random(seed = FUZZ_SEED) {
    let state = seed;
    return (min, max) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return min + Math.floor(state / 4294967296 * (max - min + 1));
    };
}
export const choose = (values, next) => values[next(0, values.length - 1)];
export function check(condition, message) {
    if (!condition)
        throw new Error(message);
}
export function fuzzCase(input, run, verify) {
    try {
        verify();
    }
    catch (error) {
        throw new Error(`FUZZ_SEED=${FUZZ_SEED} run=${run} input=${JSON.stringify(input)}\n${String(error)}`);
    }
}
export const clock = (minute) => `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function options(next) {
    return { ...DEFAULT_SMART, baseLevel: next(-10, 10), intensity: choose(['gentle', 'standard'], next),
        warmStart: !!next(0, 1), warmUp: !!next(0, 1), upEarly: !!next(0, 1), ...(next(0, 1) ? { offWhenUp: true } : {}) };
}
export function curveInput(next) {
    const timeZone = choose(ZONES, next);
    const bedtime = moment.tz(`${choose(DATES, next)} ${clock(next(0, 1439))}`, 'YYYY-MM-DD HH:mm', timeZone).toDate();
    const duration = next(1, 960);
    const wake = new Date(bedtime.getTime() + duration * MINUTE);
    const offMode = next(0, 2);
    const offMinutes = offMode === 0 ? next(1, Math.max(1, duration - 1)) : offMode === 1 ? duration : duration + next(1, 180);
    const coolMode = next(0, 2);
    const coolDelay = coolMode === 0 ? next(-120, -1) : coolMode === 1 ? 0 : next(1, 960);
    return { smart: options(next), bedtime, wake, timeZone,
        coolStart: new Date(bedtime.getTime() + coolDelay * MINUTE),
        powerOff: new Date(bedtime.getTime() + offMinutes * MINUTE) };
}
export function assertCurve(points, input) {
    const bounds = curveBounds(input.smart.baseLevel);
    const start = input.bedtime.getTime() - prewarmMinutes(input.smart) * MINUTE;
    check(points.length > 0, 'curve is empty');
    let lastStep;
    const daySleep = isDaySleep(input.bedtime, input.wake, input.timeZone);
    const phases = ['prewarm', 'bedtime', 'cooldown', 'hold', 'warmup', 'wake', 'after'];
    points.forEach((point, index) => {
        const time = point.at.getTime();
        check(Number.isFinite(time) && time >= start && time < input.powerOff.getTime(), 'invalid point time or command at turn off');
        check(Number.isInteger(point.level) && point.level >= -10 && point.level <= 10
            && point.level >= bounds.min && point.level <= bounds.max, 'invalid level');
        check(input.smart.warmUp || point.phase !== 'warmup', 'warm-up with switch off');
        if (points[index + 1]?.at.getTime() !== time) {
            check(levelAt(points, point.at) === point.level && phaseAt(points, point.at) === point.phase, 'lookup disagrees at point');
        }
        const previous = points[index - 1];
        if (previous) {
            check(time >= previous.at.getTime(), 'points go backwards');
            if (point.level !== previous.level && point.phase !== 'after') {
                check(Math.abs(point.level - previous.level) === 1, 'level step exceeds one');
                if (lastStep) {
                    const cooling = point.phase === 'cooldown' || point.phase === 'hold';
                    const spacing = cooling ? CURVE.coolStepMinutes[daySleep ? 'day' : 'night'] : CURVE.warmStepMinutes;
                    check(time - lastStep.at.getTime() >= spacing * MINUTE, 'level steps too close');
                }
                lastStep = point;
            }
            check(phases.indexOf(point.phase) >= phases.indexOf(previous.phase), 'phase goes backwards');
            if (point.phase === 'cooldown' || point.phase === 'hold')
                check(point.level <= previous.level, 'warming during cool-down');
            if (time > previous.at.getTime()) {
                const between = new Date(time - 1);
                check(levelAt(points, between) === previous.level && phaseAt(points, between) === previous.phase, 'lookup disagrees between points');
            }
        }
    });
    if (!input.smart.warmStart || isDaySleep(input.bedtime, input.wake, input.timeZone)
        || input.wake.getTime() - input.bedtime.getTime() < CURVE.shortWindowMinutes * MINUTE) {
        check(points[0].level === input.smart.baseLevel, 'on level is not base for short/day sleep or warm start off');
    }
    check(phaseAt(points, new Date(start - 1)) === null, 'phase before start');
    check(levelAt(points, input.powerOff) === points[points.length - 1].level, 'last level is not held to off');
}
export function manualRhythm(next) {
    const on = next(0, 1439);
    const duration = next(1, 960);
    const wake = on + duration;
    const off = wake + choose([0, 15, 30, 60, next(1, 180)], next);
    const alarm = { enabled: !!next(0, 1), time: clock(wake), alarmTemperature: next(55, 110),
        vibrationIntensity: 30, vibrationPattern: 'double', duration: 10 };
    const temperatures = {};
    for (let index = 0, count = duration > 1 ? next(0, 6) : 0; index < count; index++) {
        temperatures[clock(on + next(1, duration - 1))] = next(55, 110);
    }
    return { id: 'generated', name: 'Generated rhythm', wake: clock(wake), temperatureMode: 'manual', smart: options(next),
        night: { power: { enabled: true, on: clock(on), off: clock(off), onTemperature: next(55, 110) },
            alarm, alarms: [alarm], temperatures } };
}
export function sleepInput(next, fixture) {
    const rhythm = manualRhythm(next);
    const timeZone = choose(ZONES, next);
    const date = choose(DATES, next);
    if (!fixture)
        return { rhythm, timeZone, date };
    rhythm.night.power = { ...rhythm.night.power, on: fixture.on, off: fixture.off };
    rhythm.wake = fixture.wake;
    rhythm.night.temperatures = {};
    rhythm.night.alarm = { ...rhythm.night.alarm, enabled: false, time: fixture.wake };
    rhythm.night.alarms = [rhythm.night.alarm];
    return { rhythm, timeZone: fixture.timeZone, date: fixture.date };
}
//# sourceMappingURL=smartFuzz.js.map