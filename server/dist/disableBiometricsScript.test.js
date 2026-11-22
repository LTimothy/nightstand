import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Runs scripts/disable_biometrics.sh with sh, as its sudo rule does, and
// systemctl replaced by a stub. The app saves Biometrics as off only when
// this exits 0, so a stream left running must fail it.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run({ stopExit = 0, state = 'inactive' } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-disable-biometrics-'));
    const calls = path.join(dir, 'calls');
    const systemctl = path.join(dir, 'systemctl');
    writeFileSync(systemctl, `#!/bin/sh
echo "systemctl $*" >> "${calls}"
[ "$1" = stop ] && exit ${stopExit}
[ "$1" = is-active ] && { echo ${state}; [ ${state} = active ]; exit; }
exit 0
`);
    chmodSync(systemctl, 0o755);
    const result = spawnSync('sh', [path.join(repoRoot, 'scripts/disable_biometrics.sh')], {
        env: { ...process.env, NIGHTSTAND_SYSTEMCTL: systemctl }, encoding: 'utf8', timeout: 10_000,
    });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    rmSync(dir, { recursive: true, force: true });
    return { ...result, log };
}
describe('disable_biometrics.sh', () => {
    it('stops and disables the stream', () => {
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.log.includes('systemctl stop free-sleep-stream'), result.log.join('\n'));
        assert.ok(result.log.includes('systemctl disable free-sleep-stream'), result.log.join('\n'));
    });
    it('fails when the stream does not stop, even if disabling works', () => {
        const result = run({ stopExit: 1, state: 'active' });
        assert.notEqual(result.status, 0);
        assert.ok(!result.log.includes('systemctl disable free-sleep-stream'), result.log.join('\n'));
    });
    it('fails when the stream is still running or ending after its stop', () => {
        for (const state of ['active', 'deactivating', 'activating'])
            assert.notEqual(run({ state }).status, 0, state);
    });
    // systemd refuses to stop a unit that does not load, even one already stopped.
    it('goes on when the stop fails but the stream is not running', () => {
        for (const state of ['inactive', 'failed', 'unknown']) {
            const result = run({ stopExit: 5, state });
            assert.equal(result.status, 0, state);
            assert.ok(result.log.includes('systemctl disable free-sleep-stream'), result.log.join('\n'));
        }
    });
});
//# sourceMappingURL=disableBiometricsScript.test.js.map