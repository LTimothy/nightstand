import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DEFAULT_SMART } from './rhythmsSchema.js';
import { buildCurve } from './smartCurve.js';
import { assertCurve, curveInput, fuzzCase, FUZZ_RUNS, FUZZ_SEED, random } from '../testing/smartFuzz.js';
it(`fuzzes command curves (${FUZZ_RUNS} runs, seed ${FUZZ_SEED})`, () => {
    const next = random();
    for (let run = 0; run < FUZZ_RUNS; run++) {
        const input = curveInput(next);
        fuzzCase(input, run, () => assertCurve(buildCurve(input), input));
    }
});
const input = {
    smart: { ...DEFAULT_SMART, warmStart: true, warmUp: true }, timeZone: 'UTC',
    bedtime: new Date('2026-09-28T22:00:00Z'), coolStart: new Date('2026-09-28T22:00:00Z'),
    wake: new Date('2026-09-29T07:00:00Z'), powerOff: new Date('2026-09-29T08:00:00Z'),
};
it('rejects oversized level steps while allowing the after phase to return to base', () => {
    const points = buildCurve(input);
    assertCurve(points, input);
    const afterIndex = points.findIndex(point => point.phase === 'after');
    assert.ok(afterIndex > 0);
    assert.equal(points[afterIndex].level, input.smart.baseLevel);
    assert.ok(Math.abs(points[afterIndex].level - points[afterIndex - 1].level) > 1);
    const index = points.findIndex((point, index) => index > 0 && point.level !== points[index - 1].level);
    points[index].level -= 1;
    assert.throws(() => assertCurve(points, input), /level step exceeds one/);
});
it('rejects cooling and warming steps placed too close together', () => {
    for (const phase of ['cooldown', 'warmup']) {
        const points = buildCurve(input);
        const index = points.findIndex((point, index) => index > 1 && point.phase === phase
            && point.level !== points[index - 1].level && points[index - 1].level !== points[index - 2].level);
        assert.ok(index > 1, `no consecutive steps in ${phase}`);
        points[index].at = new Date(points[index - 1].at.getTime() + 60_000);
        assert.throws(() => assertCurve(points, input), /level steps too close/);
    }
});
//# sourceMappingURL=smartCurve.fuzz.test.js.map