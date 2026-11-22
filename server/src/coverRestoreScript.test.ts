import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/cover_restore.sh');

// A fake systemctl that records its arguments and reports the unit as `loadState`.
function box({ loadState = 'loaded', restartExit = 0, logDir = 'logs' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-cover-restore-'));
  const logs = path.join(dir, logDir);
  const calls = path.join(dir, 'calls');
  const systemctl = path.join(dir, 'systemctl');
  writeFileSync(systemctl, `#!/bin/bash\necho "$*" >> "${calls}"\n`
    + `if [ "$1" = show ]; then echo ${loadState}; exit 0; fi\nexit ${restartExit}\n`, { mode: 0o755 });
  const env = { ...process.env, NIGHTSTAND_OPS_LOG_DIR: logs, NIGHTSTAND_SYSTEMCTL: systemctl };
  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    dir, logs, run,
    stamp: path.join(logs, 'cover-restore.stamp'),
    calls: () => read(calls).trim().split('\n').filter(Boolean),
    log: () => read(path.join(logs, 'cover-restore.log')).trim().split('\n').filter(Boolean),
  };
}

describe('cover_restore.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
    assert.ok(statSync(SCRIPT).mode & 0o111);
  });

  it('refuses any argument without calling systemctl', () => {
    const t = box();
    mkdirSync(t.logs);
    const result = t.run('now');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage/);
    assert.deepEqual(t.calls(), []);
  });

  it('refuses when the unit is not loaded, and logs it', () => {
    const t = box({ loadState: 'not-found' });
    mkdirSync(t.logs);
    assert.equal(t.run().status, 1);
    assert.deepEqual(t.calls(), ['show frank.service --property=LoadState --value']);
    assert.equal(t.log().length, 1);
    assert.match(t.log()[0], /refused: frank\.service is not-found$/);
    assert.equal(existsSync(t.stamp), false);
  });

  it('restarts frank.service, stamps and logs the attempt', () => {
    const t = box();
    mkdirSync(t.logs);
    assert.equal(t.run().status, 0);
    assert.deepEqual(t.calls(), ['show frank.service --property=LoadState --value', 'restart frank.service']);
    assert.ok(existsSync(t.stamp));
    assert.equal(t.log().length, 2);
    assert.match(t.log()[0], /restarting frank\.service$/);
    assert.match(t.log()[1], / restarted$/);
  });

  it('refuses a second run inside the hour and allows one after it', () => {
    const t = box();
    mkdirSync(t.logs);
    t.run();
    assert.equal(t.run().status, 3);
    assert.match(t.log().at(-1) ?? '', /refused: restarted less than an hour ago$/);
    assert.equal(t.calls().filter(call => call.startsWith('restart')).length, 1);
    const old = new Date(Date.now() - 61 * 60_000);
    utimesSync(t.stamp, old, old);
    assert.equal(t.run().status, 0);
    assert.equal(t.calls().filter(call => call.startsWith('restart')).length, 2);
  });

  it('counts a failed restart toward the hour and reports it', () => {
    const t = box({ restartExit: 1 });
    mkdirSync(t.logs);
    assert.equal(t.run().status, 1);
    assert.ok(existsSync(t.stamp));
    assert.match(t.log().at(-1) ?? '', /restart failed$/);
  });

  it('refuses a missing or linked log folder', () => {
    const missing = box();
    assert.equal(missing.run().status, 1);
    assert.deepEqual(missing.calls(), []);
    const linked = box();
    const real = path.join(linked.dir, 'real');
    mkdirSync(real);
    symlinkSync(real, linked.logs);
    assert.equal(linked.run().status, 1);
    assert.deepEqual(linked.calls(), []);
    assert.equal(existsSync(path.join(real, 'cover-restore.stamp')), false);
  });
});
