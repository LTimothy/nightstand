import assert from 'node:assert/strict';
import { it } from 'node:test';
import moment from 'moment-timezone';
import { RhythmSchema } from '../../db/rhythmsSchema.js';
import { addDays, rhythmNightBounds, wallClock } from '../../db/rhythmTimes.js';
import { buildCurve } from '../../db/smartCurve.js';
import { assertCurve, check, fuzzCase, FUZZ_RUNS, FUZZ_SEED, MINUTE, random, sleepInput, SLEEP_CASES } from '../../testing/smartFuzz.js';
import { findOverlaps, resolveSleeps } from './resolve.js';
for (const fixture of [
    { date: '2026-03-07', start: '2026-03-08T04:00:00.000Z', end: '2026-03-09T03:00:00.000Z', hours: 23 },
    { date: '2026-10-31', start: '2026-11-01T03:00:00.000Z', end: '2026-11-02T04:00:00.000Z', hours: 25 },
]) {
    it(`resolves equal on and off to a ${fixture.hours} hour night across the clock change`, () => {
        const { rhythm, timeZone, date } = sleepInput(random(1), { date: fixture.date, timeZone: 'America/Los_Angeles', on: '20:00', wake: '20:00', off: '20:00' });
        const plan = { rhythms: { generated: rhythm }, changes: [{ date, rhythmId: 'generated' }],
            week: { sunday: null, monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null } };
        const [sleep] = resolveSleeps({ db: { version: 1, legacyFingerprint: 'a'.repeat(64), left: plan, right: plan },
            side: 'left', timeZone, from: new Date(fixture.start), to: new Date(fixture.end) });
        assert.equal(sleep.start.toISOString(), fixture.start);
        assert.equal(sleep.end.toISOString(), fixture.end);
        assert.equal(sleep.wake.toISOString(), fixture.end);
        assert.equal(sleep.end.getTime() - sleep.start.getTime(), fixture.hours * 60 * MINUTE);
    });
}
it(`fuzzes resolved sleeps and DST wall clocks (${FUZZ_RUNS} runs, seed ${FUZZ_SEED})`, () => {
    const next = random();
    for (let run = 0; run < FUZZ_RUNS + SLEEP_CASES.length; run++) {
        const fixture = SLEEP_CASES[run - FUZZ_RUNS];
        const { rhythm, timeZone, date } = sleepInput(next, fixture);
        rhythm.temperatureMode = fixture || next(0, 2) ? 'smart' : 'manual';
        const plan = { rhythms: { generated: rhythm }, changes: [],
            week: { sunday: 'generated', monday: 'generated', tuesday: 'generated', wednesday: 'generated',
                thursday: 'generated', friday: 'generated', saturday: 'generated' } };
        const db = { version: 1, legacyFingerprint: 'a'.repeat(64), left: plan, right: plan };
        if (fixture) {
            for (const day of Object.keys(plan.week))
                plan.week[day] = null;
            plan.changes = [{ date, rhythmId: 'generated' }];
        }
        const args = { db, side: 'right', timeZone, from: wallClock(date, '00:00', timeZone),
            to: wallClock(addDays(date, 4), '23:59', timeZone) };
        const delay = next(-120, 180) * MINUTE;
        const offDelay = next(-120, 180) * MINUTE;
        fuzzCase({ ...args, rhythm, delay, offDelay }, run, () => {
            RhythmSchema.parse(rhythm);
            const sleeps = resolveSleeps(args);
            const bounds = rhythmNightBounds(date, rhythm.night.power, timeZone);
            check(sleeps.length > 0 || !!fixture && bounds.end <= bounds.start, 'no resolved sleeps');
            assert.deepEqual(findOverlaps(args), []);
            sleeps.forEach((sleep, index) => {
                if (index)
                    check(sleep.start >= sleeps[index - 1].end, 'overlapping or unordered sleeps');
                const bedtime = wallClock(sleep.date, rhythm.night.power.on, timeZone);
                const wakeDate = rhythm.wake < rhythm.night.power.on ? addDays(sleep.date, 1) : sleep.date;
                const expectedWake = rhythm.wake === rhythm.night.power.off ? sleep.end : wallClock(wakeDate, rhythm.wake, timeZone);
                assert.equal(sleep.wake.getTime(), Math.min(Math.max(expectedWake.getTime(), bedtime.getTime()), sleep.end.getTime()));
                // Gap times move forward and repeated times use the first occurrence.
                const resolvedBedtime = moment.tz(sleep.smartCurve?.bedtime ?? sleep.start, timeZone);
                assert.equal(resolvedBedtime.format('HH:mm'), moment.tz(bedtime, timeZone).format('HH:mm'));
                check(sleep.events.every((event, offset) => Number.isFinite(event.at.getTime())
                    && (!offset || event.at >= sleep.events[offset - 1].at)), 'invalid or unordered events');
                if (sleep.smartCurve) {
                    const input = { smart: rhythm.smart, bedtime, coolStart: bedtime, wake: sleep.wake, powerOff: sleep.end, timeZone };
                    assertCurve(sleep.smartCurve.points, input);
                    assert.deepEqual(sleep.smartCurve.points, buildCurve(input));
                    check(sleep.events.filter(event => event.kind === 'temperature').every(event => event.at < sleep.end), 'temperature at turn off');
                }
            });
            const delayed = resolveSleeps({ ...args, coolStartFor: (_side, day) => new Date(wallClock(day, rhythm.night.power.on, timeZone).getTime() + delay) });
            for (const sleep of delayed)
                if (sleep.smartCurve)
                    assertCurve(sleep.smartCurve.points, { smart: rhythm.smart, bedtime: sleep.smartCurve.bedtime, coolStart: sleep.smartCurve.coolStart,
                        wake: sleep.wake, powerOff: sleep.end, timeZone });
            if (rhythm.temperatureMode === 'smart' && rhythm.smart.offWhenUp) {
                const moved = resolveSleeps({ ...args, powerOffFor: (_side, day) => new Date(rhythmNightBounds(day, rhythm.night.power, timeZone).end.getTime() + offDelay) });
                for (const sleep of moved) {
                    const original = sleeps.find(item => item.date === sleep.date);
                    if (!original)
                        continue;
                    const at = original.end.getTime() + offDelay;
                    const bedtime = sleep.smartCurve.bedtime;
                    const expectedEnd = at > bedtime.getTime() ? at : original.end.getTime();
                    assert.equal(sleep.end.getTime(), expectedEnd);
                    assert.equal(sleep.wake.getTime(), Math.min(original.wake.getTime(), expectedEnd));
                    assert.equal(sleep.events.filter(event => event.kind === 'power-off').length, 1);
                    if (sleep.end.getTime() !== original.end.getTime()) {
                        check(sleep.events.every(event => event.at <= sleep.end), 'event after moved off');
                    }
                    else {
                        assert.deepEqual(sleep.events, original.events);
                    }
                    assertCurve(sleep.smartCurve.points, { smart: rhythm.smart, bedtime, coolStart: bedtime,
                        wake: sleep.wake, powerOff: sleep.end, timeZone });
                }
            }
        });
    }
});
it('shortens and extends a When I get up sleep through powerOffFor', () => {
    const { rhythm, timeZone, date } = sleepInput(random(1), { date: '2026-09-28', timeZone: 'UTC', on: '22:00', wake: '07:30', off: '08:00' });
    rhythm.temperatureMode = 'smart';
    rhythm.smart.offWhenUp = true;
    const plan = { rhythms: { generated: rhythm }, changes: [{ date, rhythmId: 'generated' }],
        week: { sunday: null, monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null } };
    const args = { db: { version: 1, legacyFingerprint: 'a'.repeat(64), left: plan, right: plan },
        side: 'right', timeZone, from: new Date('2026-09-28T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') };
    for (const [off, wake] of [['06:00', '06:00'], ['10:00', '07:30']]) {
        const [sleep] = resolveSleeps({ ...args, powerOffFor: () => new Date(`2026-09-29T${off}:00Z`) });
        assert.equal(sleep.end.toISOString(), `2026-09-29T${off}:00.000Z`);
        assert.equal(sleep.wake.toISOString(), `2026-09-29T${wake}:00.000Z`);
        assert.equal(sleep.setOff?.toISOString(), '2026-09-29T08:00:00.000Z');
        assert.equal(sleep.events.at(-1)?.kind, 'power-off');
        assert.equal(sleep.events.at(-1)?.at.getTime(), sleep.end.getTime());
        assertCurve(sleep.smartCurve.points, { smart: rhythm.smart, bedtime: sleep.smartCurve.bedtime,
            coolStart: sleep.smartCurve.coolStart, wake: sleep.wake, powerOff: sleep.end, timeZone });
    }
});
//# sourceMappingURL=resolve.fuzz.test.js.map