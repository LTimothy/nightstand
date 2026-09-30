import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/archive-raw.sh runs as root every minute and deletes files, so it
// is exercised against a scratch tree through its test-only path overrides.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/archive-raw.sh');
const HOUR = 3600;

let root: string;
let persist: string;
let archive: string;
let conf: string;

function addArchived(name: string, ageHours: number) {
  const file = path.join(archive, name);
  writeFileSync(file, 'x');
  const t = Date.now() / 1000 - ageHours * HOUR;
  utimesSync(file, t, t);
}

function addLive(name: string, ageHours: number) {
  const file = path.join(persist, name);
  writeFileSync(file, 'x');
  const t = Date.now() / 1000 - ageHours * HOUR;
  utimesSync(file, t, t);
}

// A stand-in for df on PATH, so the floor sees a partition of a given size.
function fakeDf(totalKb: number, availKb: number) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'df'), `#!/bin/sh
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo 'fake ${totalKb} ${totalKb - availKb} ${availKb} 50% /persistent'
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

function run(env: Record<string, string> = {}) {
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHIVE_RAW_PERSIST: persist,
      ARCHIVE_RAW_DIR: archive,
      ARCHIVE_RAW_CONF: conf,
      ARCHIVE_RAW_MIN_FREE_KB: '0',
      ...env,
    },
  });
}

const archived = () => readdirSync(archive).sort();
const live = () => readdirSync(persist).sort();

describe('archive-raw.sh', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nightstand-archive-raw-'));
    persist = path.join(root, 'persistent');
    archive = path.join(root, 'raw-archive');
    conf = path.join(root, 'raw-archive.conf');
    mkdirSync(persist);
  });

  it('parses and carries the exec bit', () => {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
    assert.ok(statSync(SCRIPT).mode & 0o111);
  });

  it('hardlinks new RAW files and skips the sequencer file', () => {
    writeFileSync(path.join(persist, '0001.RAW'), 'a');
    writeFileSync(path.join(persist, 'SEQNO.RAW'), 'b');
    const out = run();
    assert.deepEqual(archived(), ['0001.RAW']);
    assert.equal(statSync(path.join(archive, '0001.RAW')).ino, statSync(path.join(persist, '0001.RAW')).ino);
    assert.match(out, /linked=1 pruned=0 live_pruned=0 floor_pruned=0 \(retention=336h\)/);
  });

  it('keeps 14 days by default', () => {
    mkdirSync(archive);
    addArchived('new.RAW', 13 * 24);
    addArchived('old.RAW', 15 * 24);
    run();
    assert.deepEqual(archived(), ['new.RAW']);
  });

  it('reads the retention from the conf file', () => {
    mkdirSync(archive);
    addArchived('a.RAW', 30);
    addArchived('b.RAW', 50);
    writeFileSync(conf, 'RETENTION_HOURS=48\n');
    const out = run();
    assert.deepEqual(archived(), ['a.RAW']);
    assert.match(out, /retention=48h/);
  });

  for (const [label, body] of [
    ['below the minimum', 'RETENTION_HOURS=1\n'],
    ['above the maximum', 'RETENTION_HOURS=99999\n'],
    ['not a bare number', 'RETENTION_HOURS=48; rm -rf /\n'],
    ['a command substitution', 'RETENTION_HOURS=$(echo 48)\n'],
  ]) {
    it(`falls back to the default when the conf value is ${label}`, () => {
      mkdirSync(archive);
      addArchived('a.RAW', 50);
      writeFileSync(path.join(persist, 'b.RAW'), 'x');
      writeFileSync(conf, body);
      const out = run();
      assert.deepEqual(archived(), ['a.RAW', 'b.RAW']);
      assert.match(out, /retention=336h/);
    });
  }

  it('never sources the conf file', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /^\s*(source|\.)\s+"?\$CONF/m);
  });

  it('empties the archive oldest first when the disk is below the floor, then warns', () => {
    mkdirSync(archive);
    addArchived('a.RAW', 1);
    addArchived('b.RAW', 2);
    const out = run({ ARCHIVE_RAW_MIN_FREE_KB: '999999999999' });
    assert.deepEqual(archived(), []);
    assert.match(out, /floor_pruned=2/);
    assert.match(out, /WARNING free space .* archive empty/);
  });

  it('removes the firmware\'s own RAW files once they pass the retention', () => {
    addLive('old.RAW', 15 * 24);
    addLive('new.RAW', 1);
    addLive('SEQNO.RAW', 15 * 24);
    const nested = path.join(persist, 'other');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'keep.RAW'), 'x');
    const t = Date.now() / 1000 - 15 * 24 * HOUR;
    utimesSync(path.join(nested, 'keep.RAW'), t, t);
    const out = run();
    assert.deepEqual(live(), ['SEQNO.RAW', 'new.RAW', 'other']);
    assert.deepEqual(archived(), ['new.RAW']);
    assert.equal(existsSync(path.join(nested, 'keep.RAW')), true);
    assert.match(out, /live_pruned=1/);
  });

  it('frees space under the floor by removing the firmware\'s link too, but never the newest file', () => {
    addLive('a.RAW', 3);
    addLive('b.RAW', 2);
    addLive('c.RAW', 0);
    addLive('SEQNO.RAW', 0);
    const out = run({ ARCHIVE_RAW_MIN_FREE_KB: '999999999999' });
    assert.deepEqual(live(), ['SEQNO.RAW', 'c.RAW']);
    assert.deepEqual(archived(), ['c.RAW']);
    assert.match(out, /floor_pruned=2/);
    assert.match(out, /WARNING free space .* only the newest RAW file left/);
  });

  it('never removes the firmware\'s sequencer file under the floor', () => {
    mkdirSync(archive);
    addArchived('SEQNO.RAW', 5);
    addLive('SEQNO.RAW', 0);
    run({ ARCHIVE_RAW_MIN_FREE_KB: '999999999999' });
    assert.deepEqual(live(), ['SEQNO.RAW']);
  });

  it('still archives when df reports a size it cannot parse', () => {
    addLive('a.RAW', 0);
    const env = { ...fakeDf(1_000_000, 300_000), ARCHIVE_RAW_MIN_FREE_KB: '' };
    writeFileSync(path.join(root, 'bin', 'df'), `#!/bin/sh
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo 'fake 1.0G 0.7G 300000 70% /persistent'
`, { mode: 0o755 });
    run(env);
    assert.deepEqual(archived(), ['a.RAW']);
  });

  it('scales the default floor down on a small partition', () => {
    mkdirSync(archive);
    addArchived('a.RAW', 1);
    const env = { ...fakeDf(1_000_000, 300_000), ARCHIVE_RAW_MIN_FREE_KB: '' };
    run(env);
    assert.deepEqual(archived(), ['a.RAW']);
  });

  it('keeps the 2 GB floor on a large partition', () => {
    mkdirSync(archive);
    addArchived('a.RAW', 1);
    const env = { ...fakeDf(14_000_000, 1_500_000), ARCHIVE_RAW_MIN_FREE_KB: '' };
    const out = run(env);
    assert.deepEqual(archived(), []);
    assert.match(out, /floor_pruned=1/);
  });

  it('refuses to delete through a symlinked archive', () => {
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, 'keep.RAW'), 'x');
    const t = Date.now() / 1000 - 400 * HOUR;
    utimesSync(path.join(elsewhere, 'keep.RAW'), t, t);
    symlinkSync(elsewhere, archive);
    assert.throws(() => run({ ARCHIVE_RAW_MIN_FREE_KB: '999999999999' }));
    assert.equal(existsSync(path.join(elsewhere, 'keep.RAW')), true);
  });
});
