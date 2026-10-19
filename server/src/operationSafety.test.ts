import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve('..');
const script = (name: string) => readFileSync(path.join(root, 'scripts', name), 'utf8')
  .replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh', path.join(root, 'scripts/restore_helpers.sh'));

for (const name of ['update.sh', 'switch-to-upstream.sh']) {
  it(`${name} does not clean the incumbent stage when its lock is refused`, () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'operation-refused-'));
    try {
      const stage = path.join(folder, name === 'update.sh' ? 'free-sleep-staging' : 'free-sleep-revert-staging');
      mkdirSync(stage);
      writeFileSync(path.join(stage, 'keep'), 'incumbent');
      const source = script(name).replaceAll('/home/dac/', folder + '/')
        .replaceAll('/persistent/', folder + '/persistent/');
      const result = spawnSync('bash', ['-c', 'iptables() { return 0; }; ip6tables() { return 0; }; flock() { return 1; };\n' + source], {
        encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: path.join(folder, 'lock') },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /already running/);
      assert.equal(readFileSync(path.join(stage, 'keep'), 'utf8'), 'incumbent');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}

it('real flock refuses all operations while another owns the shared lock', { skip: process.platform !== 'linux' }, async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'operation-lock-'));
  const lock = path.join(folder, 'operation.lock');
  const holder = spawn('bash', ['-c', 'exec 9>"$1"; flock -n 9 || exit 1; echo ready; read -r finish', 'lock', lock]);
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', () => reject(new Error('lock holder exited')));
      holder.stdout.once('data', () => resolve());
    });
    for (const name of ['update.sh', 'rollback_pod.sh', 'switch-to-upstream.sh']) {
      const source = script(name);
      const begin = source.indexOf('# Keep the descriptor');
      const end = source.indexOf('\nfi', begin) + 3;
      const result = spawnSync('bash', ['-c', 'fail() { echo "$*"; exit 1; };\n' + source.slice(begin, end)], {
        encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: lock },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /already running/);
    }
  } finally {
    holder.stdin.end('done\n');
    await new Promise<void>(resolve => holder.once('exit', () => resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const name of ['install.sh', 'reset.sh']) {
  it(`${name} refuses admission while stream reconciliation owns the lock`, async () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'operation-admission-'));
    const lock = path.join(folder, 'operation.lock');
    const source = script(name);
    const start = source.indexOf('# Share admission');
    const end = source.indexOf(name === 'reset.sh' ? 'SOCK_PATH=""' : '# Variables', start);
    assert.ok(start >= 0 && end > start);
    const admission = source.slice(start, end);
    const run = () => spawnSync('bash', ['-c', admission + '\necho admitted'], {
      encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: lock },
    });
    const holder = spawn('python3', ['-c',
      'import fcntl, sys; handle=open(sys.argv[1], "a+"); fcntl.flock(handle, fcntl.LOCK_EX);'
      + ' print("ready", flush=True); sys.stdin.read()', lock]);
    const closed = new Promise<void>(resolve => holder.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.once('exit', () => reject(new Error('lock holder exited')));
        holder.stdout.once('data', () => resolve());
      });
      const denied = run();
      assert.equal(denied.status, 1, denied.stdout + denied.stderr);
      assert.match(denied.stdout, /already running/);
      assert.doesNotMatch(denied.stdout, /admitted/);
      holder.stdin.end();
      await closed;
      const accepted = run();
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.match(accepted.stdout, /admitted/);
    } finally {
      holder.stdin.end();
      await closed;
      rmSync(folder, { recursive: true, force: true });
    }
  });
}

for (const name of ['install.sh', 'reset.sh']) {
  it(`${name} preserves inherited ownership across an exec handoff without a gap`, () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'operation-handoff-'));
    const lock = path.join(folder, 'operation.lock');
    try {
      writeFileSync(lock, '');
      const source = script(name);
      const start = source.indexOf('# Share admission');
      const end = source.indexOf(name === 'reset.sh' ? 'SOCK_PATH=""' : '# Variables', start);
      assert.ok(start >= 0 && end > start);
      const handoff = path.join(folder, 'handoff.sh');
      writeFileSync(handoff, `
flock() {
  python3 -c 'import fcntl, sys; fcntl.flock(open(sys.argv[1], "r"), fcntl.LOCK_EX | fcntl.LOCK_NB)' "$NIGHTSTAND_OPERATION_LOCK" \
    && { echo 'gap: independent contender acquired lock'; return 1; }
  python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
}
${source.slice(start, end)}
python3 -c 'import fcntl, sys
try: fcntl.flock(open(sys.argv[1], "r"), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
sys.exit("contender entered during the handoff")' "$NIGHTSTAND_OPERATION_LOCK"
`);
      const result = spawnSync('bash', ['-c', `
exec 9<"$NIGHTSTAND_OPERATION_LOCK"
python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' || exit 1
export NIGHTSTAND_OPERATION_OWNER=$$
exec bash "$1"
`, 'handoff', handoff], {
        encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: lock },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout, /gap:/);
      const contender = spawnSync('python3', ['-c',
        'import fcntl, sys; fcntl.flock(open(sys.argv[1], "r"), fcntl.LOCK_EX | fcntl.LOCK_NB)', lock]);
      assert.equal(contender.status, 0, 'the descriptor is released when the script exits');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
}

for (const name of ['update.sh', 'switch-to-upstream.sh']) {
  it(`${name} snapshots committed WAL rows separately from rotated code backups`, () => {
    const source = script(name);
    const block = source.slice(source.indexOf('# --- backup'), source.indexOf('# --- atomic swap'));
    const result = spawnSync('python3', ['-c', `
import pathlib, sqlite3, subprocess, sys, tempfile
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder); data=root/'data'; data.mkdir(); (data/'lowdb').mkdir()
 database=data/'free-sleep.db'; writer=sqlite3.connect(database)
 writer.execute('PRAGMA journal_mode=WAL'); writer.execute('PRAGMA wal_autocheckpoint=0')
 writer.execute('CREATE TABLE sample(value INTEGER)'); writer.commit()
 writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')
 writer.executemany('INSERT INTO sample VALUES (?)', [(n,) for n in range(205)]); writer.commit()
 block=sys.argv[1].replace('/persistent/free-sleep-data', str(data))
 block=block.replace('/persistent/free-sleep-database-backups', str(root/'database-backups'))
 setup='''set -uo pipefail
BACKUPS="'''+str(root/'code-backups')+'''"; DATABASE_BACKUPS="'''+str(root/'database-backups')+'''"
SQLITE_SAFETY="'''+sys.argv[2]+'''"
PRUNE_SNAPSHOTS="'''+str(pathlib.Path(sys.argv[2]).parent/'prune_db_snapshots.sh')+'''"
KEEP_BACKUPS=5; CUR_VERSION=3.3.1
say() { echo "$*"; }; fail() { echo "$*"; exit 1; }; tar() { :; }
'''
 run=subprocess.run(['bash','-c',setup+block],capture_output=True,text=True)
 assert run.returncode==0, run.stdout+run.stderr
 copies=list((root/'database-backups').glob('*.db'))
 assert len(copies)==1, 'No database snapshot outside rotating code backups'
 with sqlite3.connect(copies[0]) as backup:
  assert backup.execute('SELECT count(*) FROM sample').fetchone()[0]==205, 'WAL rows missing'
 writer.close()
`, block, path.join(root, 'scripts/sqlite-safety.py')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

it('a low disk refusal consumes the requested update target', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'update-preflight-'));
  try {
    const live = path.join(folder, 'home/dac/free-sleep');
    const data = path.join(folder, 'persistent/free-sleep-data');
    mkdirSync(path.join(live, 'server/src'), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(live, 'server/src/serverInfo.json'), '{"version":"3.3.1"}');
    writeFileSync(path.join(data, 'update-target.json'), '{"version":"3.0.0","allowDowngrade":true}');
    const source = script('update.sh').replaceAll('/home/dac/', `${folder}/home/dac/`)
      .replaceAll('/persistent', `${folder}/persistent`);
    const result = spawnSync('bash', ['-c', `
df() { printf 'header\ndisk 100 100 0\n'; }
flock() { return 0; }
iptables() { return 0; }
ip6tables() { return 0; }
export -f df flock iptables ip6tables
${source}`], { encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: path.join(folder, 'lock') } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /low disk/);
    assert.throws(() => readFileSync(path.join(data, 'update-target.json')));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it('downgrades stay in the current updater instead of handing off safety checks', () => {
  const source = script('update.sh');
  const condition = source.slice(source.lastIndexOf('\n  if ', source.indexOf('say "Handing the rest')),
    source.indexOf('say "Handing the rest'));
  assert.match(condition, /IS_DOWNGRADE.*!=.*yes/);
});

for (const name of ['update.sh', 'rollback_pod.sh', 'switch-to-upstream.sh']) {
  it(`${name} takes the same exclusive operation lock before preflight`, () => {
    const source = script(name);
    // The lock itself is pinned with the helpers in restoreHelpers.test.ts.
    const take = source.indexOf('\ntake_operation_lock\ncase $? in\n');
    assert.ok(take > 0 && take < source.indexOf('# --- preflight'));
    assert.match(source, /\ntake_operation_lock\ncase \$\? in\n {2}0\) ;;\n {2}1\) fail [^\n]+\n {2}\*\) fail /);
  });
}

it('an older archive script caps configured retention at fourteen days', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'archive-downgrade-'));
  try {
    const target = path.join(folder, 'archive-raw.sh');
    const conf = path.join(folder, 'raw-archive.conf');
    writeFileSync(target, readFileSync(path.join(root, 'fixtures/compat/archive-raw-v3.2.2.sh')));
    writeFileSync(conf, 'RETENTION_HOURS=480\n');
    const result = spawnSync('python3', [path.join(root, 'scripts/prepare-downgrade.py'), target, conf], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(target, 'utf8'), /^RETENTION_HOURS=336$/m);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it('an unrecognized archive script refuses a downgrade instead of deleting old data', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'archive-downgrade-'));
  try {
    const target = path.join(folder, 'archive-raw.sh');
    writeFileSync(target, '#!/bin/bash\nfind /archive -delete\n');
    const result = spawnSync('python3',
      [path.join(root, 'scripts/prepare-downgrade.py'), target, path.join(folder, 'missing.conf')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retention/i);
    assert.equal(readFileSync(target, 'utf8'), '#!/bin/bash\nfind /archive -delete\n');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
