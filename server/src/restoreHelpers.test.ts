import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// restore_helpers.sh holds the steps every root-run operation shares, so each
// exists once and cannot drift between the updater, the switch and the installers.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
const HELPERS = 'scripts/restore_helpers.sh';
const WINDOW = ['strip_top', 'open_wan', 'close_wan', 'run_limited', 'take_operation_lock'];
const USERS = ['scripts/update.sh', 'scripts/switch-to-upstream.sh', 'scripts/close_update_window.sh', 'scripts/enable_biometrics.sh'];

it('defines the download window and the operation lock once, in restore_helpers.sh', () => {
  for (const name of WINDOW) {
    const definition = new RegExp(`^${name}\\(\\) \\{`, 'm');
    assert.match(read(HELPERS), definition, name);
    for (const file of USERS) assert.doesNotMatch(read(file), definition, `${file} defines ${name}`);
  }
  for (const file of USERS) assert.doesNotMatch(read(file), /^WAN_RULE[S6]=/m, file);
});

it('takes the shared operation lock, and refuses while another run holds it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-operation-lock-'));
  const lock = path.join(dir, 'operation.lock');
  const take = () => spawnSync('bash', ['-c', `source "${path.join(repoRoot, HELPERS)}"; take_operation_lock; echo "status=$?"`], {
    env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: lock, NIGHTSTAND_OPERATION_OWNER: '' }, encoding: 'utf8',
  });
  try {
    assert.match(take().stdout, /status=0/);
    const holder = spawn('python3', ['-c',
      'import fcntl, sys, time\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(30)', lock]);
    try {
      await new Promise(resolve => holder.stdout.once('data', resolve));
      assert.match(take().stdout, /status=2/);
    } finally {
      holder.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('blocks the internet again after a restore even when the restored tree lost its block script', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-restore-block-'));
  try {
    mkdirSync(path.join(dir, 'copy/scripts'), { recursive: true });
    mkdirSync(path.join(dir, 'live/scripts'), { recursive: true });
    copyFileSync(path.join(repoRoot, HELPERS), path.join(dir, 'copy/scripts/restore_helpers.sh'));
    writeFileSync(path.join(dir, 'copy/scripts/block_internet_access.sh'), `echo blocked > '${dir}/blocked'\n`);
    const result = spawnSync('bash', ['-c', `say() { echo "$*"; }; systemctl() { :; }
LIVE="$1"; STREAM_WAS_ACTIVE=inactive; source "$2"; restore_restart_services best-effort`,
    'restore', path.join(dir, 'live'), path.join(dir, 'copy/scripts/restore_helpers.sh')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(path.join(dir, 'blocked')), result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
