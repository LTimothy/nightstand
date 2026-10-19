import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
const SCRIPT = path.join(repoRoot, 'scripts/trim_log.sh');

it('cuts a log over 1 MiB to its newest half, whole lines only, in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-trim-log-'));
  try {
    const log = path.join(dir, 'free-sleep-update.log');
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${String(i).padStart(6, '0')} ${'x'.repeat(40)}`);
    writeFileSync(log, `${lines.join('\n')}\n`);
    const inode = statSync(log).ino;
    const result = spawnSync('bash', [SCRIPT, log], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const kept = readFileSync(log, 'utf8');
    assert.ok(kept.length <= 512 * 1024 && kept.length > 400 * 1024, String(kept.length));
    assert.ok(kept.endsWith(`${lines.at(-1)}\n`));
    assert.match(kept.split('\n')[0], /^line \d{6} x{40}$/);
    assert.equal(statSync(log).ino, inode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('leaves a small or missing log alone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-trim-log-'));
  try {
    const log = path.join(dir, 'small.log');
    writeFileSync(log, 'one\ntwo\n');
    assert.equal(spawnSync('bash', [SCRIPT, log]).status, 0);
    assert.equal(readFileSync(log, 'utf8'), 'one\ntwo\n');
    assert.equal(spawnSync('bash', [SCRIPT, path.join(dir, 'missing.log')]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('never trims through a symlink or a hardlink', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-trim-log-'));
  try {
    const target = path.join(dir, 'elsewhere');
    writeFileSync(target, 'x'.repeat(2 * 1024 * 1024));
    symlinkSync(target, path.join(dir, 'linked.log'));
    linkSync(target, path.join(dir, 'hardlinked.log'));
    for (const name of ['linked.log', 'hardlinked.log']) {
      assert.equal(spawnSync('bash', [SCRIPT, path.join(dir, name)]).status, 0, name);
      assert.equal(statSync(target).size, 2 * 1024 * 1024, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('trims each operation log before its unit starts, from root\'s copy', () => {
  for (const [file, log] of [['scripts/systemd/free-sleep-rollback.service', 'rollback'],
    ['scripts/systemd/free-sleep-revert.service', 'revert'], ['scripts/setup_services.sh', 'update']]) {
    const line = '^ExecStartPre=-/bin/bash /usr/local/lib/nightstand/live/scripts/trim_log\\.sh '
      + `/persistent/free-sleep-data/logs/free-sleep-${log}\\.log$`;
    assert.match(read(file), new RegExp(line, 'm'), file);
  }
});
