import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve('..');
const script = path.join(repo, 'scripts/recover_switch.sh');

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'switch-recovery-')));
  const bin = path.join(root, 'bin');
  const live = path.join(root, 'live');
  const saved = path.join(root, 'saved');
  const failed = path.join(root, 'failed');
  const transactions = path.join(root, 'transactions');
  const calls = path.join(root, 'calls');
  const data = path.join(root, 'settings.json');
  mkdirSync(bin);
  mkdirSync(path.join(live, 'server/src'), { recursive: true });
  writeFileSync(path.join(live, 'server/src/serverInfo.json'), '{"version":"3.6.1"}');
  writeFileSync(data, 'original settings');
  writeFileSync(path.join(live, 'server/package-lock.json'), 'matching lockfile');
  mkdirSync(path.join(live, 'server/node_modules'));
  writeFileSync(path.join(live, 'server/node_modules/dependency'), 'original dependency');
  for (const family of ['iptables', 'ip6tables']) {
    const rules = path.join(root, `${family}-active`);
    writeFileSync(rules, '*filter\n:CUSTOM - [0:0]\n-A OUTPUT -j CUSTOM\nCOMMIT\n');
    for (const operation of ['save', 'restore']) {
      const executable = path.join(bin, `${family}-${operation}`);
      writeFileSync(executable, `#!/bin/sh
echo '${family}-${operation}' >> '${calls}'
if [ '${operation}' = restore ]; then
  [ "\${FIREWALL_FAIL:-}" != yes ] || exit 1
  cat > '${rules}'
else
  if [ "\${FIREWALL_MISMATCH:-}" = yes ]; then echo mismatched; else cat '${rules}'; fi
fi
`);
      chmodSync(executable, 0o755);
    }
  }
  writeFileSync(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, 'chown'), 0o755);
  writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> '${calls}'
case "$1" in
  is-active) echo "\${WRITER_STATE:-inactive}"; exit 3 ;;
  show) case "$*" in *InvocationID*) echo "\${OPERATION_ID:-}" ;; esac ;;
  start) if [ "\${CHECK_STARTUP_ON_START:-}" = yes ]; then
    /bin/bash '${script}' --startup-check "$3" || exit 1
  fi ;;
  kill) if [ -n "\${OPERATION_PGID:-}" ]; then
    python3 -c 'import os, signal, sys; os.killpg(int(sys.argv[1]), signal.SIGKILL)' "$OPERATION_PGID"
  fi ;;
esac
exit 0
`);
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    NIGHTSTAND_TRANSACTION_ROOT: transactions, NIGHTSTAND_OPERATION_LOCK: path.join(root, 'lock') };
  function arm(phase = 'installing', streamActive = false, streamEnabled = false) {
    const result = spawnSync('python3', ['-c', `
import os, sys
sys.path.insert(0, sys.argv[1] + '/scripts')
from switch_transaction import TransactionStore
from switch_services import Configuration, snapshot
from pathlib import Path
root, live, saved, failed, data, phase, stream_active, stream_enabled = sys.argv[2:]
info = os.lstat(live)
source = dict(fork='nightstand', commit='a'*40, treeSha256='b'*64, version='3.6.1', treePath=live)
target = dict(source, fork='upstream', version='3.0.3')
metadata = dict(recovery=dict(paths=[dict(kind='tree', live=live, saved=saved, failed=failed,
    device=info.st_dev, inode=info.st_ino,
    realParents={key: os.path.realpath(os.path.dirname(path)) for key, path in [('live', live), ('saved', saved), ('failed', failed)]})],
    services={'free-sleep.service': dict(active=True, enabled=True),
    'free-sleep-stream.service': dict(active=stream_active == 'true', enabled=stream_enabled == 'true')},
    operation=dict(unit='free-sleep-revert.service', invocationId='c'*32)))
store = TransactionStore(root)
store.create('switch', source, target, metadata)
if phase != 'armed':
    store.advance('switch', 'writers-stopped')
    store.snapshot('switch', 'settings', data)
    snapshot(store, 'switch', Configuration(Path(live).parent, live))
    for step in ['snapshots-ready', 'installing', 'validating', 'committed']:
        store.advance('switch', step)
        if step == phase: break
`, repo, transactions, live, saved, failed, data, phase, String(streamActive), String(streamEnabled)], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  function swap() {
    renameSync(live, saved);
    mkdirSync(path.join(live, 'server/src'), { recursive: true });
    writeFileSync(path.join(live, 'server/src/serverInfo.json'), '{"version":"3.0.3"}');
    writeFileSync(path.join(live, 'server/package-lock.json'), 'matching lockfile');
    writeFileSync(data, 'converted settings');
  }
  function run(extra: Record<string, string> = {}) {
    return spawnSync('bash', [script], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 10000 });
  }
  function journal() {
    const envelope = JSON.parse(readFileSync(path.join(transactions, 'switch/journal.json'), 'utf8')) as {
      journal: { phase: string; snapshots: Record<string, { backup: string }> };
    };
    return envelope.journal;
  }
  return { root, bin, live, saved, failed, transactions, calls, data, env, arm, swap, run, journal,
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe('switch recovery', () => {
  it('restores an uncommitted installation offline and is idempotent', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = box.run();
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      assert.equal(readFileSync(box.data, 'utf8'), 'original settings');
      assert.equal(JSON.parse(readFileSync(path.join(box.live, 'server/src/serverInfo.json'), 'utf8')).version, '3.6.1');
      assert.ok(existsSync(box.failed));
      assert.equal(box.journal().phase, 'recovered');
      const log = readFileSync(box.calls, 'utf8');
      assert.doesNotMatch(log, /(?:start|restart) (?!.*--no-block).*free-sleep|--now /);
      assert.match(log, /start --no-block free-sleep.service/);
      assert.doesNotMatch(log, /start .*free-sleep-stream/);
      assert.match(log, /enable free-sleep.service/);
      assert.match(log, /disable free-sleep-stream.service/);
    } finally { box.dispose(); }
  });

  it('allows restored service startup when the boot recovery unit is already active', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      const result = box.run({ CHECK_STARTUP_ON_START: 'yes' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(box.journal().phase, 'recovered');
    } finally { box.dispose(); }
  });

  it('restores enablement separately and starts only previously active streams', () => {
    for (const active of [true, false]) {
      for (const enabled of [true, false]) {
        const box = fixture();
        try {
          box.arm('installing', active, enabled); box.swap();
          const result = box.run();
          assert.equal(result.status, 0, result.stdout + result.stderr);
          const log = readFileSync(box.calls, 'utf8');
          assert.equal(log.includes('start --no-block free-sleep-stream.service'), active);
          assert.ok(log.includes(`${enabled ? 'enable' : 'disable'} free-sleep-stream.service`));
        } finally { box.dispose(); }
      }
    }
  });

  it('restores moved Node dependencies before releasing services', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      renameSync(path.join(box.saved, 'server/node_modules'), path.join(box.live, 'server/node_modules'));
      const result = box.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(path.join(box.live, 'server/node_modules/dependency'), 'utf8'), 'original dependency');
      assert.ok(!existsSync(path.join(box.failed, 'server/node_modules')));
      assert.equal(box.journal().phase, 'recovered');
    } finally { box.dispose(); }
  });

  it('reapplies both live firewall families with custom rules before service starts', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      for (const family of ['iptables', 'ip6tables']) writeFileSync(path.join(box.root, `${family}-active`), 'replacement rules');
      const result = box.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const family of ['iptables', 'ip6tables']) {
        assert.equal(readFileSync(path.join(box.root, `${family}-active`), 'utf8'), '*filter\n:CUSTOM - [0:0]\n-A OUTPUT -j CUSTOM\nCOMMIT\n');
      }
      const log = readFileSync(box.calls, 'utf8');
      assert.ok(log.indexOf('ip6tables-restore') < log.indexOf('start --no-block'));
    } finally { box.dispose(); }
  });

  it('keeps recovery incomplete when live firewall restoration or verification fails', () => {
    for (const failure of ['FIREWALL_FAIL', 'FIREWALL_MISMATCH']) {
      const box = fixture();
      try {
        box.arm(); box.swap();
        const result = box.run({ [failure]: 'yes' });
        assert.notEqual(result.status, 0);
        assert.equal(box.journal().phase, 'recovering');
        assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /start --no-block/);
        assert.equal(box.run().status, 0);
      } finally { box.dispose(); }
    }
  });

  it('fails recovery when moved dependencies do not match the restored lockfile', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      renameSync(path.join(box.saved, 'server/node_modules'), path.join(box.live, 'server/node_modules'));
      writeFileSync(path.join(box.live, 'server/package-lock.json'), 'different lockfile');
      assert.notEqual(box.run().status, 0);
      assert.equal(box.journal().phase, 'recovering');
      assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /start --no-block/);
    } finally { box.dispose(); }
  });

  it('fails closed on malformed journals without changing evidence', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      const file = path.join(box.transactions, 'switch/journal.json');
      writeFileSync(file, 'incomplete journal');
      const result = box.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unreadable transaction journal/);
      assert.equal(readFileSync(file, 'utf8'), 'incomplete journal');
      assert.equal(readFileSync(box.data, 'utf8'), 'converted settings');
      assert.ok(existsSync(box.saved));
    } finally { box.dispose(); }
  });

  it('never restores a committed transaction', () => {
    const box = fixture();
    try {
      box.arm('committed'); box.swap();
      assert.equal(box.run().status, 0);
      assert.equal(readFileSync(box.data, 'utf8'), 'converted settings');
      assert.equal(box.journal().phase, 'committed');
      assert.ok(existsSync(box.saved));
    } finally { box.dispose(); }
  });

  it('recovers an interruption between the two tree renames', () => {
    const box = fixture();
    try {
      box.arm(); renameSync(box.live, box.saved);
      assert.equal(box.run().status, 0);
      assert.equal(box.journal().phase, 'recovered');
      assert.ok(existsSync(box.live));
      assert.ok(!existsSync(box.saved));
    } finally { box.dispose(); }
  });

  it('restores the original environment at its executable path without moving the prepared environment', () => {
    const box = fixture();
    try {
      const venv = path.join(box.root, 'venv');
      const saved = path.join(box.root, 'venv-saved');
      const failed = path.join(box.root, 'venv-failed');
      const prepared = path.join(box.root, 'upstream-env');
      mkdirSync(path.join(venv, 'bin'), { recursive: true });
      mkdirSync(prepared);
      writeFileSync(path.join(venv, 'bin/python'), '#!/bin/sh\nprintf original-interpreter\n');
      chmodSync(path.join(venv, 'bin/python'), 0o755);
      box.arm();
      const record = spawnSync('python3', ['-c', `
import os, sys
sys.path.insert(0, sys.argv[1] + '/scripts')
from switch_transaction import TransactionStore
store = TransactionStore(sys.argv[2])
venv, saved, failed = sys.argv[3:]
info = os.lstat(venv)
journal = store.load('switch')
journal['metadata']['recovery']['paths'].append(dict(kind='environment', live=venv, saved=saved, failed=failed,
    device=info.st_dev, inode=info.st_ino,
    realParents={key: os.path.realpath(os.path.dirname(path)) for key, path in [('live', venv), ('saved', saved), ('failed', failed)]}))
store._write(journal)
`, repo, box.transactions, venv, saved, failed], { encoding: 'utf8' });
      assert.equal(record.status, 0, record.stderr);
      renameSync(venv, saved); symlinkSync(prepared, venv);
      box.swap();
      const result = box.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(spawnSync(path.join(venv, 'bin/python'), [], { encoding: 'utf8' }).stdout, 'original-interpreter');
      assert.ok(existsSync(prepared));
      assert.ok(existsSync(failed));
    } finally { box.dispose(); }
  });

  it('blocks startup and preserves evidence when the original identity is missing', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      renameSync(box.saved, path.join(box.root, 'unrecorded'));
      const result = box.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Original installation is missing/);
      assert.equal(readFileSync(box.data, 'utf8'), 'converted settings');
      assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /start /);
    } finally { box.dispose(); }
  });

  it('blocks startup when a snapshot is corrupt and retries recovery after its repair', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      const backup = path.join(box.transactions, 'switch', box.journal().snapshots.settings.backup);
      writeFileSync(backup, 'corrupt');
      const result = box.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Snapshot checksum mismatch/);
      assert.equal(box.journal().phase, 'recovering');
      assert.equal(readFileSync(box.data, 'utf8'), 'converted settings');
      assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /start /);
      writeFileSync(backup, 'original settings');
      assert.equal(box.run().status, 0);
      assert.equal(readFileSync(box.data, 'utf8'), 'original settings');
      assert.equal(box.journal().phase, 'recovered');
    } finally { box.dispose(); }
  });

  it('allows ordinary maintenance startup with no journal while the operation lock is held', async () => {
    const box = fixture();
    const owner = spawn('python3', ['-u', '-c', `
import fcntl, sys, time
with open(sys.argv[1], 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('locked', flush=True)
    time.sleep(20)
`, box.env.NIGHTSTAND_OPERATION_LOCK]);
    try {
      await new Promise<void>((resolve, reject) => {
        owner.stdout.once('data', () => resolve());
        owner.once('error', reject);
      });
      const result = box.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      box.arm();
      const blocked = box.run();
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /holds the lock/);
      assert.equal(box.journal().phase, 'installing');
    } finally { owner.kill('SIGKILL'); box.dispose(); }
  });

  it('refuses to restore while a writer remains active', () => {
    const box = fixture();
    try {
      box.arm(); box.swap();
      assert.notEqual(box.run({ WRITER_STATE: 'active' }).status, 0);
      assert.equal(readFileSync(box.data, 'utf8'), 'converted settings');
      assert.ok(existsSync(box.saved));
    } finally { box.dispose(); }
  });

  it('kills the recorded operation cgroup before acquiring its inherited lock', () => {
    const box = fixture();
    try {
      box.arm();
      // The fake controller represents a still-running recorded invocation.
      const result = box.run({ OPERATION_ID: 'c'.repeat(32) });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const log = readFileSync(box.calls, 'utf8');
      assert.match(log, /kill --kill-who=all --signal=SIGKILL free-sleep-revert.service/);
      assert.ok(log.indexOf('kill ') < log.indexOf('is-active free-sleep.service'));
    } finally { box.dispose(); }
  });

  it('stops a surviving descendant that holds the killed operation parent lock', async () => {
    const box = fixture();
    box.arm();
    const owner = spawn('python3', ['-u', '-c', `
import fcntl, subprocess, sys, time
with open(sys.argv[1], 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'], pass_fds=[lock.fileno()],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('locked', flush=True)
    time.sleep(20)
`, box.env.NIGHTSTAND_OPERATION_LOCK], { detached: true });
    try {
      await new Promise<void>((resolve, reject) => {
        owner.stdout.once('data', () => resolve());
        owner.once('error', reject);
      });
      await new Promise<void>(resolve => {
        owner.once('exit', () => resolve());
        owner.kill('SIGKILL');
      });
      assert.notEqual(box.run().status, 0, 'the descendant still owns the inherited lock');
      const result = box.run({ OPERATION_ID: 'c'.repeat(32), OPERATION_PGID: String(owner.pid) });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(box.journal().phase, 'recovered');
    } finally {
      if (owner.pid) {
        try { process.kill(-owner.pid, 'SIGKILL'); } catch { /* The controller already stopped the group. */ }
      }
      box.dispose();
    }
  });

  it('installs independent, durable recovery and writer startup dependencies', () => {
    const box = fixture();
    try {
      const systemd = path.join(box.root, 'systemd');
      const recovery = path.join(box.root, 'recovery');
      mkdirSync(systemd);
      const result = spawnSync('bash', [path.join(repo, 'scripts/setup_services.sh'), repo, '--recovery-only'], {
        encoding: 'utf8', env: { ...box.env, NIGHTSTAND_SYSTEMD_DIR: systemd,
          NIGHTSTAND_RECOVERY_DIR: path.join(box.root, 'update-recovery'), NIGHTSTAND_SWITCH_RECOVERY_DIR: recovery,
          NIGHTSTAND_SWAP_MARKER: path.join(box.root, 'update-swap.json'), NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const unit = readFileSync(path.join(systemd, 'free-sleep-recover-switch.service'), 'utf8');
      assert.match(unit, /^RequiresMountsFor=\/persistent \/home\/dac$/m);
      assert.match(unit, /^RemainAfterExit=yes$/m);
      assert.ok(unit.split('\n').includes(`ConditionPathExistsGlob=${box.transactions}/*/journal.json`));
      assert.doesNotMatch(unit, /After=.*free-sleep\.service/);
      assert.ok(existsSync(path.join(recovery, 'recover_switch.sh')));
      for (const writer of ['free-sleep', 'free-sleep-stream', 'free-sleep-update', 'free-sleep-archive-raw', 'free-sleep-health']) {
        const gate = readFileSync(path.join(systemd, `${writer}.service.d/nightstand-switch-recovery.conf`), 'utf8');
        assert.match(gate, /^Wants=free-sleep-recover-switch.service$/m);
        assert.match(gate, /^After=free-sleep-recover-switch.service$/m);
        const command = /^ExecStartPre=(.+)$/m.exec(gate)?.[1];
        assert.ok(command, 'Every start must validate journals even when the boot gate is active');
        assert.ok(command.startsWith('+'), 'Writer checks must run with full privileges');
        const start = () => spawnSync('python3', ['-c',
          'import shlex, subprocess, sys; sys.exit(subprocess.run(shlex.split(sys.argv[1])).returncode)',
          command.slice(1).replaceAll('$$', '$').replaceAll('%%', '%')], { encoding: 'utf8', env: box.env });
        assert.equal(start().status, 0);
        if (writer === 'free-sleep') {
          box.arm();
          assert.notEqual(start().status, 0, 'A switch armed after boot must block a later start');
          writeFileSync(path.join(box.transactions, 'switch/journal.json'), 'corrupt');
          assert.notEqual(start().status, 0, 'A newly corrupt journal must also block startup');
          rmSync(box.transactions, { recursive: true });
        }
      }
      assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /(?:start|--now) free-sleep-recover-switch/);
      box.arm();
      writeFileSync(path.join(recovery, 'recover_switch.sh'), 'retained helper');
      copyFileSync(path.join(repo, 'scripts/setup_services.sh'), path.join(box.root, 'setup.sh'));
      copyFileSync(path.join(repo, 'scripts/system_scripts.py'), path.join(box.root, 'system_scripts.py'));
      const again = spawnSync('bash', [path.join(box.root, 'setup.sh'), repo, '--recovery-only'], {
        encoding: 'utf8', env: { ...box.env, NIGHTSTAND_SYSTEMD_DIR: systemd,
          NIGHTSTAND_RECOVERY_DIR: path.join(box.root, 'update-recovery'), NIGHTSTAND_SWITCH_RECOVERY_DIR: recovery,
          NIGHTSTAND_SWAP_MARKER: path.join(box.root, 'update-swap.json'), NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
      });
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.equal(readFileSync(path.join(recovery, 'recover_switch.sh'), 'utf8'), 'retained helper');
    } finally { box.dispose(); }
  });
});
