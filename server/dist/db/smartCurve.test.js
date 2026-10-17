import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import moment from 'moment-timezone';
import { buildCurve, curveBounds, CURVE, F_PER_LEVEL, isDaySleep, levelAt, levelToF, phaseAt, prewarmMinutes, warmsBeforeBedtime, } from './smartCurve.js';
import { DEFAULT_SMART } from './rhythmsSchema.js';
const TZ = 'America/Los_Angeles';
const MINUTE = 60_000;
const local = (text) => moment.tz(text, 'YYYY-MM-DD HH:mm', TZ).toDate();
const smart = (overrides = {}) => ({
    baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false, ...overrides,
});
const input = (overrides, bedtime, coolStart, wake, powerOff) => ({
    smart: smart(overrides),
    bedtime: local(bedtime),
    coolStart: local(coolStart),
    wake: local(wake),
    powerOff: local(powerOff),
    timeZone: TZ,
});
const asLocal = (points) => points.map(point => [moment(point.at).tz(TZ).format('YYYY-MM-DD HH:mm'), point.level, point.phase]);
const asUtc = (points) => points.map(point => [point.at.toISOString().slice(0, 16), point.level, point.phase]);
describe('levelToF', () => {
    it('matches the app level mapping', () => {
        const expected = [
            [-10, 55], [-8, 61], [-3, 74], [-2, 77], [-1, 80], [0, 83], [1, 85], [2, 88], [3, 91], [5, 96], [10, 110],
        ];
        for (const [level, fahrenheit] of expected)
            assert.equal(levelToF(level), fahrenheit, `level ${level}`);
    });
});
describe('isDaySleep', () => {
    it('is false for an ordinary night', () => {
        assert.equal(isDaySleep(local('2026-09-29 22:45'), local('2026-09-30 06:30'), TZ), false);
    });
    it('is true when the midpoint falls between 09:00 and 17:00', () => {
        assert.equal(isDaySleep(local('2026-09-30 08:30'), local('2026-09-30 15:00'), TZ), true);
    });
    it('includes both edges and nothing outside them', () => {
        assert.equal(isDaySleep(local('2026-09-30 06:00'), local('2026-09-30 12:00'), TZ), true); // 09:00
        assert.equal(isDaySleep(local('2026-09-30 05:58'), local('2026-09-30 12:00'), TZ), false); // 08:59
        assert.equal(isDaySleep(local('2026-09-30 14:00'), local('2026-09-30 20:00'), TZ), true); // 17:00
        assert.equal(isDaySleep(local('2026-09-30 14:02'), local('2026-09-30 20:00'), TZ), false); // 17:01
    });
});
describe('curveBounds', () => {
    it('keeps points within [max(B-3,-8), min(B+2,+5)] without excluding the base', () => {
        assert.deepEqual(curveBounds(0), { min: -3, max: 2 });
        assert.deepEqual(curveBounds(4), { min: 1, max: 5 });
        assert.deepEqual(curveBounds(5), { min: 2, max: 5 });
        assert.deepEqual(curveBounds(7), { min: 4, max: 7 });
        assert.deepEqual(curveBounds(-6), { min: -8, max: -4 });
        assert.deepEqual(curveBounds(-10), { min: -10, max: -8 });
    });
});
describe('buildCurve worked examples', () => {
    it('standard night, B=0, bed 22:45, confirmed 23:00, wake 06:30', () => {
        const points = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 23:00', '2026-09-30 06:30', '2026-09-30 07:30'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-29 22:15', 2, 'prewarm'],
            ['2026-09-29 22:45', 2, 'bedtime'],
            ['2026-09-29 23:10', 2, 'cooldown'],
            ['2026-09-29 23:25', 1, 'cooldown'],
            ['2026-09-29 23:40', 0, 'cooldown'],
            ['2026-09-29 23:55', -1, 'cooldown'],
            ['2026-09-30 00:10', -2, 'hold'],
            ['2026-09-30 05:45', -2, 'warmup'],
            ['2026-09-30 05:56', -1, 'warmup'],
            ['2026-09-30 06:07', 0, 'warmup'],
            ['2026-09-30 06:18', 1, 'warmup'],
            ['2026-09-30 06:30', 2, 'wake'],
            ['2026-09-30 07:00', 0, 'after'],
        ]);
    });
    it('day sleep, B=-1, bed 08:30 on the clock, wake 15:00', () => {
        const points = buildCurve(input({ baseLevel: -1 }, '2026-09-30 08:30', '2026-09-30 08:30', '2026-09-30 15:00', '2026-09-30 16:00'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-30 08:00', -1, 'prewarm'],
            ['2026-09-30 08:30', -1, 'bedtime'],
            ['2026-09-30 08:35', -1, 'cooldown'],
            ['2026-09-30 08:45', -2, 'cooldown'],
            ['2026-09-30 08:55', -3, 'hold'],
            ['2026-09-30 14:35', -3, 'warmup'],
            ['2026-09-30 14:40', -2, 'warmup'],
            ['2026-09-30 14:50', -1, 'warmup'],
            ['2026-09-30 15:00', 0, 'wake'],
            ['2026-09-30 15:30', -1, 'after'],
        ]);
    });
});
describe('buildCurve variants', () => {
    it('starts the cool-down at bedtime on the clock trigger', () => {
        const points = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
        assert.deepEqual(asLocal(points).slice(2, 7), [
            ['2026-09-29 22:55', 2, 'cooldown'],
            ['2026-09-29 23:10', 1, 'cooldown'],
            ['2026-09-29 23:25', 0, 'cooldown'],
            ['2026-09-29 23:40', -1, 'cooldown'],
            ['2026-09-29 23:55', -2, 'hold'],
        ]);
    });
    it('gentle night uses a 20 minute pre-warm, B+1, B-1 and a 30 minute lead', () => {
        const points = buildCurve(input({ intensity: 'gentle' }, '2026-09-29 23:00', '2026-09-29 23:00', '2026-09-30 07:00', '2026-09-30 08:00'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-29 22:40', 1, 'prewarm'],
            ['2026-09-29 23:00', 1, 'bedtime'],
            ['2026-09-29 23:10', 1, 'cooldown'],
            ['2026-09-29 23:25', 0, 'cooldown'],
            ['2026-09-29 23:40', -1, 'hold'],
            ['2026-09-30 06:30', -1, 'warmup'],
            ['2026-09-30 06:45', 0, 'warmup'],
            ['2026-09-30 07:00', 1, 'wake'],
            ['2026-09-30 07:30', 0, 'after'],
        ]);
    });
    it('warm start off begins at the base level', () => {
        const points = buildCurve(input({ warmStart: false }, '2026-09-29 22:00', '2026-09-29 22:00', '2026-09-30 06:00', '2026-09-30 07:00'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-29 21:30', 0, 'prewarm'],
            ['2026-09-29 22:00', 0, 'bedtime'],
            ['2026-09-29 22:10', 0, 'cooldown'],
            ['2026-09-29 22:25', -1, 'cooldown'],
            ['2026-09-29 22:40', -2, 'hold'],
            ['2026-09-30 05:15', -2, 'warmup'],
            ['2026-09-30 05:26', -1, 'warmup'],
            ['2026-09-30 05:37', 0, 'warmup'],
            ['2026-09-30 05:48', 1, 'warmup'],
            ['2026-09-30 06:00', 2, 'wake'],
            ['2026-09-30 06:30', 0, 'after'],
        ]);
    });
    it('warm-up off holds until wake', () => {
        const points = buildCurve(input({ warmUp: false }, '2026-09-29 22:00', '2026-09-29 22:00', '2026-09-30 06:00', '2026-09-30 07:00'));
        assert.deepEqual(asLocal(points).slice(-3), [
            ['2026-09-29 23:10', -2, 'hold'],
            ['2026-09-30 06:00', -2, 'wake'],
            ['2026-09-30 06:30', 0, 'after'],
        ]);
    });
    it('a window under 3 hours uses B, B-1, a 15 minute lead and B+1', () => {
        const points = buildCurve(input({}, '2026-09-29 19:00', '2026-09-29 19:00', '2026-09-29 21:30', '2026-09-29 22:30'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-29 18:30', 0, 'prewarm'],
            ['2026-09-29 19:00', 0, 'bedtime'],
            ['2026-09-29 19:10', 0, 'cooldown'],
            ['2026-09-29 19:25', -1, 'hold'],
            ['2026-09-29 21:15', -1, 'warmup'],
            ['2026-09-29 21:20', 0, 'warmup'],
            ['2026-09-29 21:30', 1, 'wake'],
            ['2026-09-29 22:00', 0, 'after'],
        ]);
    });
    it('a window under 90 minutes stays flat at B, then +1 over the last 15 minutes', () => {
        const points = buildCurve(input({}, '2026-09-29 19:00', '2026-09-29 19:00', '2026-09-29 20:00', '2026-09-29 21:00'));
        assert.deepEqual(asLocal(points), [
            ['2026-09-29 18:30', 0, 'prewarm'],
            ['2026-09-29 19:00', 0, 'bedtime'],
            ['2026-09-29 19:45', 1, 'warmup'],
            ['2026-09-29 20:00', 1, 'wake'],
            ['2026-09-29 20:30', 0, 'after'],
        ]);
    });
    it('a late start never compresses the warm-up', () => {
        const late = buildCurve(input({}, '2026-09-29 22:00', '2026-09-30 00:00', '2026-09-30 01:30', '2026-09-30 02:00'));
        assert.deepEqual(asLocal(late), [
            ['2026-09-29 21:30', 2, 'prewarm'],
            ['2026-09-29 22:00', 2, 'bedtime'],
            ['2026-09-30 00:10', 2, 'cooldown'],
            ['2026-09-30 00:25', 1, 'cooldown'],
            ['2026-09-30 00:40', 0, 'cooldown'],
            ['2026-09-30 01:00', 0, 'warmup'],
            ['2026-09-30 01:15', 1, 'warmup'],
            ['2026-09-30 01:30', 2, 'wake'],
        ]);
    });
    it('treats a cool start before bedtime as bedtime', () => {
        const early = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 22:00', '2026-09-30 06:30', '2026-09-30 07:30'));
        const clock = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
        assert.deepEqual(asLocal(early), asLocal(clock));
    });
    it('rounds a cool start with seconds up to the next minute', () => {
        const points = buildCurve({
            ...input({}, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'),
            coolStart: new Date(local('2026-09-29 23:00').getTime() + 20_000),
        });
        assert.deepEqual(asLocal(points)[2], ['2026-09-29 23:11', 2, 'cooldown']);
    });
    it('without an alarm, the wake is the power off and no point reaches it', () => {
        const points = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 06:30'));
        assert.deepEqual(asLocal(points).slice(-2), [
            ['2026-09-30 06:07', 0, 'warmup'],
            ['2026-09-30 06:18', 1, 'warmup'],
        ]);
    });
    it('adds no warm bumps when the base is +5 or higher', () => {
        for (const baseLevel of [5, 7]) {
            const points = buildCurve(input({ baseLevel }, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
            assert.ok(points.every(point => point.level <= baseLevel), `B=${baseLevel}`);
            assert.equal(points[0].level, baseLevel);
            assert.equal(Math.min(...points.map(point => point.level)), baseLevel - 2);
        }
    });
    it('never goes below -8 unless the base is lower', () => {
        const cold = buildCurve(input({ baseLevel: -7 }, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
        assert.equal(Math.min(...cold.map(point => point.level)), -8);
        const coldest = buildCurve(input({ baseLevel: -10 }, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
        assert.deepEqual([...new Set(coldest.map(point => point.level))].sort((a, b) => a - b), [-10, -9, -8]);
    });
});
describe('buildCurve across DST', () => {
    it('fall back night keeps absolute spacing', () => {
        const points = buildCurve({
            smart: smart(),
            bedtime: new Date('2026-11-01T05:45:00Z'), // Oct 31 22:45 PDT
            coolStart: new Date('2026-11-01T05:45:00Z'),
            wake: new Date('2026-11-01T14:30:00Z'), // Nov 1 06:30 PST
            powerOff: new Date('2026-11-01T15:30:00Z'),
            timeZone: TZ,
        });
        assert.deepEqual(asUtc(points), [
            ['2026-11-01T05:15', 2, 'prewarm'],
            ['2026-11-01T05:45', 2, 'bedtime'],
            ['2026-11-01T05:55', 2, 'cooldown'],
            ['2026-11-01T06:10', 1, 'cooldown'],
            ['2026-11-01T06:25', 0, 'cooldown'],
            ['2026-11-01T06:40', -1, 'cooldown'],
            ['2026-11-01T06:55', -2, 'hold'],
            ['2026-11-01T13:45', -2, 'warmup'],
            ['2026-11-01T13:56', -1, 'warmup'],
            ['2026-11-01T14:07', 0, 'warmup'],
            ['2026-11-01T14:18', 1, 'warmup'],
            ['2026-11-01T14:30', 2, 'wake'],
            ['2026-11-01T15:00', 0, 'after'],
        ]);
    });
    it('spring forward night sizes the lead from the real window', () => {
        const points = buildCurve({
            smart: smart(),
            bedtime: new Date('2026-03-08T06:45:00Z'), // Mar 7 22:45 PST
            coolStart: new Date('2026-03-08T06:45:00Z'),
            wake: new Date('2026-03-08T13:30:00Z'), // Mar 8 06:30 PDT, 6 h 45 min later
            powerOff: new Date('2026-03-08T14:30:00Z'),
            timeZone: TZ,
        });
        assert.deepEqual(asUtc(points).slice(-6), [
            ['2026-03-08T12:49', -2, 'warmup'],
            ['2026-03-08T12:59', -1, 'warmup'],
            ['2026-03-08T13:09', 0, 'warmup'],
            ['2026-03-08T13:19', 1, 'warmup'],
            ['2026-03-08T13:30', 2, 'wake'],
            ['2026-03-08T14:00', 0, 'after'],
        ]);
    });
});
function assertInvariants(points, curve, label) {
    const bounds = curveBounds(curve.smart.baseLevel);
    const firstAllowed = curve.bedtime.getTime() - prewarmMinutes(curve.smart) * MINUTE;
    const day = isDaySleep(curve.bedtime, curve.wake, curve.timeZone);
    const coolStep = (day ? CURVE.coolStepMinutes.day : CURVE.coolStepMinutes.night) * MINUTE;
    assert.equal(points[0].phase, 'prewarm', label);
    assert.equal(points[0].at.getTime(), firstAllowed, label);
    let lastChangeAt = points[0].at.getTime();
    for (let index = 0; index < points.length; index++) {
        const point = points[index];
        const at = point.at.getTime();
        assert.ok(at >= firstAllowed && at < curve.powerOff.getTime(), `${label} point inside the power window`);
        assert.ok(point.level >= bounds.min && point.level <= bounds.max, `${label} level within clamps`);
        assert.ok(Number.isInteger(point.level) && point.level >= -10 && point.level <= 10, label);
        assert.equal(at % MINUTE, 0, `${label} whole minutes`);
        if (index === 0)
            continue;
        const previous = points[index - 1];
        assert.ok(at > previous.at.getTime(), `${label} strictly increasing`);
        const change = point.level - previous.level;
        if (change === 0 || point.phase === 'after')
            continue;
        assert.ok(Math.abs(change) === 1, `${label} one level per step`);
        const gap = at - lastChangeAt;
        assert.ok(gap >= (change < 0 ? coolStep : CURVE.warmStepMinutes * MINUTE), `${label} rate limit`);
        lastChangeAt = at;
    }
    if (curve.smart.warmUp) {
        const wakePoint = points.find(point => point.phase === 'wake');
        if (curve.wake.getTime() < curve.powerOff.getTime())
            assert.equal(wakePoint?.at.getTime(), curve.wake.getTime(), label);
    }
}
describe('buildCurve invariants', () => {
    const bedtimes = ['2026-09-29 21:00', '2026-09-29 23:30', '2026-09-30 08:00', '2026-09-30 13:00'];
    const windows = [30, 75, 100, 170, 200, 330, 480, 600, 720];
    const delays = [0, 15, 40, 90, 120];
    const flags = [true, false];
    it('holds for every base, intensity, switch, window and delay', () => {
        let checked = 0;
        for (let baseLevel = -10; baseLevel <= 10; baseLevel++) {
            for (const intensity of ['gentle', 'standard']) {
                for (const warmStart of flags) {
                    for (const warmUp of flags) {
                        for (const bed of bedtimes) {
                            for (const windowMinutes of windows) {
                                for (const delay of delays) {
                                    const bedtime = local(bed);
                                    const wake = new Date(bedtime.getTime() + windowMinutes * MINUTE);
                                    const powerOff = new Date(wake.getTime() + 60 * MINUTE);
                                    const curve = {
                                        smart: smart({ baseLevel, intensity, warmStart, warmUp }),
                                        bedtime,
                                        coolStart: new Date(bedtime.getTime() + delay * MINUTE),
                                        wake,
                                        powerOff,
                                        timeZone: TZ,
                                    };
                                    const label = JSON.stringify({ baseLevel, intensity, warmStart, warmUp, bed, windowMinutes, delay });
                                    assertInvariants(buildCurve(curve), curve, label);
                                    checked++;
                                }
                            }
                        }
                    }
                }
            }
        }
        assert.equal(checked, 21 * 2 * 2 * 2 * 4 * 9 * 5);
    });
});
describe('levelAt and phaseAt', () => {
    const points = buildCurve(input({}, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
    it('returns the level and phase in effect', () => {
        assert.equal(levelAt(points, local('2026-09-30 02:00')), -2);
        assert.equal(phaseAt(points, local('2026-09-30 02:00')), 'hold');
        assert.equal(levelAt(points, local('2026-09-30 06:20')), 1);
        assert.equal(phaseAt(points, local('2026-09-30 06:20')), 'warmup');
        assert.equal(levelAt(points, local('2026-09-29 21:00')), 2);
        assert.equal(phaseAt(points, local('2026-09-29 21:00')), null);
        assert.equal(levelAt([], local('2026-09-29 21:00')), null);
    });
});
describe('warmsBeforeBedtime', () => {
    const night = (smart) => buildCurve(input(smart, '2026-09-29 22:45', '2026-09-29 22:45', '2026-09-30 06:30', '2026-09-30 07:30'));
    it('is true only when the pre-warm is above neutral', () => {
        assert.equal(warmsBeforeBedtime(night({})), true);
        assert.equal(warmsBeforeBedtime(night({ baseLevel: -1 })), true);
        assert.equal(warmsBeforeBedtime(night({ warmStart: false })), false);
        assert.equal(warmsBeforeBedtime(night({ baseLevel: -1, warmStart: false })), false);
        assert.equal(warmsBeforeBedtime(night({ baseLevel: 5 })), true);
        assert.equal(warmsBeforeBedtime([]), false);
    });
    it('is false for a cool sleeper whose warm start still pre-warms below neutral', () => {
        const cool = night({ baseLevel: -7 });
        assert.equal(cool[0].phase, 'prewarm');
        assert.ok(cool[0].level < 0);
        assert.equal(warmsBeforeBedtime(cool), false);
        assert.equal(warmsBeforeBedtime(night({ baseLevel: -2 })), false); // -2 plus the warm start lands on 0, which is neutral
    });
});
describe('"When I get up"', () => {
    const shapeOf = (smart, bedtime, wake) => ({
        smart: { ...DEFAULT_SMART, ...smart },
        bedtime: new Date(bedtime),
        coolStart: new Date(bedtime),
        wake: new Date(wake),
        powerOff: new Date(Date.parse(wake) + 60 * 60_000),
        timeZone: 'America/Los_Angeles',
    });
    it('holds the wake level to the end instead of dropping back to the base', () => {
        const shapes = [
            shapeOf({}, '2026-09-30T05:45:00Z', '2026-09-30T13:30:00Z'),
            shapeOf({ warmUp: false }, '2026-09-30T05:45:00Z', '2026-09-30T13:30:00Z'),
            shapeOf({}, '2026-09-30T05:45:00Z', '2026-09-30T08:15:00Z'),
            shapeOf({}, '2026-09-30T05:45:00Z', '2026-09-30T06:45:00Z'),
        ];
        for (const shape of shapes) {
            const before = buildCurve(shape);
            const after = buildCurve({ ...shape, smart: { ...shape.smart, offWhenUp: true } });
            assert.equal(before.at(-1)?.phase, 'after');
            assert.deepEqual(after, before.slice(0, -1));
            assert.equal(after.at(-1)?.phase, 'wake');
        }
    });
});
it('steps 2.75 °F per level, the same mapping as levelToF', () => {
    assert.equal(F_PER_LEVEL, 2.75);
    assert.equal(levelToF(-1), Math.round(82.5 - F_PER_LEVEL));
});
//# sourceMappingURL=smartCurve.test.js.map