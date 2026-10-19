import assert from 'node:assert/strict';
import { it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SHARED = [...WINDOW, 'record_result', 'read_request', 'recheck_in_use', 'stop_late_stream', 'restore_stop_writer'];
const shellFiles = (dir: string): string[] => readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
  .flatMap(entry => (entry.isDirectory() ? (entry.name === 'migrate' ? shellFiles(`${dir}/${entry.name}`) : [])
    : entry.name.endsWith('.sh') ? [`${dir}/${entry.name}`] : []));
const ALL_SHELL = [...shellFiles('scripts'), ...shellFiles('ops')];

it('defines each shared helper once, in restore_helpers.sh', () => {
  for (const name of SHARED) {
    const definition = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm');
    assert.deepEqual(ALL_SHELL.filter(file => definition.test(read(file))), [HELPERS], name);
  }
  // The writer stop's body lives in restore_stop_writer; install.sh runs before any tree exists.
  const body = /case "\$\(systemctl is-active "\$1" 2>\/dev\/null\)" in/;
  assert.deepEqual(ALL_SHELL.filter(file => body.test(read(file))).sort(), ['scripts/install.sh', HELPERS].sort());
});

it('a staged updater sources the helpers from its own tree before it uses one', () => {
  // A 3.6.x updater execs the staged update.sh, so the helpers must come from the staged tree.
  for (const file of ['scripts/update.sh', 'scripts/rollback_pod.sh', 'scripts/switch-to-upstream.sh']) {
    const src = read(file);
    const source = src.indexOf('source "$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh"');
    assert.ok(source > 0, `${file} does not source its own restore_helpers.sh`);
    for (const call of ['\nread_request\n', 'take_operation_lock', 'open_wan\n']) {
      const at = src.indexOf(call);
      assert.ok(at === -1 || at > source, `${file} uses ${call.trim()} before sourcing the helpers`);
    }
  }
  const stage = mkdtempSync(path.join(tmpdir(), 'nightstand-staged-'));
  try {
    mkdirSync(path.join(stage, 'scripts'));
    for (const file of ['update.sh', 'restore_helpers.sh']) {
      copyFileSync(path.join(repoRoot, 'scripts', file), path.join(stage, 'scripts', file));
    }
    const types = spawnSync('bash', ['-c', `source "${stage}/scripts/restore_helpers.sh"; for f in ${SHARED.join(' ')}; do type -t "$f"; done`],
      { encoding: 'utf8' });
    assert.deepEqual(types.stdout.trim().split('\n'), SHARED.map(() => 'function'), types.stderr);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

it('deploy opens its window with the root-owned copy of the helpers', () => {
  const deploy = read('ops/deploy.sh');
  const deps = deploy.slice(deploy.indexOf("<<'DEPS'"), deploy.indexOf('\nDEPS\n'));
  assert.match(deps, /source "\$COPY\/scripts\/restore_helpers\.sh"/);
  assert.doesNotMatch(deps, /^(strip_top|run_limited|restore_output_policy|fw4|fw6)\(\)/m);
  assert.doesNotMatch(deps, /^WAN_RULES=/m);
});
