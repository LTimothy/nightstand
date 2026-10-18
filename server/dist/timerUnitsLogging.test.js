import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// These run every minute. Their start and finish lines are info; failures and
// the scripts' own output (stored as notice) must still reach the journal.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UNITS = ['free-sleep-archive-raw.service', 'free-sleep-health.service', 'free-sleep-network-watchdog.service'];
describe('minute timer services', () => {
    for (const unit of UNITS) {
        it(`${unit} keeps info lines out of the journal and its own output in`, () => {
            const text = readFileSync(path.join(repoRoot, 'scripts/systemd', unit), 'utf8');
            const service = text.slice(text.indexOf('[Service]'));
            assert.ok(text.includes('[Service]'));
            assert.match(service, /^LogLevelMax=notice$/m);
            assert.match(service, /^SyslogLevel=notice$/m);
        });
    }
});
//# sourceMappingURL=timerUnitsLogging.test.js.map