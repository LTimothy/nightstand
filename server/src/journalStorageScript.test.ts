import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/journal_storage.sh');

function box() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-journal-'));
  const journald = path.join(dir, 'journald.conf.d');
  const journal = path.join(dir, 'var-log-journal');
  const runtime = path.join(dir, 'run-log-journal');
  const env = {
    ...process.env, NIGHTSTAND_JOURNALD_DIR: journald, NIGHTSTAND_STOCK_DIR: path.join(dir, 'stock'), NIGHTSTAND_ROOT: path.join(dir, 'root'),
    NIGHTSTAND_JOURNAL_DIR: journal, NIGHTSTAND_RUNTIME_JOURNAL_DIR: runtime, NIGHTSTAND_JOURNAL_OWNER: userInfo().username,
  };
  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { dir, dropin: path.join(journald, '10-nightstand-memory.conf'), stock: path.join(dir, 'stock'), journal, runtime, run };
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
    for (const args of [['volatile'], [], ['memory', 'disk'], ['tidy', 'now']]) {
      assert.equal(t.run(...args).status, 2, args.join(' '));
    }
    assert.equal(existsSync(t.dropin), false);
  });
});

describe('journal_storage.sh tidy', () => {
  const hourAgo = (file: string) => { const then = new Date(Date.now() - 2 * 60 * 60 * 1000); utimesSync(file, then, then); };

  // The log is in memory: drop-in present, journald writing a runtime file, only stale files on flash.
  function inMemory() {
    const t = box();
    t.run('memory');
    mkdirSync(path.join(t.runtime, 'abc'), { recursive: true });
    writeFileSync(path.join(t.runtime, 'abc', 'system.journal'), 'live');
    const machine = path.join(t.journal, 'abc');
    mkdirSync(machine, { recursive: true });
    for (const name of ['system.journal', 'system@x-1.journal', 'user-1000.journal~', 'notes.txt']) {
      writeFileSync(path.join(machine, name), 'old');
      hourAgo(path.join(machine, name));
    }
    return { ...t, machine };
  }

  it('removes old journal files and keeps the folders and anything else', () => {
    const t = inMemory();
    const result = t.run('tidy');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(t.machine), ['notes.txt']);
    assert.ok(existsSync(t.journal));
    assert.match(result.stdout, /3/);
    assert.equal(t.run('tidy').status, 0, 'a second run succeeds');
    assert.deepEqual(readdirSync(t.machine), ['notes.txt']);
  });

  it('removes nothing without the drop-in', () => {
    const t = inMemory();
    t.run('disk');
    assert.equal(t.run('tidy').status, 0);
    assert.equal(readdirSync(t.machine).length, 4);
  });

  it('removes nothing while journald has no runtime journal', () => {
    const t = inMemory();
    rmSync(path.join(t.runtime, 'abc', 'system.journal'));
    assert.equal(t.run('tidy').status, 0);
    assert.equal(readdirSync(t.machine).length, 4);
  });

  it('removes nothing when a journal file changed within the hour', () => {
    const t = inMemory();
    writeFileSync(path.join(t.machine, 'system.journal'), 'new');
    assert.equal(t.run('tidy').status, 0);
    assert.equal(readdirSync(t.machine).length, 4);
  });

  // The stock Pod links /var/log/journal (in a root-only folder) to /persistent/journal.
  function linkedTidy(t: ReturnType<typeof inMemory>, linkFolderMode: number) {
    const folder = path.join(t.dir, 'var-log');
    mkdirSync(folder, { mode: 0o755 });
    chmodSync(folder, linkFolderMode);
    const linked = path.join(folder, 'journal');
    symlinkSync(t.journal, linked);
    const env = {
      ...process.env, NIGHTSTAND_JOURNALD_DIR: path.dirname(t.dropin), NIGHTSTAND_JOURNAL_DIR: linked,
      NIGHTSTAND_RUNTIME_JOURNAL_DIR: t.runtime, NIGHTSTAND_JOURNAL_OWNER: userInfo().username,
    };
    return spawnSync('bash', [SCRIPT, 'tidy'], { env, encoding: 'utf8' });
  }

  it('follows a link that only the owner can change and cleans the folder it names', () => {
    const t = inMemory();
    const result = linkedTidy(t, 0o755);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(t.machine), ['notes.txt']);
  });

  it('removes nothing through a link in a folder others can write', () => {
    const t = inMemory();
    assert.equal(linkedTidy(t, 0o777).status, 0);
    assert.equal(readdirSync(t.machine).length, 4);
  });

  it('removes nothing when the link or its folder belongs to someone else', () => {
    const t = inMemory();
    const linked = path.join(t.dir, 'journal-link');
    symlinkSync(t.journal, linked);
    const env = {
      ...process.env, NIGHTSTAND_JOURNALD_DIR: path.dirname(t.dropin), NIGHTSTAND_JOURNAL_DIR: linked,
      NIGHTSTAND_RUNTIME_JOURNAL_DIR: t.runtime,
    };
    assert.equal(spawnSync('bash', [SCRIPT, 'tidy'], { env, encoding: 'utf8' }).status, 0, 'owner defaults to root');
    assert.equal(readdirSync(t.machine).length, 4);
  });
});
