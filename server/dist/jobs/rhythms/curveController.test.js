import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import moment from 'moment-timezone';
import { applySmartCurve } from './smartSleep.js';
import { CurveController } from './curveController.js';
const TZ = 'America/Los_Angeles';
const MINUTE = 60_000;
const local = (text) => moment.tz(text, 'YYYY-MM-DD HH:mm', TZ).toDate();
const DATE = '2026-09-29';
const ALARM = {
    time: '06:30', enabled: true, alarmTemperature: 82, vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60,
};
// 22:45 to 07:30 with a 06:30 alarm, resolved the way resolveSleeps does before the curve.
function baseSleep(side, smart, bedtime = '22:45', rhythmId = 'workday') {
    const start = local(`${DATE} ${bedtime}`);
    const end = local('2026-09-30 07:30');
    return {
        side,
        date: DATE,
        rhythmId,
        start,
        end,
        wake: local('2026-09-30 06:30'),
        night: { temperatures: {}, alarm: ALARM, alarms: [], power: { on: bedtime, off: '07:30', onTemperature: 80, enabled: true } },
        mode: 'smart',
        smart,
        events: [
            { kind: 'power-on', at: start, temperatureF: 80 },
            { kind: 'alarm', at: local('2026-09-30 06:30'), alarm: ALARM, index: 0 },
            { kind: 'power-off', at: end },
        ],
    };
}
function harness(options = {}) {
    const smartOf = () => ({
        baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false, ...options.smart,
    });
    const sleepOf = (side) => baseSleep(side, smartOf(), options.bedtime, options.rhythmId);
    let clock = local(options.start ?? `${DATE} 21:00`);
    const presence = { left: { present: false }, right: { present: false } };
    const applied = [];
    const reasons = [];
    const history = [];
    let retimes = 0;
    const controller = new CurveController({
        now: () => clock,
        presence: () => presence,
        awayMode: () => options.away ?? { left: false, right: false },
        isPaused: (_side, now) => (typeof options.paused === 'function' ? options.paused(now) : options.paused ?? false),
        sleeps: (side, from, to) => {
            if (side !== 'left')
                return [];
            const base = sleepOf(side);
            const sleep = options.manualSleep
                ? { ...base, mode: 'manual' }
                : applySmartCurve(base, TZ, controller.coolStartFor(side, DATE));
            return sleep.start < to && sleep.end > from ? [sleep] : [];
        },
        applyLevel: async (side, level, reason) => {
            reasons.push(reason);
            applied.push([side, level, moment(clock).tz(TZ).format('HH:mm')]);
        },
        retime: () => { retimes += 1; },
        recordHistory: async (summary) => { history.push(summary); },
    });
    // Mirrors POST /api/metrics/presence: stateChangedAt moves only on a change.
    const report = (side, present) => {
        const stamp = moment(clock).tz(TZ).format();
        const current = presence[side];
        if (!current.stateChangedAt || current.present !== present)
            current.stateChangedAt = stamp;
        current.present = present;
        current.lastUpdatedAt = stamp;
    };
    const runUntil = async (text, stream = () => ({})) => {
        const end = local(text).getTime();
        while (clock.getTime() < end) {
            clock = new Date(clock.getTime() + MINUTE);
            const reports = stream(clock);
            for (const side of ['left', 'right']) {
                const value = reports[side];
                if (value !== undefined)
                    report(side, value);
            }
            await controller.tick();
        }
    };
    const curve = () => {
        const resolved = applySmartCurve(sleepOf('left'), TZ, controller.coolStartFor('left', DATE)).smartCurve;
        assert.ok(resolved);
        return resolved;
    };
    return {
        controller, applied, reasons, history, runUntil,
        retimes: () => retimes,
        now: () => clock,
        curve,
    };
}
const between = (now, from, to) => now >= local(from) && now < local(to);
describe('CurveController start', () => {
    it('runs on the clock without biometrics', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31');
        assert.equal(h.retimes(), 0);
        assert.deepEqual(h.applied, []);
        assert.equal(h.history.length, 1);
        assert.equal(h.history[0].startReason, 'unknown');
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
        assert.equal(h.history[0].confirmedAt, null);
    });
    it('delays the cool-down to a confirmation after bedtime', async () => {
        const h = harness();
        const stream = now => ({ left: now >= local(`${DATE} 22:40`) });
        await h.runUntil(`${DATE} 22:46`, stream);
        assert.equal(h.retimes(), 1, 'held at the cap while waiting');
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local('2026-09-30 00:45').getTime());
        await h.runUntil(`${DATE} 23:01`, stream);
        assert.equal(h.retimes(), 2);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 23:00`).getTime());
        const cooldown = h.curve().points.filter(point => point.phase === 'cooldown' || point.phase === 'hold');
        assert.equal(cooldown[0].at.getTime(), local(`${DATE} 23:10`).getTime());
        assert.equal(cooldown.at(-1)?.at.getTime(), local('2026-09-30 00:10').getTime());
    });
    it('counts early presence only from the window opening and keeps the clock', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', () => ({ left: true }));
        assert.equal(h.retimes(), 0);
        assert.equal(h.history[0].startReason, 'confirmed');
        assert.equal(h.history[0].confirmedAt, local(`${DATE} 22:05`).toISOString());
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
    });
    it('starts at the 2 hour cap when presence never settles', async () => {
        const h = harness();
        const flapping = now => ({ left: Math.floor(now.getTime() / (10 * MINUTE)) % 2 === 0 });
        await h.runUntil('2026-09-30 07:31', flapping);
        assert.equal(h.history[0].startReason, 'cap');
        assert.equal(h.history[0].coolStart, local('2026-09-30 00:45').toISOString());
        assert.equal(h.retimes(), 1);
    });
    it('starts cooling from now when presence goes stale while waiting', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', now => (now < local(`${DATE} 23:00`) ? { left: false } : {}));
        assert.equal(h.history[0].startReason, 'stale');
        assert.equal(h.history[0].coolStart, local(`${DATE} 23:05`).toISOString());
        assert.equal(h.retimes(), 2);
    });
    it('ignores a bathroom break once started', async () => {
        const h = harness();
        const stream = now => ({ left: !between(now, '2026-09-30 02:00', '2026-09-30 02:12') });
        await h.runUntil('2026-09-30 05:00', stream);
        assert.equal(h.retimes(), 0);
        assert.deepEqual(h.applied, []);
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 05:45')), 'run');
    });
    it('accepts presence on either side for a lone sleeper', async () => {
        const lone = harness({ away: { left: false, right: true } });
        await lone.runUntil(`${DATE} 23:30`, () => ({ right: true }));
        assert.equal(lone.controller.status('left', lone.now())?.start.status, 'decided');
        const shared = harness();
        await shared.runUntil(`${DATE} 23:30`, () => ({ left: false, right: true }));
        assert.deepEqual(shared.controller.status('left', shared.now())?.start, { status: 'waiting' });
    });
    it('does not track a sleep while it stays paused', async () => {
        const h = harness({ paused: true });
        await h.runUntil('2026-09-30 07:31', () => ({ left: true }));
        assert.equal(h.history.length, 0);
        assert.equal(h.controller.coolStartFor('left', DATE), undefined);
    });
    it('tracks a sleep paused when first seen as not observed once the pause ends', async () => {
        const h = harness({ paused: now => now < local(`${DATE} 23:30`) });
        await h.runUntil('2026-09-30 07:31', () => ({ left: true }));
        assert.equal(h.retimes(), 0);
        assert.equal(h.history[0].startReason, 'not-observed');
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
    });
});
describe('CurveController presence dropouts', () => {
    const inBedExcept = (from, gaps) => now => ({
        left: now >= local(`${DATE} ${from}`) && !gaps.some(([a, b]) => between(now, `${DATE} ${a}`, `${DATE} ${b}`)),
    });
    it('keeps the run through short false absences', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', inBedExcept('22:34', [['22:39', '22:41'], ['22:49', '22:50'], ['23:00', '23:02']]));
        assert.equal(h.history[0].startReason, 'confirmed');
        assert.equal(h.history[0].confirmedAt, local(`${DATE} 22:54`).toISOString());
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:54`).toISOString());
    });
    it('merges an absence of exactly 3 minutes', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', inBedExcept('22:40', [['22:49', '22:52']]));
        assert.equal(h.history[0].confirmedAt, local(`${DATE} 23:00`).toISOString());
    });
    it('restarts the run after an absence longer than 3 minutes', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', inBedExcept('22:40', [['22:49', '22:53']]));
        assert.equal(h.history[0].confirmedAt, local(`${DATE} 23:13`).toISOString());
        assert.equal(h.history[0].coolStart, local(`${DATE} 23:13`).toISOString());
    });
    it('never starts a merged run before bedtime or counts it before the window opens', async () => {
        const early = harness();
        await early.runUntil('2026-09-30 07:31', inBedExcept('21:00', [['21:50', '21:52']]));
        assert.equal(early.history[0].confirmedAt, local(`${DATE} 22:05`).toISOString());
        assert.equal(early.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
        const h = harness();
        await h.runUntil('2026-09-30 07:31', inBedExcept('22:00', [['22:10', '22:12'], ['22:25', '22:27']]));
        assert.equal(h.history[0].confirmedAt, local(`${DATE} 22:20`).toISOString());
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
        assert.equal(h.retimes(), 0);
    });
});
describe('CurveController dropping a sleep', () => {
    const waiting = now => ({ left: now >= local(`${DATE} 22:40`) });
    it('replans when a sleep with a moved cool-down start stops being smart', async () => {
        const options = { manualSleep: false };
        const h = harness(options);
        await h.runUntil(`${DATE} 22:46`, waiting);
        assert.equal(h.retimes(), 1);
        options.manualSleep = true;
        await h.runUntil(`${DATE} 22:47`, waiting);
        assert.equal(h.controller.coolStartFor('left', DATE), undefined);
        assert.equal(h.retimes(), 2);
    });
    it('replans when its side goes away', async () => {
        const options = { away: { left: false, right: false } };
        const h = harness(options);
        await h.runUntil(`${DATE} 22:46`, waiting);
        options.away = { left: true, right: false };
        await h.runUntil(`${DATE} 22:47`, waiting);
        assert.equal(h.retimes(), 2);
    });
    it('replans when an edit moves its bedtime out of the window', async () => {
        const options = { bedtime: '22:45' };
        const h = harness(options);
        await h.runUntil(`${DATE} 22:46`, waiting);
        assert.equal(h.retimes(), 1);
        options.bedtime = '23:50';
        await h.runUntil(`${DATE} 22:47`, waiting);
        assert.equal(h.controller.coolStartFor('left', DATE), undefined);
        assert.equal(h.retimes(), 2);
    });
    it('does not replan for a start that stayed at bedtime', async () => {
        const options = { manualSleep: false };
        const h = harness(options);
        await h.runUntil(`${DATE} 23:00`, () => ({ left: true }));
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 22:45`).getTime());
        options.manualSleep = true;
        await h.runUntil(`${DATE} 23:01`, () => ({ left: true }));
        assert.equal(h.retimes(), 0);
    });
    it('does not replan for a sleep still on the clock', async () => {
        const options = { manualSleep: false };
        const h = harness(options);
        await h.runUntil(`${DATE} 22:00`);
        options.manualSleep = true;
        await h.runUntil(`${DATE} 22:01`);
        assert.equal(h.retimes(), 0);
    });
});
describe('CurveController manual hold', () => {
    it('holds until the warm-up or at most 3 hours, then resumes the curve', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 02:00');
        assert.equal(h.controller.noteManualChange('left', h.now()), 'held');
        const held = h.controller.status('left', h.now());
        assert.equal(held?.holdUntil?.getTime(), local('2026-09-30 05:00').getTime());
        assert.deepEqual(held?.nextChange, { at: local('2026-09-30 05:56'), level: -1, phase: 'warmup' });
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 04:59')), 'hold');
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 05:00')), 'run');
        await h.runUntil('2026-09-30 05:01');
        assert.deepEqual(h.applied, [['left', -2, '05:00']]);
        assert.equal(h.reasons.at(-1), 'hold-end');
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 05:45')), 'run');
    });
    it('holds only to the end of the cool-down when that comes first', async () => {
        const h = harness();
        await h.runUntil(`${DATE} 23:30`);
        h.controller.noteManualChange('left', h.now());
        assert.equal(h.controller.gate('left', DATE, local(`${DATE} 23:40`)), 'hold');
        assert.equal(h.controller.gate('left', DATE, local(`${DATE} 23:55`)), 'run');
        await h.runUntil('2026-09-30 07:31');
        assert.deepEqual(h.history[0].manualChanges, { cooldown: 1 });
    });
    it('maps an away side to the sleep that drives the bed', async () => {
        const h = harness({ away: { left: false, right: true } });
        await h.runUntil('2026-09-30 02:00');
        assert.equal(h.controller.noteManualChange('right', h.now()), 'held');
    });
    it('does not hold before a smart sleep, and leaves other sleeps to the legacy rule', async () => {
        const before = harness({ start: `${DATE} 20:00` });
        assert.equal(before.controller.noteManualChange('left', before.now()), 'smart-ahead');
        const early = harness({ start: `${DATE} 18:00` });
        assert.equal(early.controller.noteManualChange('left', early.now()), 'not-smart');
        const manual = harness({ manualSleep: true, start: '2026-09-30 01:00' });
        assert.equal(manual.controller.noteManualChange('left', manual.now()), 'not-smart');
    });
});
describe('CurveController manual hold boundaries', () => {
    it('holds until the next phase starts, at most 3 hours, in every phase', async () => {
        const cases = [
            [`${DATE} 22:20`, `${DATE} 22:55`], // pre-warm: until the cool-down starts
            [`${DATE} 22:50`, `${DATE} 22:55`], // bedtime: the same stretch as the pre-warm
            [`${DATE} 23:30`, `${DATE} 23:55`], // cool-down: until the hold level
            ['2026-09-30 02:00', '2026-09-30 05:00'], // hold: 3 hours come first
            ['2026-09-30 05:30', '2026-09-30 05:45'], // hold: until the warm-up
            ['2026-09-30 06:00', '2026-09-30 06:30'], // warm-up: until the wake
            ['2026-09-30 06:40', '2026-09-30 07:00'], // wake: until the after-wake level
            ['2026-09-30 07:10', '2026-09-30 07:30'], // after wake: until the power off
        ];
        for (const [changeAt, until] of cases) {
            const h = harness();
            await h.runUntil(changeAt);
            assert.equal(h.controller.noteManualChange('left', h.now()), 'held', changeAt);
            assert.equal(h.controller.status('left', h.now())?.holdUntil?.getTime(), local(until).getTime(), changeAt);
        }
    });
    it('lets the cool-down run after a change during the pre-warm', async () => {
        const h = harness();
        await h.runUntil(`${DATE} 22:20`);
        h.controller.noteManualChange('left', h.now());
        assert.equal(h.controller.gate('left', DATE, local(`${DATE} 22:45`)), 'hold');
        assert.equal(h.controller.gate('left', DATE, local(`${DATE} 22:55`)), 'run');
        await h.runUntil(`${DATE} 22:56`);
        assert.deepEqual(h.applied, [['left', 2, '22:55']]);
        assert.equal(h.controller.gate('left', DATE, local(`${DATE} 23:10`)), 'run');
    });
    it('moves the end of a pre-warm hold with a cool-down start that presence delays', async () => {
        const h = harness();
        const stream = now => ({ left: now >= local(`${DATE} 22:40`) });
        await h.runUntil(`${DATE} 22:20`, stream);
        h.controller.noteManualChange('left', h.now());
        assert.equal(h.controller.status('left', h.now())?.holdUntil?.getTime(), local(`${DATE} 22:55`).getTime());
        await h.runUntil(`${DATE} 23:02`, stream);
        assert.equal(h.controller.status('left', h.now())?.holdUntil?.getTime(), local(`${DATE} 23:10`).getTime());
        assert.deepEqual(h.applied, []);
        await h.runUntil(`${DATE} 23:11`, stream);
        assert.deepEqual(h.applied, [['left', 2, '23:10']]);
    });
});
describe('CurveController start decided after bedtime', () => {
    const pausedUntil2330 = (now) => between(now, `${DATE} 22:00`, `${DATE} 23:30`);
    it('keeps the clock when the start is decided at a bedtime already past', async () => {
        const h = harness({ paused: pausedUntil2330 });
        await h.runUntil(`${DATE} 23:31`);
        assert.equal(h.controller.status('left', h.now())?.start.status, 'decided');
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 22:45`).getTime());
        assert.equal(h.retimes(), 0);
        await h.runUntil('2026-09-30 07:31');
        assert.deepEqual(h.applied, []);
        assert.equal(h.history[0].startReason, 'unknown');
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
    });
    it('ends a pre-warm hold on the clock curve and applies its level', async () => {
        const h = harness({ paused: pausedUntil2330 });
        await h.runUntil(`${DATE} 22:20`);
        h.controller.noteManualChange('left', h.now());
        await h.runUntil(`${DATE} 23:31`);
        assert.equal(h.retimes(), 0);
        assert.equal(h.controller.status('left', h.now())?.holdUntil, null);
        assert.deepEqual(h.applied, [['left', 0, '23:30']]);
    });
    it('keeps a pre-warm hold through a pause until the cool-down that presence delays', async () => {
        const h = harness({ paused: now => between(now, `${DATE} 22:30`, `${DATE} 23:12`) });
        const stream = now => (now >= local(`${DATE} 23:00`) ? { left: true } : {});
        await h.runUntil(`${DATE} 22:20`, stream);
        h.controller.noteManualChange('left', h.now());
        await h.runUntil(`${DATE} 23:12`, stream);
        assert.deepEqual(h.controller.status('left', h.now())?.start, { status: 'waiting' });
        assert.deepEqual(h.applied, []);
        await h.runUntil(`${DATE} 23:31`, stream);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 23:20`).getTime());
        assert.deepEqual(h.applied, [['left', 2, '23:30']]);
    });
    it('records a sleep first seen after bedtime as not observed, on the clock', async () => {
        const h = harness({ start: `${DATE} 23:30` });
        await h.runUntil('2026-09-30 07:31', () => ({ left: true }));
        assert.equal(h.retimes(), 0);
        assert.equal(h.history[0].startReason, 'not-observed');
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:45`).toISOString());
    });
});
describe('CurveController up early and after wake', () => {
    const upAt530 = now => ({ left: now < local('2026-09-30 05:20') });
    it('skips the rest of the warm-up after 30 minutes out of bed when opted in', async () => {
        const h = harness({ smart: { upEarly: true } });
        await h.runUntil('2026-09-30 07:31', upAt530);
        assert.deepEqual(h.applied, [['left', 0, '05:50']]);
        assert.equal(h.reasons.at(-1), 'base');
        assert.equal(h.history[0].upEarlyAt, local('2026-09-30 05:50').toISOString());
    });
    it('gates warm-up points after up early but lets the after-wake point run', async () => {
        const h = harness({ smart: { upEarly: true } });
        await h.runUntil('2026-09-30 06:00', upAt530);
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 06:07')), 'base');
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 06:30')), 'base');
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 07:00')), 'run');
    });
    it('does nothing early when up early is off, then goes to base once out of bed after wake', async () => {
        const h = harness();
        await h.runUntil('2026-09-30 07:31', upAt530);
        assert.deepEqual(h.applied, [['left', 0, '06:30']]);
        assert.equal(h.history[0].upEarlyAt, null);
        assert.equal(h.history[0].outOfBedAt, local('2026-09-30 06:30').toISOString());
    });
    it('counts bed exits in the last hour before wake', async () => {
        const h = harness();
        const stream = now => ({
            left: !(between(now, '2026-09-30 05:40', '2026-09-30 05:45') || between(now, '2026-09-30 06:00', '2026-09-30 06:05')),
        });
        await h.runUntil('2026-09-30 07:31', stream);
        assert.equal(h.history[0].bedExitsLastHour, 2);
    });
});
describe('CurveController after an edit during the night', () => {
    it('decides the start against a moved bedtime', async () => {
        const options = { bedtime: '23:00' };
        const h = harness(options);
        const inBed = now => ({ left: now >= local(`${DATE} 21:50`) });
        await h.runUntil(`${DATE} 22:30`, inBed);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 23:00`).getTime());
        const retimes = h.retimes();
        options.bedtime = '22:00';
        await h.runUntil(`${DATE} 22:31`, inBed);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 22:10`).getTime());
        assert.ok(h.retimes() > retimes);
        await h.runUntil('2026-09-30 07:31', inBed);
        assert.equal(h.history[0].plannedBedtime, local(`${DATE} 22:00`).toISOString());
        assert.equal(h.history[0].coolStart, local(`${DATE} 22:10`).toISOString());
    });
    it('replans a start held at the cap when its bedtime moves', async () => {
        const options = { bedtime: '22:45' };
        const h = harness(options);
        await h.runUntil(`${DATE} 22:50`, () => ({ left: false }));
        assert.equal(h.retimes(), 1);
        options.bedtime = '23:00';
        await h.runUntil(`${DATE} 22:51`, () => ({ left: false }));
        assert.equal(h.controller.coolStartFor('left', DATE), undefined);
        assert.equal(h.retimes(), 2);
    });
    it('keeps a confirmed start the new bedtime gives too', async () => {
        const options = { bedtime: '22:00' };
        const h = harness(options);
        const inBed = now => ({ left: now >= local(`${DATE} 22:10`) });
        await h.runUntil(`${DATE} 22:40`, inBed);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 22:30`).getTime());
        const retimes = h.retimes();
        options.bedtime = '22:15';
        await h.runUntil(`${DATE} 22:41`, inBed);
        assert.equal(h.controller.coolStartFor('left', DATE)?.getTime(), local(`${DATE} 22:30`).getTime());
        assert.equal(h.retimes(), retimes);
    });
    it('stops up early once it is switched off', async () => {
        const options = { smart: { upEarly: true } };
        const h = harness(options);
        const upAt5 = now => ({ left: now < local('2026-09-30 05:00') });
        await h.runUntil('2026-09-30 04:00', upAt5);
        options.smart = { upEarly: false };
        await h.runUntil('2026-09-30 06:29', upAt5);
        assert.deepEqual(h.applied, []);
        assert.equal(h.controller.gate('left', DATE, local('2026-09-30 06:00')), 'run');
    });
    it('records the rhythm and settings the night ended with', async () => {
        const options = { smart: {}, rhythmId: 'workday' };
        const h = harness(options);
        await h.runUntil(`${DATE} 23:00`, () => ({ left: true }));
        options.smart = { baseLevel: -2, intensity: 'gentle' };
        options.rhythmId = 'weekend';
        await h.runUntil('2026-09-30 07:31', () => ({ left: true }));
        const { rhythmId, baseLevel, intensity } = h.history[0];
        assert.deepEqual({ rhythmId, baseLevel, intensity }, { rhythmId: 'weekend', baseLevel: -2, intensity: 'gentle' });
    });
});
describe('CurveController writes no files', () => {
    it('has no file system or lowdb imports', () => {
        for (const file of ['./curveController.ts', './confirmation.ts', './offWhenUp.ts']) {
            const source = readFileSync(new URL(file, import.meta.url), 'utf8');
            assert.doesNotMatch(source, /from '(node:)?fs(\/promises)?'|lowdb|db\/rhythms\.js|db\/settings\.js/, file);
        }
    });
});
//# sourceMappingURL=curveController.test.js.map