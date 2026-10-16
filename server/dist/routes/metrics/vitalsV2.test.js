import assert from 'node:assert/strict';
import { test } from 'node:test';
test('the legacy vitals module exposes only its column selection', async () => {
    const exports = await import('./vitalsV2.js');
    assert.deepEqual(Object.keys(exports), ['legacyVitalsSelect']);
    assert.deepEqual(exports.legacyVitalsSelect, {
        id: true, side: true, timestamp: true, heart_rate: true, hrv: true, breathing_rate: true,
    });
});
//# sourceMappingURL=vitalsV2.test.js.map