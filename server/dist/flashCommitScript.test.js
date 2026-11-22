import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/flash_commit.sh');
const EXT4 = '/dev/mmcblk0p8 /persistent ext4 rw,noatime,discard 0 0\n';
function box(mounts = EXT4) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-commit-'));
    const log = path.join(dir, 'mount.log');
    const fake = path.join(dir, 'mount');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(fake, 0o755);
    writeFileSync(path.join(dir, 'mounts'), mounts);
    const env = { ...process.env, NIGHTSTAND_PROC_MOUNTS: path.join(dir, 'mounts'), NIGHTSTAND_MOUNT_BIN: fake };
    const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    return { run, calls };
}
describe('flash_commit.sh', () => {
    it('parses and carries the exec bit', () => {
        assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
        assert.ok(statSync(SCRIPT).mode & 0o111);
    });
    it('long remounts /persistent with a 60 s commit and default puts back 5 s', () => {
        const t = box();
        assert.equal(t.run('long').status, 0);
        assert.equal(t.run('default').status, 0);
        assert.equal(t.calls(), '-o remount,commit=60 /persistent\n-o remount,commit=5 /persistent\n');
    });
    it('changes nothing when /persistent is not an ext4 mount', () => {
        const t = box('/dev/root / ext4 rw,relatime 0 0\n');
        assert.equal(t.run('long').status, 1);
        assert.equal(t.calls(), '');
    });
    it('saves nothing and touches no unit or fstab', () => {
        assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /systemctl|fstab|tune2fs|>\s*\/etc/);
    });
    it('refuses anything else', () => {
        const t = box();
        assert.equal(t.run().status, 2);
        assert.equal(t.run('60').status, 2);
        assert.equal(t.run('long', 'extra').status, 2);
        assert.equal(t.calls(), '');
    });
});
//# sourceMappingURL=flashCommitScript.test.js.map