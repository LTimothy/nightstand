import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MANIFEST } from './agent/agentManifest.js';
import { Disk, fakeDiskEnv, writeFakeDiskTools } from './testing/fakeDisk.js';

// How an update, a rollback and a switch record their ending for the app, run
// against the real scripts with the Pod's paths redirected into a temp folder.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
const SCRIPTS = [
  ['scripts/update.sh', 'update'],
  ['scripts/rollback_pod.sh', 'rollback'],
  ['scripts/switch-to-upstream.sh', 'switch'],
] as const;
const BLOCK_START = '# How this run ended';

let root: string;
let resultPath: string;
let runs = 0;

function resultBlock(src: string) {
  const start = src.indexOf(BLOCK_START);
  assert.ok(start >= 0, 'missing the result block');
  const end = src.indexOf('\nUP_TO_DATE=no\n', start);
  assert.ok(end > start, 'missing UP_TO_DATE');
  // record_result itself lives in restore_helpers.sh.
  return `${src.slice(start, end + 15)}source "${path.join(repoRoot, 'scripts/restore_helpers.sh')}"\n`;
}

// Lays out a fresh pod under the temp folder and runs a script text there.
function runScript(src: string, name: string, disk: Disk, setup?: (home: string) => void, lock?: string) {
  const dir = path.join(root, `run${runs++}`);
  const podHome = path.join(dir, 'home');
  const data = path.join(dir, 'persistent/free-sleep-data');
  mkdirSync(path.join(podHome, 'free-sleep/server/src'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(podHome, 'free-sleep/server/src/serverInfo.json'), '{"version":"3.5.1"}');
  setup?.(podHome);
  const scriptDir = path.join(dir, 'scripts');
  mkdirSync(scriptDir);
  copyFileSync(path.join(repoRoot, 'scripts/restore_helpers.sh'), path.join(scriptDir, 'restore_helpers.sh'));
  copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(scriptDir, 'write_result.py'));
  const file = path.join(scriptDir, name);
  writeFileSync(file, src
    .replaceAll('/persistent/free-sleep-data', data)
    .replaceAll('/home/dac', podHome));
  const bin = path.join(dir, 'bin');
  writeFakeDiskTools(bin);
  const result = spawnSync('bash', [file], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...fakeDiskEnv(bin, disk), NIGHTSTAND_OPERATION_LOCK: lock ?? path.join(dir, 'lock') },
  });
  const resultFile = path.join(data, 'update-result.json');
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    record: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, string> : {},
  };
}

const upTo = (src: string, marker: string) => {
  const end = src.indexOf(marker);
  assert.ok(end > 0, `missing ${marker}`);
  return src.slice(0, end);
};

describe('the writer', () => {
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'nightstand-result-'));
    resultPath = path.join(root, 'update-result.json');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const writer = path.join(repoRoot, 'scripts/write_result.py');
  const write = (...args: string[]) => spawnSync('python3', [writer, resultPath, ...args], { encoding: 'utf8' });

  it('writes the record the app reads, with a fresh run id each time', () => {
    assert.equal(write('update', 'rolled-back', '3.5.1', '3.6.0', 'the new version did not pass its health check').status, 0);
    const first = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, string>;
    assert.deepEqual(
      { ...first, runId: undefined, finishedAt: undefined },
      { runId: undefined, operation: 'update', outcome: 'rolled-back', from: '3.5.1', to: '3.6.0',
        message: 'the new version did not pass its health check', finishedAt: undefined },
    );
    assert.match(first.runId, /^[0-9a-f]{8}$/);
    assert.match(first.finishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    write('update', 'failed', '', '', 'x');
    const second = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, string>;
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.from, null);
    assert.equal(second.to, null);
  });

  it('keeps a long reason to 300 characters, leaves no temp file, and is readable by the server', () => {
    write('update', 'stopped', '3.5.1', '3.6.0', 'x'.repeat(500));
    assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).message.length, 300);
    assert.deepEqual(readdirSync(root).filter(name => name.includes('.tmp')), []);
    assert.equal(statSync(resultPath).mode & 0o777, 0o644);
  });
});

describe('how each script records its ending', () => {
  before(() => { root = mkdtempSync(path.join(tmpdir(), 'nightstand-result-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('the three scripts share one block, naming only their operation', () => {
    const [reference] = SCRIPTS.map(([file]) => resultBlock(read(file)));
    for (const [file, operation] of SCRIPTS) {
      const src = read(file);
      assert.equal(resultBlock(src), reference, file);
      assert.match(src, new RegExp(`^RESULT_OPERATION=${operation}$`, 'm'), file);
      assert.ok(src.indexOf('RESULT_OPERATION=') < src.indexOf(BLOCK_START), file);
    }
  });

  it('every failure keeps its first reason, and the exit trap records the ending', () => {
    for (const [file] of SCRIPTS) {
      const src = read(file);
      assert.match(src, /^fail\(\) \{ say "FATAL: \$\*"; \[ -n "\$\{RESULT_REASON:-\}" \] \|\| RESULT_REASON="\$\*"; exit 1; \}$/m, file);
    }
    for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
      const src = read(file);
      const start = src.indexOf('cleanup() {');
      const cleanup = src.slice(start, src.indexOf('\n\nfail()', start));
      const dir = mkdtempSync(path.join(root, 'cleanup-'));
      try {
        const result = spawnSync('bash', ['-c', `set -uo pipefail
STAGE="$FIXTURE/stage"; ZIP="$FIXTURE/zip"; SWAP_MARKER="$FIXTURE/swap-marker"
close_wan() { :; }
finish_interrupted_swap() { echo interrupted >> "$FIXTURE/calls"; }
record_result() { echo "recorded $1" >> "$FIXTURE/calls"; }
${cleanup}
trap cleanup EXIT
exit 7`], { encoding: 'utf8', env: { ...process.env, FIXTURE: dir } });
        assert.equal(result.status, 7, result.stdout + result.stderr);
        assert.equal(readFileSync(path.join(dir, 'calls'), 'utf8'), 'interrupted\nrecorded 7\n');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    assert.match(read('scripts/rollback_pod.sh'),
      /^trap 'status=\$\?; trap "" HUP INT TERM; finish_interrupted_swap; record_result "\$status"' EXIT$/m);
  });

  // The outcome from where the run stood when it ended.
  const outcomes: [string, string, number, string, string][] = [
    ['an exit before anything changed', 'preflight', 1, 'no', 'stopped'],
    ['a failure once the swap began', 'swapping', 1, 'no', 'failed'],
    ['a failure after the swap', 'swapped', 1, 'no', 'failed'],
    ['a failure after the old version came back', 'restored', 1, 'no', 'rolled-back'],
    ['a normal finish', 'swapped', 0, 'no', 'success'],
    ['a finish with nothing newer', 'preflight', 0, 'yes', 'up-to-date'],
    ['a signal during the swap', 'swapped', 143, 'no', 'failed'],
  ];
  for (const [file, operation] of SCRIPTS) {
    for (const [what, phase, status, upToDate, outcome] of outcomes) {
      it(`${operation}: ${what} is ${outcome}`, () => {
        const dir = path.join(root, `block${runs++}`);
        mkdirSync(dir);
        copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
        const data = path.join(dir, 'free-sleep-data');
        mkdirSync(data);
        writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
say() { echo "$*"; }
RESULT_OPERATION=${operation}
${resultBlock(read(file)).replaceAll('/persistent/free-sleep-data', data)}
CUR_VERSION=3.5.1; EXPECTED_VERSION=3.6.0
RESULT_PHASE=${phase}; UP_TO_DATE=${upToDate}; RESULT_REASON='a stated reason'
record_result ${status}
`);
        const result = spawnSync('bash', [path.join(dir, 'harness.sh')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const record = JSON.parse(readFileSync(path.join(data, 'update-result.json'), 'utf8'));
        assert.equal(record.operation, operation);
        assert.equal(record.outcome, outcome);
        assert.equal(record.from, '3.5.1');
        assert.equal(record.to, '3.6.0');
        assert.equal(record.message, 'a stated reason');
      });
    }
  }

  const unstated: [number, string][] = [
    [129, 'it was interrupted before it finished'],
    [130, 'it was interrupted before it finished'],
    [143, 'it was interrupted before it finished'],
    [2, 'it ended without giving a reason (exit status 2). See the update log.'],
  ];
  for (const [status, reason] of unstated) {
    it(`a failure with no stated reason (exit ${status}) says ${reason}`, () => {
      for (const [file, operation] of SCRIPTS) {
        const dir = path.join(root, `block${runs++}`);
        mkdirSync(dir);
        copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
        writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
RESULT_OPERATION=${operation}
${resultBlock(read(file)).replaceAll('/persistent/free-sleep-data', dir)}
record_result ${status}
`);
        spawnSync('bash', [path.join(dir, 'harness.sh')], { encoding: 'utf8' });
        assert.equal(JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')).message, reason, file);
      }
    });
  }

  // The wording for a rollback and a switch names these versions, so each script must record the right ones.
  const versions: [string, string, string, string][] = [
    ['scripts/rollback_pod.sh', 'CUR_VERSION=3.6.0; TARGET_VERSION=3.5.1', '3.6.0', '3.5.1'],
    ['scripts/switch-to-upstream.sh', 'CUR_VERSION=3.6.0; STAGED_VERSION=1.0.0', '3.6.0', '1.0.0'],
  ];
  for (const [file, assignments, from, to] of versions) {
    it(`${file} records the version it left and the one it moved to`, () => {
      const src = read(file);
      const dir = path.join(root, `block${runs++}`);
      mkdirSync(dir);
      copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
RESULT_OPERATION=x
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
${assignments}
record_result 1
`);
      spawnSync('bash', [path.join(dir, 'harness.sh')], { encoding: 'utf8' });
      const record = JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')) as Record<string, string>;
      assert.equal(record.from, from);
      assert.equal(record.to, to);
      // And the script assigns those names from the trees it reads.
      assert.match(src, /^CUR_VERSION=\$\(python3 .*\/server\/src\/serverInfo\.json/m);
      assert.match(src, file.includes('rollback') ? /^TARGET_VERSION=\$\(python3 .*PREV/m : /^STAGED_VERSION=\$\(python3 .*STAGE/m);
    });
  }

  it('a result is written even when the tree the script came from has moved', () => {
    // Reading the writer at the start is what lets a run that swaps its own
    // tree away still record how it ended.
    const dir = path.join(root, `block${runs++}`);
    mkdirSync(path.join(dir, 'tree'), { recursive: true });
    copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'tree/write_result.py'));
    writeFileSync(path.join(dir, 'tree/harness.sh'), `set -uo pipefail
RESULT_OPERATION=update
${resultBlock(read('scripts/update.sh')).replaceAll('/persistent/free-sleep-data', dir)}
mv '${dir}/tree' '${dir}/moved'
record_result 0
`);
    spawnSync('bash', [path.join(dir, 'tree/harness.sh')], { encoding: 'utf8' });
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')).outcome, 'success');
  });

  const lowPersistent: Disk = { rootFreeMb: 6000, persFreeMb: 50 };

  it('update.sh records a refusal before anything changed as stopped, with the reason', () => {
    const src = read('scripts/update.sh');
    const { status, record } = runScript(upTo(src, 'if [ "$HANDOFF" = 1 ]; then'), 'update.sh', lowPersistent);
    assert.equal(status, 1);
    assert.equal(record.operation, 'update');
    assert.equal(record.outcome, 'stopped');
    assert.match(record.message, /^low disk on \/persistent \(50M free, \d+M needed\)/);
    assert.match(record.runId, /^[0-9a-f]{8}$/);
    assert.equal(record.from, '3.5.1');
  });

  it('update.sh records nothing when another operation holds the lock', async () => {
    // A refusal at the lock must not overwrite the record of the run that holds it.
    const dir = path.join(root, `run${runs++}`);
    mkdirSync(dir);
    const lock = path.join(dir, 'lock');
    const holder = spawn('python3', ['-c', 'import fcntl, sys, time\n'
      + `handle = open(${JSON.stringify(lock)}, "a")\n`
      + 'fcntl.flock(handle, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(30)']);
    try {
      await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()));
      const src = upTo(read('scripts/update.sh'), 'if [ "$HANDOFF" != 1 ]; then');
      const { status, out, record } = runScript(src, 'update.sh', lowPersistent, undefined, lock);
      assert.equal(status, 1);
      assert.match(out, /another update, rollback or switch is already running/);
      assert.deepEqual(record, {});
    } finally {
      holder.kill();
    }
  });

  it('rollback_pod.sh records a missing previous install as stopped', () => {
    const src = read('scripts/rollback_pod.sh');
    const { status, record } = runScript(upTo(src, '# Other forks cannot run'), 'rollback_pod.sh', lowPersistent);
    assert.equal(status, 1);
    assert.equal(record.operation, 'rollback');
    assert.equal(record.outcome, 'stopped');
    assert.match(record.message, /^no previous install at .*free-sleep-prev; nothing to roll back to$/);
  });

  it('switch-to-upstream.sh records a refusal before anything changed as stopped', () => {
    const src = read('scripts/switch-to-upstream.sh');
    const { status, record } = runScript(upTo(src, '# --- download + stage'), 'switch-to-upstream.sh', lowPersistent);
    assert.equal(status, 1);
    assert.equal(record.operation, 'switch');
    assert.equal(record.outcome, 'stopped');
    assert.match(record.message, /^low disk on \/persistent \(50M free, \d+M needed\)/);
  });
});

describe('where each script marks its progress', () => {
  const follows = (src: string, marker: string, from: string) => {
    const start = src.indexOf(from);
    assert.ok(start >= 0, `missing ${from}`);
    const at = src.indexOf(marker, start);
    assert.ok(at > start, `${marker} does not follow ${from}`);
    return at;
  };

  it('update.sh marks the swap, the rollback and an up to date finish where they happen', () => {
    const src = read('scripts/update.sh');
    assert.ok(src.indexOf('RESULT_PHASE=swapping') > src.indexOf('# --- atomic swap'));
    assert.ok(src.indexOf('RESULT_PHASE=swapping') < src.indexOf('! stop_late_stream; then'));
    assert.ok(src.indexOf('RESULT_PHASE=swapped') > src.indexOf('move_tree "$STAGE" "$LIVE" || {'));
    const rollback = src.indexOf('# --- automatic rollback');
    assert.ok(src.indexOf('RESULT_PHASE=restored', rollback) > src.indexOf('move_tree "$PREV" "$LIVE" || {', rollback));
    assert.ok(src.indexOf('UP_TO_DATE=yes') < src.indexOf('Already up to date'));
    assert.match(src, /RESULT_REASON="Nightstand is already up to date \(the newest published version is v\$REMOTE_VERSION\)"/);
  });

  it('update.sh calls a swap that failed and was put back restored, never stopped before changing anything', () => {
    const src = read('scripts/update.sh');
    // The rollback slot is deleted and the services restart before either move, so the old
    // tree coming back is a restore, not an untouched install.
    const first = follows(src, 'RESULT_PHASE=restored', 'move_tree "$LIVE" "$PREV" || {');
    assert.ok(first < src.indexOf('fail "swap failed moving live aside"'));
    const second = follows(src, 'RESULT_PHASE=restored', 'move_tree "$STAGE" "$LIVE" || {');
    assert.ok(second > src.indexOf('move_tree "$PREV" "$LIVE" || fail "swap failed and previous tree could not be restored'));
    assert.ok(second < src.indexOf('fail "swap failed; previous version restored"'));
  });

  it('update.sh states why before each of its rollbacks', () => {
    const src = read('scripts/update.sh');
    assert.match(src, /RESULT_REASON="database migrations did not apply"/);
    assert.match(src, /RESULT_REASON="the new firewall rules could not be applied"/);
    const health = src.indexOf('[ -n "${RESULT_REASON:-}" ] || RESULT_REASON="the new version did not pass its health check"');
    assert.ok(health > src.indexOf('# --- automatic rollback'));
    assert.ok(health < src.indexOf('say "Health check FAILED: rolling back'));
  });

  it('update.sh does not call a rollback whose own health check failed a success', () => {
    const src = read('scripts/update.sh');
    const tail = src.slice(src.indexOf('if restored_version_answers; then'));
    assert.match(tail, /else\n {2}RESULT_PHASE=swapped\n {2}fail "update failed AND rollback health check failed/);
  });

  it('rollback_pod.sh marks the swap, and records restored only after a clean swap back', () => {
    const script = read('scripts/rollback_pod.sh');
    const start = script.indexOf('# --- swap ');
    assert.ok(start >= 0, 'missing the legacy swap section');
    const src = script.slice(start);
    assert.ok(src.indexOf('RESULT_PHASE=swapped') > src.indexOf('move_tree "$PREV" "$LIVE" || {'));
    assert.match(src, /RESULT_PHASE=swapping/);
    const back = src.slice(src.indexOf('# --- swap back on failure'));
    const restored = back.indexOf('RESULT_PHASE=restored');
    assert.ok(restored > back.indexOf('move_tree "$PREV" "$LIVE" || {'));
    assert.ok(restored < back.indexOf('move_tree "$TMP" "$PREV" || {'));
    assert.match(back, /else\n {2}RESULT_PHASE=swapped\n {2}fail "rollback failed AND the restore-back health check failed too/);
  });

  it('rollback_pod.sh turns a signal into a failed ending, not a success', async () => {
    const src = read('scripts/rollback_pod.sh');
    const traps = src.split('\n').filter(line => /^trap .* (EXIT|HUP|INT|TERM)$/.test(line));
    assert.equal(traps.length, 4, 'expected an exit trap and one each for HUP, INT and TERM');
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-signal-'));
    try {
      copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
say() { echo "$*"; }
RESULT_OPERATION=rollback
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
${traps.join('\n')}
RESULT_PHASE=swapped
echo ready
sleep 3 >/dev/null 2>&1 &
wait $!
`);
      const child = spawn('bash', [path.join(dir, 'harness.sh')]);
      await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      const closed = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await closed;
      const record = JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')) as Record<string, string>;
      assert.equal(record.outcome, 'failed');
      assert.equal(record.message, 'it was interrupted before it finished');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rollback_pod.sh finishes writing its result when a second signal arrives', async () => {
    const src = read('scripts/rollback_pod.sh');
    const traps = src.split('\n').filter(line => /^trap .* (EXIT|HUP|INT|TERM)$/.test(line));
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-signal-'));
    try {
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
say() { echo "$*"; }
RESULT_OPERATION=rollback
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
record_result() { echo writing; sleep 1; echo done > "${dir}/written"; }
${traps.join('\n')}
echo ready
sleep 5 >/dev/null 2>&1 &
wait $!
`);
      const child = spawn('bash', [path.join(dir, 'harness.sh')]);
      let seen = '';
      const waitFor = (word: string) => new Promise<void>(resolve => {
        const onData = (chunk: Buffer) => {
          seen += chunk.toString();
          if (seen.includes(word)) { child.stdout.off('data', onData); resolve(); }
        };
        child.stdout.on('data', onData);
        onData(Buffer.alloc(0));
      });
      await waitFor('ready');
      const closed = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await waitFor('writing');
      child.kill('SIGTERM');
      await closed;
      assert.ok(existsSync(path.join(dir, 'written')), 'the second signal cut the result write short');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switch-to-upstream.sh marks the swap and its own rollback', () => {
    const script = read('scripts/switch-to-upstream.sh');
    const start = script.indexOf('# --- atomic swap');
    assert.ok(start >= 0, 'missing the legacy swap section');
    const src = script.slice(start);
    assert.ok(src.indexOf('RESULT_PHASE=swapped') > src.indexOf('move_tree "$STAGE" "$LIVE" || {'));
    const rollback = src.indexOf('# --- automatic rollback');
    assert.ok(src.indexOf('RESULT_PHASE=restored', rollback) > src.indexOf('move_tree "$PREV" "$LIVE" || {', rollback));
    assert.ok(src.indexOf('RESULT_PHASE=swapping') > src.indexOf('# --- atomic swap'));
    // A server that will not stop has changed nothing, so it is not yet a swap.
    assert.ok(src.indexOf('RESULT_PHASE=swapping') > src.indexOf('could not stop the server before converting settings'));
    const phases = src.slice(src.indexOf('rm -rf "$PREV"\nmove_tree "$LIVE" "$PREV" || {'));
    assert.ok(phases.indexOf('RESULT_PHASE=restored') < phases.indexOf('fail "swap failed moving live aside"'));
    const secondMove = phases.indexOf('move_tree "$STAGE" "$LIVE" || {');
    assert.ok(phases.indexOf('RESULT_PHASE=restored', secondMove) < phases.indexOf('fail "swap failed; fork restored"'));
  });

  // Run the shell transaction branches with the offline installer stubbed.
  function transactionRecord(file: string, operation: string, from: string, to: string, transactionStatus: number, journal = true) {
    const src = read(file);
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    assert.ok(start >= 0 && end > start, 'missing the transaction section');
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-transaction-result-'));
    try {
      copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
      // Beside the harness, where the root-owned scripts the run started from would be.
      writeFileSync(path.join(dir, 'switch_installation.py'), '');
      mkdirSync(path.join(dir, 'transactions/recorded'), { recursive: true });
      if (journal) writeFileSync(path.join(dir, 'transactions/recorded/journal.json'), '{}');
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
NIGHTSTAND_TRANSACTION_ROOT="$FIXTURE/transactions"
say() { echo "$*"; }
RESULT_OPERATION=${operation}
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
fail() { say "FATAL: $*"; [ -n "\${RESULT_REASON:-}" ] || RESULT_REASON="$*"; exit 1; }
trap 'status=$?; printf "%s" "$RESULT_PHASE" > "$FIXTURE/phase"; record_result "$status"' EXIT
CUR_VERSION=3.6.0; ${operation === 'rollback' ? 'TARGET_VERSION=3.5.1' : 'STAGED_VERSION=1.0.0'}
LIVE="$FIXTURE/live"; PREV="$FIXTURE/prev"; STAGE="$FIXTURE/stage"
TRANSACTIONAL_SWITCH=yes; SWITCH_DIGEST=verified; SWITCH_ACTUAL=verified; CONFIRMED_TARGET=target; RECHECK_IN_USE=no
recheck_in_use() { :; }
${read('scripts/restore_helpers.sh')}
python3() {
  case "\${2:-}" in *switch_installation.py) echo "\${3:-}" >> "$FIXTURE/helper-calls" ;; esac
  case "\${3:-}" in
    fork) [ "$5" != "$LIVE" ] || { echo nightstand; return 0; }; echo upstream; return 0 ;;
    companion-recorded) echo yes; return 0 ;;
    companion) return 0 ;;
    forward|rollback)
      printf '%s\\n' "$RESULT_PHASE" >> "$FIXTURE/transaction-phases"
      return ${transactionStatus} ;;
  esac
  command python3 "$@"
}
${src.slice(start, end)}
fail "transaction fell through to the legacy swap"
`);
      const result = spawnSync('bash', [path.join(dir, 'harness.sh')], {
        encoding: 'utf8', timeout: 5_000, env: { ...process.env, FIXTURE: dir },
      });
      const readFixture = (name: string) => readFileSync(path.join(dir, name), 'utf8');
      const optional = (name: string) => { try { return readFixture(name); } catch { return ''; } };
      return {
        status: result.status, out: result.stdout + result.stderr,
        phases: optional('transaction-phases'), phase: readFixture('phase'), helperCalls: optional('helper-calls'),
        record: JSON.parse(readFixture('update-result.json')) as Record<string, string>,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const transactions = [
    ['scripts/rollback_pod.sh', 'rollback', '# Cross-fork rollback requires', '# Other forks cannot run',
      'cross-fork rollback requires complete companion state and a successful transaction'],
    ['scripts/switch-to-upstream.sh', 'switch', '# Confirmed V2 targets use', '# Upstream imports this',
      'the upstream transaction did not complete; see the retained recovery journal'],
  ];
  for (const [file, operation, from, to, reason] of transactions) {
    for (const [status, phase, outcome, ending] of [
      [0, 'swapped', 'success', 'commits'],
      [3, 'restored', 'rolled-back', 'cleanly restores the source'],
      [1, 'swapping', 'failed', 'fails without a clean restore'],
      [143, 'swapping', 'failed', 'is interrupted'],
    ] as const) {
      it(`${operation}: the transaction records swapping until it ${ending}`, () => {
        const result = transactionRecord(file, operation, from, to, status);
        assert.equal(result.status, status === 0 ? 0 : 1, result.out);
        assert.equal(result.phases, 'swapping\n', 'must mark swapping before the installer can move a tree');
        assert.equal(result.phase, phase, 'only a committed transaction is swapped, only a clean restore is restored');
        assert.equal(result.record.operation, operation);
        assert.equal(result.record.outcome, outcome);
        assert.equal(result.record.from, '3.6.0');
        assert.equal(result.record.to, operation === 'rollback' ? '3.5.1' : '1.0.0');
        if (status !== 0) assert.equal(result.record.message, reason);
      });
    }
  }

  it('rollback: never consults the switch helper without a published journal', () => {
    const [, , from, to] = transactions[0];
    const result = transactionRecord('scripts/rollback_pod.sh', 'rollback', from, to, 0, false);
    assert.match(result.out, /transaction fell through to the legacy swap/);
    assert.equal(result.helperCalls, '', 'ordinary rollback must not depend on the switch helper');
  });

  // Runs the swap section of a script with the moves stubbed, then returns what the exit trap recorded.
  function swapRecord(file: string, operation: string, from: string, failMove: 'live' | 'stage') {
    const src = read(file);
    const start = src.indexOf(from);
    assert.ok(start >= 0, `missing ${from}`);
    const section = src.slice(start, src.indexOf('RESULT_PHASE=swapped\n', start));
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-swap-'));
    try {
      copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
say() { echo "$*"; }
RESULT_OPERATION=${operation}
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
fail() { say "FATAL: $*"; [ -n "\${RESULT_REASON:-}" ] || RESULT_REASON="$*"; exit 1; }
trap 'record_result $?' EXIT
CUR_VERSION=3.5.1; EXPECTED_VERSION=3.6.0; STAGED_VERSION=1.0.0; TARGET_VERSION=3.6.0
LIVE=live; PREV=prev; STAGE=stage; BK=bk; IS_DOWNGRADE=no; STREAM_WAS_ACTIVE=no
RECOVERY_SOURCE=source; RECOVERY_HELPER=helper
bash() { :; }; sync() { :; }; recheck_in_use() { :; }
RESULT_PHASE=swapping
systemctl() { :; }; stop_writer() { :; }; stop_late_stream() { :; }; rm() { :; }; curl() { :; }; restore_switch_data_or_fail() { :; }
mv() { [ "$1" = ${failMove === 'live' ? 'live' : 'stage'} ] && return 1; return 0; }
move_tree() { mv "$@"; }
${section}
`);
      spawnSync('bash', [path.join(dir, 'harness.sh')], { encoding: 'utf8' });
      return JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')) as Record<string, string>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const swapCases: [string, string, string, string][] = [
    [
      'scripts/update.sh', 'update', 'RESULT_PHASE=swapping\nSTREAM_WAS_ACTIVE',
      'the new version could not be put in place, so it never started',
    ],
    [
      'scripts/switch-to-upstream.sh', 'switch', 'rm -rf "$PREV"\nmove_tree "$LIVE" "$PREV" || {',
      'upstream free-sleep could not be put in place, so it never started',
    ],
  ];
  for (const [file, operation, from, reason] of swapCases) {
    for (const move of ['live', 'stage'] as const) {
      it(`${operation}: a swap that failed and was put back says it never started (${move} move)`, () => {
        const record = swapRecord(file, operation, from, move);
        assert.equal(record.outcome, 'rolled-back');
        assert.equal(record.message, reason);
      });
    }
  }

  // Runs a script's own rollback to the end with the moves stubbed and the
  // previous version starting as given, and returns the record and how long
  // the script waited for it.
  function restoreRecord(file: string, operation: string, header: string, answers: (second: number) => string) {
    const src = read(file);
    const start = src.indexOf(header);
    assert.ok(start >= 0, `missing ${header}`);
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-restore-'));
    try {
      copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(dir, 'write_result.py'));
      const clock = path.join(dir, 'clock');
      writeFileSync(clock, '0');
      const codes = Array.from({ length: 200 }, (_, second) => answers(second)).join(' ');
      writeFileSync(path.join(dir, 'harness.sh'), `set -uo pipefail
say() { echo "$*"; }
RESULT_OPERATION=${operation}
${resultBlock(src).replaceAll('/persistent/free-sleep-data', dir)}
fail() { say "FATAL: $*"; [ -n "\${RESULT_REASON:-}" ] || RESULT_REASON="$*"; exit 1; }
trap 'record_result $?' EXIT
CUR_VERSION=3.6.0; EXPECTED_VERSION=3.5.1; STAGED_VERSION=1.0.0; TARGET_VERSION=3.5.1
LIVE=live; PREV=prev; TMP=tmp; FAILED=failed; STAGE=stage; BK=bk; MOVED_MODULES=no; STREAM_WAS_ACTIVE=no
SYSTEM_DIR=system; NIGHTSTAND_SCRIPTS=scripts; follow_scripts() { :; }
RESULT_PHASE=swapped
systemctl() { :; }; stop_writer() { :; }; rm() { :; }; mv() { :; }; move_tree() { :; }; sh() { :; }; tail() { :; }
restore_switch_data_or_fail() { :; }; restart_services() { :; }; fix_shared_node_modules() { :; }
sleep() { echo $(( $(cat '${clock}') + $1 )) > '${clock}'; }
# The server answers with the code for the current second; 000 is no answer.
curl() {
  local codes=(${codes}) code
  code=\${codes[$(cat '${clock}')]}
  case " $* " in *" -w "*) printf '%s' "$code" ;; esac
  [ "$code" = 000 ] && return 7
  case " $* " in *" -sf "*|*" -f "*) [ "$code" -ge 400 ] && return 22 ;; esac
  return 0
}
${src.slice(start)}
`);
      spawnSync('bash', [path.join(dir, 'harness.sh')], { encoding: 'utf8' });
      return {
        record: JSON.parse(readFileSync(path.join(dir, 'update-result.json'), 'utf8')) as Record<string, string>,
        waited: Number(readFileSync(clock, 'utf8')),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const restores: [string, string, string][] = [
    ['scripts/update.sh', 'update', '# --- automatic rollback'],
    ['scripts/rollback_pod.sh', 'rollback', '# --- swap back on failure'],
    ['scripts/switch-to-upstream.sh', 'switch', '# --- automatic rollback to this fork'],
  ];
  for (const [file, operation, header] of restores) {
    it(`${operation}: a previous version that takes 30 s to reach the Pod is restored`, () => {
      // It answers 503 until the firmware connects, as a cold start does.
      const { record } = restoreRecord(file, operation, header, second => (second < 30 ? '503' : '200'));
      assert.equal(record.outcome, 'rolled-back');
    });

    it(`${operation}: a previous version that never answers is not restored`, () => {
      const { record, waited } = restoreRecord(file, operation, header, () => '000');
      assert.equal(record.outcome, 'failed');
      assert.ok(waited >= 90 && waited <= 100, `waited ${waited} s`);
    });
  }

  it('the three scripts wait for the restored version the same way', () => {
    const helper = (src: string) => {
      const start = src.indexOf('restored_version_answers() {');
      assert.ok(start >= 0, 'missing restored_version_answers');
      return src.slice(start, src.indexOf('\n}\n', start) + 3);
    };
    const [reference] = restores.map(([file]) => helper(read(file)));
    for (const [file] of restores) assert.equal(helper(read(file)), reference, file);
  });

  it('ships the writer in the overlay for stock installs', () => {
    const entry = AGENT_MANIFEST.find(item => item.path === 'scripts/write_result.py');
    assert.ok(entry, 'scripts/write_result.py is not in the agent manifest');
    assert.equal(entry.mode, 'add');
  });
});
