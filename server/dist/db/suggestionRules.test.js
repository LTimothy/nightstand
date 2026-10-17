import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import * as rules from './suggestionRules.js';
it('holds the gate, the near-miss floor and the timings', () => {
    assert.deepEqual({ ...rules.SUGGESTION_RULES }, {
        MIN_NIGHTS: 5, MIN_SHARE: 0.5, HIDE_SHARE: 0.4, NEAR_MIN_NIGHTS: 7, NEAR_MIN_SUPPORT: 3, NEAR_SHARE: 0.4,
        WINDOW_NIGHTS: 14, COALESCE_MIN: 10, CLUSTER_MIN: 120, ON_WINDOW_MIN: 15, REPLACE_MIN: 30, TIME_ROUND_MIN: 15,
        MAX_SUGGESTIONS: 3, BASE_STEP: 1, SNOOZE_NIGHTS: 14, NOTE_DAYS: 90,
    });
});
it('keeps the near-miss floor and the hide line under the gate', () => {
    assert.ok(rules.NEAR_SHARE <= rules.MIN_SHARE);
    assert.ok(rules.NEAR_MIN_NIGHTS >= rules.MIN_NIGHTS);
    assert.ok(rules.HIDE_SHARE <= rules.MIN_SHARE);
});
it('imports nothing, so the app can read it', () => {
    assert.doesNotMatch(readFileSync(new URL('./suggestionRules.ts', import.meta.url), 'utf8'), /^import /m);
});
//# sourceMappingURL=suggestionRules.test.js.map