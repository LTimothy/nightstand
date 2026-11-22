import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobKeyListSchema, JobSchema } from './jobsSchema.js';
describe('jobsSchema', () => {
    it('accepts every job the app can trigger', () => {
        // 'update' drives the in-app updater; removing it silently would leave
        // the Settings page Update button pointing at nothing.
        for (const job of ['update', 'reboot', 'analyzeSleepLeft', 'analyzeSleepRight', 'coverHealth']) {
            assert.equal(JobSchema.safeParse(job).success, true, `expected '${job}' to be a valid job`);
        }
    });
    it('rejects unknown jobs and non-array bodies', () => {
        assert.equal(JobKeyListSchema.safeParse(['rm-rf-everything']).success, false);
        assert.equal(JobKeyListSchema.safeParse('update').success, false);
        assert.equal(JobKeyListSchema.safeParse([{ job: 'update' }]).success, false);
    });
    it('accepts a list of valid jobs', () => {
        assert.equal(JobKeyListSchema.safeParse(['update']).success, true);
        assert.equal(JobKeyListSchema.safeParse([]).success, true);
    });
});
//# sourceMappingURL=jobsSchema.test.js.map