import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/journal_storage.sh');

function box() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-journal-'));
  const journald = path.join(dir, 'journald.conf.d');
  const env = {
    ...process.env, NIGHTSTAND_JOURNALD_DIR: journald, NIGHTSTAND_STOCK_DIR: path.join(dir, 'stock'), NIGHTSTAND_ROOT: path.join(dir, 'root'),
  };
  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { dir, dropin: path.join(journald, '10-nightstand-memory.conf'), stock: path.join(dir, 'stock'), run };
}

describe('journal_storage.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
    assert.ok(statSync(SCRIPT).mode & 0o111);
  });

  it('memory writes a volatile drop-in readable by all and records the original as absent', () => {
    const t = box();
    assert.equal(t.run('memory').status, 0);
    const text = readFileSync(t.dropin, 'utf8');
    assert.match(text, /^\[Journal\]$/m);
    assert.match(text, /^Storage=volatile$/m);
    assert.match(text, /^RuntimeMaxUse=64M$/m);
    assert.equal(statSync(t.dropin).mode & 0o777, 0o644);
    assert.ok(existsSync(path.join(t.stock, 'journald-10-nightstand-memory.conf.absent')));
  });

  it('memory leaves an existing drop-in as it is', () => {
    const t = box();
    t.run('memory');
    writeFileSync(t.dropin, '[Journal]\nStorage=volatile\n');
    assert.equal(t.run('memory').status, 0);
    assert.equal(readFileSync(t.dropin, 'utf8'), '[Journal]\nStorage=volatile\n');
  });

  it('disk removes the drop-in and succeeds when there is none', () => {
    const t = box();
    t.run('memory');
    assert.equal(t.run('disk').status, 0);
    assert.equal(existsSync(t.dropin), false);
    assert.equal(t.run('disk').status, 0);
  });

  it('never restarts journald, so it needs no systemctl', () => {
    assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /systemctl|journalctl/);
  });

  it('refuses anything else', () => {
    const t = box();
    for (const args of [['volatile'], [], ['memory', 'disk']]) {
      assert.equal(t.run(...args).status, 2, args.join(' '));
    }
    assert.equal(existsSync(t.dropin), false);
  });
});
