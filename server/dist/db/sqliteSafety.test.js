import { it } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
it('preserves SQLite backups, shutdown data, and shipped migration checksums', () => {
    execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/tests', '-v'], {
        cwd: path.resolve(import.meta.dirname, '../../..'),
        // The scripts suite takes about 30 s locally and longer on CI runners.
        timeout: 300_000,
        stdio: 'pipe',
    });
});
//# sourceMappingURL=sqliteSafety.test.js.map