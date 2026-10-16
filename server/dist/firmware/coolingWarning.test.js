import assert from 'node:assert/strict';
import { it } from 'node:test';
import { CoolingWarning } from './coolingWarning.js';
function frame(timestamp, waterC = 25) {
    return { timestamp, waterC, targetC: 24.5, valid: true, enabled: true, power: -0.1,
        rpm: 200, water: true, loopC: 25, isOn: true, priming: false };
}
function history(detector, start = 100) {
    for (let elapsed = 0; elapsed <= 3600; elapsed += 10)
        detector.observe(frame(start + elapsed));
}
it('requires a full fresh hour and the inclusive rise, demand and pump boundaries sustained for twenty minutes', () => {
    const detector = new CoolingWarning();
    history(detector);
    for (let elapsed = 10; elapsed < 1200; elapsed += 10)
        detector.observe(frame(3700 + elapsed, 26));
    assert.equal(detector.snapshot(4899).active, false);
    detector.observe(frame(4900, 26));
    assert.equal(detector.snapshot(4900).active, false, 'the rise began at 3710');
    detector.observe(frame(4910, 26));
    assert.equal(detector.snapshot(4910).active, true);
});
it('does not warn during normal warming or without corroborating circulation and cooling demand', () => {
    for (const change of [{ targetC: 27 }, { targetC: 25.5001 }, { rpm: 199.99 }, { water: false },
        { power: 0 }, { power: 0.1 }, { loopC: null }, { isOn: false }, { priming: true }, { valid: false }, { enabled: false }]) {
        const detector = new CoolingWarning();
        for (let elapsed = 0; elapsed <= 5000; elapsed += 10)
            detector.observe({ ...frame(100 + elapsed, elapsed < 3600 ? 25 : 26), ...change });
        assert.equal(detector.snapshot(5100).active, false, JSON.stringify(change));
    }
    const detector = new CoolingWarning();
    history(detector);
    for (let elapsed = 10; elapsed <= 1300; elapsed += 10)
        detector.observe(frame(3700 + elapsed, 25.9999));
    assert.equal(detector.snapshot(5000).active, false);
});
it('accepts exactly half a degree of cooling demand', () => {
    const detector = new CoolingWarning();
    for (let elapsed = 0; elapsed <= 5000; elapsed += 10) {
        detector.observe({ ...frame(100 + elapsed, elapsed < 3600 ? 25 : 26), targetC: 25.5 });
    }
    assert.equal(detector.snapshot(5100).active, true);
});
it('resets dwell on an exact 0.25 C retreat and history on target change or gaps', () => {
    const detector = new CoolingWarning();
    history(detector);
    for (let elapsed = 10; elapsed <= 1190; elapsed += 10)
        detector.observe(frame(3700 + elapsed, 26.5));
    detector.observe(frame(4900, 26.25));
    assert.equal(detector.snapshot(4900).active, false);
    detector.observe({ ...frame(4910, 26.5), targetC: 24 });
    for (let elapsed = 10; elapsed <= 1300; elapsed += 10)
        detector.observe({ ...frame(4910 + elapsed, 26.5), targetC: 24 });
    assert.equal(detector.snapshot(6210).active, false);
    detector.observe(frame(6300, 27));
    assert.equal(detector.snapshot(6300).active, false);
});
it('makes acknowledgement dismiss only the notice and resets stale warnings', () => {
    const detector = new CoolingWarning();
    history(detector);
    for (let elapsed = 10; elapsed <= 1210; elapsed += 10)
        detector.observe(frame(3700 + elapsed, 26));
    const finding = detector.snapshot(4910);
    assert.equal(finding.active, true);
    assert.equal(finding.notice, true);
    detector.acknowledge(finding.since);
    assert.equal(detector.snapshot(4910).active, true);
    assert.equal(detector.snapshot(4910).notice, false);
    assert.equal(detector.snapshot(4971).active, false);
});
it('keeps the sixty-minute minimum with fresh samples at irregular intervals', () => {
    const detector = new CoolingWarning();
    for (let elapsed = 0; elapsed <= 5000; elapsed += 17) {
        detector.observe(frame(100 + elapsed, elapsed < 3600 ? 25 : 26));
    }
    assert.equal(detector.snapshot(5100).active, true);
});
it('keeps an hour of history when telemetry arrives more frequently than every five seconds', () => {
    const detector = new CoolingWarning();
    for (let elapsed = 0; elapsed <= 5000; elapsed++) {
        detector.observe(frame(100 + elapsed, elapsed < 3600 ? 25 : 26));
    }
    assert.equal(detector.snapshot(5100).active, true);
});
it('lets later thermostat and pump evidence invalidate an unchanged water sample', () => {
    for (const change of [{ power: 0.1 }, { power: 0 }, { power: null }, { rpm: 199 },
        { water: false }, { loopC: null }, { targetC: 27 }, { valid: false }, { enabled: false }]) {
        const detector = new CoolingWarning();
        history(detector);
        for (let timestamp = 3710; timestamp <= 4910; timestamp += 10)
            detector.observe(frame(timestamp, 26));
        assert.equal(detector.snapshot(4910).active, true);
        detector.observe({ ...frame(4910, 26), ...change });
        assert.equal(detector.snapshot(4910).active, false, JSON.stringify(change));
        assert.equal(detector.snapshot(4910).notice, false);
    }
});
it('does not start a new dwell by reevaluating an unchanged water sample', () => {
    const detector = new CoolingWarning();
    history(detector);
    detector.observe(frame(3710, 26));
    detector.observe({ ...frame(3710, 26), power: 0.1 });
    detector.observe(frame(3710, 26));
    for (let timestamp = 3720; timestamp <= 4910; timestamp += 10)
        detector.observe(frame(timestamp, 26));
    assert.equal(detector.snapshot(4910).active, false);
    detector.observe(frame(4920, 26));
    assert.equal(detector.snapshot(4920).active, true);
});
//# sourceMappingURL=coolingWarning.test.js.map