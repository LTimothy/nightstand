import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
