import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/boot_slot.sh');

// A fake U-Boot environment in a file, read by fake fw_printenv -n and written by fake fw_setenv.
function box(cmdline: string, env: Record<string, string>, setFails = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-slot-'));
  const store = path.join(dir, 'env');
  const writes = path.join(dir, 'writes');
  writeFileSync(store, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  writeFileSync(path.join(dir, 'cmdline'), cmdline);
  const printenv = path.join(dir, 'fw_printenv');
  writeFileSync(printenv, `#!/bin/sh\n[ "$1" = -n ] && sed -n "s/^$2=//p" "${store}"\n`);
  const setenv = path.join(dir, 'fw_setenv');
  writeFileSync(setenv, setFails ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\necho "$@" >> "${writes}"\n`
      + `grep -v "^$1=" "${store}" > "${store}.new"; echo "$1=$2" >> "${store}.new"; mv "${store}.new" "${store}"\n`);
  chmodSync(printenv, 0o755);
  chmodSync(setenv, 0o755);
  const run = (arg: string) => spawnSync('bash', [SCRIPT, arg], {
    env: { ...process.env, NIGHTSTAND_PROC_CMDLINE: path.join(dir, 'cmdline'), NIGHTSTAND_FW_PRINTENV: printenv, NIGHTSTAND_FW_SETENV: setenv },
    encoding: 'utf8',
  });
  return { run, writes: () => (existsSync(writes) ? readFileSync(writes, 'utf8') : '') };
}

const SLOT_B = 'console=ttyS0 root=PARTLABEL=rootfs_b rootwait ro\n';

describe('boot_slot.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
    assert.ok(statSync(SCRIPT).mode & 0o111);
  });

  it('marks only the running slot when it is not marked', () => {
    const t = box(SLOT_B, { boot_a_success: '1', boot_b_success: '0', retry_boot_b: '3' });
    assert.match(t.run('status').stdout, /slot b, not marked good .*3 boots left/);
    const result = t.run('confirm');
    assert.equal(result.status, 0);
    assert.equal(t.writes(), 'boot_b_success 1\n');
    assert.match(result.stdout, /slot b is now marked good/);
  });

  it('writes nothing when the running slot is already marked', () => {
    const t = box(SLOT_B, { boot_b_success: '1' });
    assert.equal(t.run('confirm').status, 0);
    assert.equal(t.writes(), '');
  });

  it('writes nothing when the running slot cannot be told', () => {
    const t = box('console=ttyS0 root=/dev/mmcblk0p5 rootwait\n', { boot_a_success: '0', boot_b_success: '0' });
    assert.equal(t.run('confirm').status, 2);
    assert.equal(t.writes(), '');
  });

  it('reports a failed write', () => {
    const t = box(SLOT_B, { boot_b_success: '0' }, true);
    const result = t.run('confirm');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not mark slot b/);
  });
});
