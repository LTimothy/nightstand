import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateResultSchema } from './routes/update/updateSchema.js';
const repo = path.resolve('..');
const source = () => readFileSync(path.join(repo, 'scripts/recover_update.sh'), 'utf8');
const helperText = readFileSync(path.join(repo, 'scripts/restore_helpers.sh'), 'utf8');
const moveTree = helperText.slice(helperText.indexOf('move_tree() {'), helperText.indexOf('\n}\n', helperText.indexOf('move_tree() {')) + 3);
function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'update-recovery-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // Extracted blocks can omit say(), exposing macOS speech synthesis.
    writeFileSync(path.join(bin, 'say'), '#!/bin/sh\nprintf "%s\\n" "$*"\n');
    chmodSync(path.join(bin, 'say'), 0o755);
    const live = path.join(root, 'free-sleep');
    const prev = path.join(root, 'free-sleep-prev');
    const failed = path.join(root, 'free-sleep-failed');
    const stage = path.join(root, 'free-sleep-staging');
    const marker = path.join(root, 'persistent/free-sleep-data/update-swap.json');
    const calls = path.join(root, 'calls');
    mkdirSync(path.dirname(marker), { recursive: true });
    function tree(dir, version, modules = false, lock = 'same') {
        mkdirSync(path.join(dir, 'server/src'), { recursive: true });
        mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        writeFileSync(path.join(dir, 'server/src/serverInfo.json'), JSON.stringify({ version }));
        writeFileSync(path.join(dir, 'server/package-lock.json'), lock);
        writeFileSync(path.join(dir, 'scripts/version'), version);
        writeFileSync(path.join(dir, 'scripts/block_internet_access.sh'), `echo firewall >> '${calls}'\n`);
        if (modules) {
            mkdirSync(path.join(dir, 'server/node_modules'));
            writeFileSync(path.join(dir, 'server/node_modules/keep'), 'dependencies');
        }
    }
    tree(live, '3.6.0', true);
    const helper = path.join(root, 'restore_helpers.sh');
    writeFileSync(helper, readFileSync(path.join(repo, 'scripts/restore_helpers.sh')));
    const script = source().replaceAll('/home/dac/', `${root}/`).replaceAll('/persistent/', `${root}/persistent/`);
    writeFileSync(path.join(root, 'write_result.py'), readFileSync(path.join(repo, 'scripts/write_result.py')));
    writeFileSync(path.join(root, 'system_scripts.py'), readFileSync(path.join(repo, 'scripts/system_scripts.py')));
    writeFileSync(path.join(root, 'block_internet_access.sh'), `echo firewall >> '${calls}'\n`);
    const recoveryFile = path.join(root, 'recover_update.sh');
    writeFileSync(recoveryFile, script);
    const run = (args = [], options = {}, snippet) => {
        const database = options.database === 'malformed' ? '{' : JSON.stringify(options.database === 'missing' ? {} : { database: { status: options.database ?? 'healthy' } });
        return spawnSync('bash', ['-c', `
set -uo pipefail
systemctl() {
  echo "$*" >> '${calls}'
  case "$1" in
    is-active) if [ -f '${root}/stopped' ]; then echo inactive; return 3; else echo active; fi;;
    stop) ${options.stuck ? 'return 1' : `touch '${root}/stopped'`};;
    start|restart)
      ${options.serviceFailure === 'server' ? '[ "$*" != "start free-sleep" ] || return 1' : ':'}
      ${options.serviceFailure === 'stream' ? '[ "$*" != "restart free-sleep-stream" ] || return 1' : ':'}
      rm -f '${root}/stopped';;
  esac
}
curl() {
  echo curl >> '${calls}'
  local out=/dev/null url=
  while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; url=$1; shift; done
  if [ "$url" = http://127.0.0.1:3000/api/serverStatus ]; then
    printf '%s' '${database}' > "$out"
    printf 200
    return
  fi
  if ${options.healthy ? 'true' : `[ -f '${live}/restored' ] && [ -d '${live}/server/node_modules' ]`}; then
    python3 - '${live}' "$out" <<'PYHEALTH'
import json, sys
version=json.load(open(sys.argv[1]+'/server/src/serverInfo.json'))['version']
json.dump({'freeSleep': {'version': version}, 'left': {'currentTemperatureF': 80}}, open(sys.argv[2], 'w'))
PYHEALTH
    printf 200
  else
    printf 000
  fi
}
sleep() { ${options.lockSeconds !== undefined ? 'command sleep "$@"' : options.locked ? 'SECONDS=$((SECONDS + $1))' : ':'}; }
sync() { :; }
chown() { :; }
flock() { ${options.locked ? 'return 1' : "python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'"}; }
${options.lockBackend === 'python' ? `command() { if [ "$*" = '-v flock' ]; then return 1; fi; builtin command "$@"; }` : ''}
${options.lockSeconds !== undefined ? `
python3 - '${root}/locked' 8>>'${root}/lock' <<'PYLOCK' &
import fcntl, sys, time
fcntl.flock(8, fcntl.LOCK_EX)
open(sys.argv[1], "w").close()
time.sleep(${options.lockSeconds})
PYLOCK
holder=$!
trap 'kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true' EXIT
while [ ! -f '${root}/locked' ]; do command sleep 0.01; done
` : ''}
export -f systemctl curl sleep sync chown
${snippet ?? `source '${recoveryFile}' "$@"`}`, 'recovery', ...args], {
            encoding: 'utf8', timeout: options.lockSeconds !== undefined ? 45000 : 20000,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_OPERATION_LOCK: path.join(root, 'lock'),
                NIGHTSTAND_SYSTEM_DIR: path.join(root, 'system') },
        });
    };
    const arm = () => {
        const result = run(['--arm', 'active', '3.7.0']);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(existsSync(marker));
    };
    const prepare = (newLive = true, sharedModules = false) => {
        arm();
        renameSync(live, prev);
        writeFileSync(path.join(prev, 'restored'), 'yes');
        if (newLive)
            tree(live, '3.7.0', !sharedModules);
        if (sharedModules)
            renameSync(path.join(prev, 'server/node_modules'), path.join(live, 'server/node_modules'));
    };
    const version = (dir) => JSON.parse(readFileSync(path.join(dir, 'server/src/serverInfo.json'), 'utf8')).version;
    return { root, recoveryFile, live, prev, failed, stage, marker, calls, run, tree, arm, prepare, version,
        system: path.join(root, 'system'),
        dispose: () => rmSync(root, { recursive: true, force: true }) };
}
// setup_services.sh takes only a root-owned copy, so these tests publish the repository's scripts first.
const copyOf = (root) => spawnSync('python3', ['-B', path.join(repo, 'scripts/system_scripts.py'), 'publish', repo], { env: { ...process.env, NIGHTSTAND_SYSTEM_DIR: path.join(root, 'system') }, encoding: 'utf8' }).stdout.trim();
describe('interrupted update recovery', () => {
    const tool = path.join(repo, 'scripts/system_scripts.py');
    const publishTree = (system, dir) => spawnSync('python3', ['-B', tool, 'publish', dir], { env: { ...process.env, NIGHTSTAND_SYSTEM_DIR: system }, encoding: 'utf8' }).stdout.trim();
    const pointTo = (system, copy) => spawnSync('python3', ['-B', tool, 'point', copy], { env: { ...process.env, NIGHTSTAND_SYSTEM_DIR: system } });
    for (const healthy of [true, false]) {
        it(`after a power cut, root runs the copy of the tree recovery ${healthy ? 'kept' : 'restored'}`, () => {
            const box = fixture();
            try {
                const original = publishTree(box.system, box.live);
                box.prepare();
                const target = publishTree(box.system, box.live);
                pointTo(box.system, target);
                const result = box.run([], { healthy });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(readlinkSync(path.join(box.system, 'live')), `copies/${path.basename(healthy ? target : original)}`);
            }
            finally {
                box.dispose();
            }
        });
    }
    it('after a power cut back to a release without a copy, root keeps the new copy and recovery still settles', () => {
        const box = fixture();
        try {
            box.prepare();
            const target = publishTree(box.system, box.live);
            pointTo(box.system, target);
            const result = box.run([], { healthy: false });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(box.version(box.live), '3.6.0');
            assert.equal(readlinkSync(path.join(box.system, 'live')), `copies/${path.basename(target)}`);
            assert.ok(!existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('moves no tree into a symlink planted where the failed tree goes, and restarts the live tree', () => {
        const box = fixture();
        try {
            box.prepare();
            const outside = path.join(box.root, 'outside');
            mkdirSync(outside);
            // The server user owns /home/dac, so it can put a symlink back after the rm.
            const result = box.run([], {}, `rm() { command rm "$@"; [ "\${!#}" != '${box.failed}' ] || ln -s '${outside}' '${box.failed}'; }
source '${box.recoveryFile}'`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout, /could not preserve the failed tree/);
            assert.deepEqual(readdirSync(outside), []);
            assert.equal(box.version(box.live), '3.7.0');
            assert.equal(box.version(box.prev), '3.6.0');
            assert.match(readFileSync(box.calls, 'utf8'), /^start free-sleep$/m);
            assert.match(readFileSync(box.calls, 'utf8'), /^firewall$/m);
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    for (const serviceFailure of ['server', 'stream']) {
        it(`records a failed recovery when the ${serviceFailure} ${serviceFailure === 'server' ? 'start' : 'restart'} fails`, () => {
            const box = fixture();
            try {
                box.prepare();
                const resultFile = path.join(path.dirname(box.marker), 'update-result.json');
                writeFileSync(resultFile, JSON.stringify({ runId: 'previous-run', outcome: 'success' }));
                const result = box.run([], { serviceFailure });
                assert.equal(result.status, 1, result.stdout + result.stderr);
                const record = UpdateResultSchema.parse(JSON.parse(readFileSync(resultFile, 'utf8')));
                assert.equal(record.outcome, 'failed');
                assert.equal(record.from, '3.6.0');
                assert.equal(record.to, '3.7.0');
                assert.notEqual(record.runId, 'previous-run');
                assert.match(record.message, serviceFailure === 'server' ? /start free-sleep failed/ : /restart free-sleep-stream failed/);
                assert.ok(existsSync(box.marker));
                assert.equal(box.version(box.live), '3.6.0');
                assert.equal(box.version(box.failed), '3.7.0');
            }
            finally {
                box.dispose();
            }
        });
    }
    for (const healthy of [true, false]) {
        it(`records an interrupted update after ${healthy ? 'keeping the target' : 'restoring the original'}`, () => {
            const box = fixture();
            try {
                box.prepare();
                const resultFile = path.join(path.dirname(box.marker), 'update-result.json');
                writeFileSync(resultFile, JSON.stringify({ runId: 'previous-run', outcome: 'success' }));
                const result = box.run([], { healthy });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                const record = UpdateResultSchema.parse(JSON.parse(readFileSync(resultFile, 'utf8')));
                assert.equal(record.operation, 'update');
                assert.equal(record.outcome, healthy ? 'success' : 'rolled-back');
                assert.equal(record.from, '3.6.0');
                assert.equal(record.to, '3.7.0');
                assert.match(record.message, /interrupted/i);
                assert.notEqual(record.runId, 'previous-run');
                assert.match(record.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
                assert.ok(!existsSync(resultFile + '.tmp'));
                assert.ok(!existsSync(box.marker));
            }
            finally {
                box.dispose();
            }
        });
    }
    it('records an unsuccessful recovery and keeps its marker', () => {
        const box = fixture();
        try {
            box.prepare();
            rmSync(path.join(box.prev, 'restored'));
            const result = box.run();
            assert.equal(result.status, 1, result.stdout + result.stderr);
            const record = UpdateResultSchema.parse(JSON.parse(readFileSync(path.join(path.dirname(box.marker), 'update-result.json'), 'utf8')));
            assert.equal(record.outcome, 'failed');
            assert.equal(record.from, '3.6.0');
            assert.equal(record.to, '3.7.0');
            assert.match(record.message, /interrupted/i);
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('keeps the marker if the recovery result cannot be written', () => {
        const box = fixture();
        try {
            box.prepare();
            mkdirSync(path.join(path.dirname(box.marker), 'update-result.json'));
            const result = box.run([], { healthy: true });
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.ok(existsSync(box.marker));
            assert.equal(box.version(box.live), '3.7.0');
        }
        finally {
            box.dispose();
        }
    });
    it('preserves the previous result when the atomic replacement is interrupted', () => {
        const box = fixture();
        try {
            box.prepare();
            const resultFile = path.join(path.dirname(box.marker), 'update-result.json');
            const previous = JSON.stringify({ runId: 'previous-run', outcome: 'success' });
            writeFileSync(resultFile, previous);
            const writer = readFileSync(path.join(repo, 'scripts/write_result.py'), 'utf8');
            writeFileSync(path.join(box.root, 'write_result.py'), `import os
def interrupted_replace(source, destination):
    raise OSError("interrupted before rename")
os.replace = interrupted_replace
${writer}`);
            const result = box.run([], { healthy: true });
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.equal(readFileSync(resultFile, 'utf8'), previous);
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('recovers old markers with an unknown target version', () => {
        const box = fixture();
        try {
            box.prepare();
            const marker = JSON.parse(readFileSync(box.marker, 'utf8'));
            delete marker.toVersion;
            writeFileSync(box.marker, JSON.stringify(marker));
            const result = box.run([], { healthy: true });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const record = UpdateResultSchema.parse(JSON.parse(readFileSync(path.join(path.dirname(box.marker), 'update-result.json'), 'utf8')));
            assert.equal(record.from, '3.6.0');
            assert.equal(record.to, null);
        }
        finally {
            box.dispose();
        }
    });
    it('does nothing without a marker, even with a missing live tree', () => {
        const box = fixture();
        try {
            renameSync(box.live, box.prev);
            const result = box.run();
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(!existsSync(box.live));
            assert.ok(!existsSync(box.calls));
        }
        finally {
            box.dispose();
        }
    });
    it('arms a durable marker and clears it when explicitly settled', () => {
        const box = fixture();
        try {
            box.arm();
            assert.equal(box.run(['--clear']).status, 0);
            assert.ok(!existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('keeps healthy live code and clears the marker without stopping writers', () => {
        const box = fixture();
        try {
            box.prepare();
            const result = box.run([], { healthy: true });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(box.version(box.live), '3.7.0');
            assert.equal(box.version(box.prev), '3.6.0');
            assert.ok(!existsSync(box.marker));
            assert.doesNotMatch(readFileSync(box.calls, 'utf8'), /^stop /m);
        }
        finally {
            box.dispose();
        }
    });
    for (const database of ['failed', 'not_started', 'missing', 'malformed']) {
        it(`restores a responding new tree when database evidence is ${database}`, () => {
            const box = fixture();
            try {
                box.prepare();
                const result = box.run([], { healthy: true, database });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(box.version(box.live), '3.6.0');
                assert.equal(box.version(box.failed), '3.7.0');
                assert.ok(!existsSync(box.marker));
            }
            finally {
                box.dispose();
            }
        });
    }
    for (const missing of [true, false]) {
        it(`restores the previous tree when live is ${missing ? 'missing' : 'unhealthy'}`, () => {
            const box = fixture();
            try {
                box.prepare(!missing);
                const result = box.run();
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(box.version(box.live), '3.6.0');
                assert.ok(!existsSync(box.marker));
                assert.ok(existsSync(path.join(box.live, 'server/node_modules/keep')));
                if (!missing)
                    assert.equal(box.version(box.failed), '3.7.0');
                const calls = readFileSync(box.calls, 'utf8');
                assert.match(calls, /stop free-sleep\n/);
                assert.match(calls, /stop free-sleep-stream\n/);
                assert.match(calls, /firewall\n/);
                assert.match(calls, /start free-sleep\n/);
                assert.match(calls, /restart free-sleep-stream\n/);
            }
            finally {
                box.dispose();
            }
        });
    }
    it('returns shared dependencies to the restored tree only when lockfiles match', () => {
        for (const same of [true, false]) {
            const box = fixture();
            try {
                box.prepare(true, true);
                if (!same)
                    writeFileSync(path.join(box.live, 'server/package-lock.json'), 'different');
                box.run();
                assert.equal(existsSync(path.join(box.live, 'server/node_modules/keep')), same);
                assert.equal(existsSync(path.join(box.failed, 'server/node_modules/keep')), !same);
            }
            finally {
                box.dispose();
            }
        }
    });
    it('finishes returning dependencies if boot recovery was interrupted after restoring code', () => {
        const box = fixture();
        try {
            box.prepare(true, true);
            renameSync(box.live, box.failed);
            renameSync(box.prev, box.live);
            const result = box.run();
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(existsSync(path.join(box.live, 'server/node_modules/keep')));
            assert.equal(box.version(box.live), '3.6.0');
            assert.ok(!existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('retains the marker when the restored tree does not answer', () => {
        const box = fixture();
        try {
            box.prepare();
            rmSync(path.join(box.prev, 'restored'));
            const result = box.run();
            assert.notEqual(result.status, 0);
            assert.equal(box.version(box.live), '3.6.0');
            assert.equal(box.version(box.failed), '3.7.0');
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('refuses a malformed marker without moving trees or checking services', () => {
        const box = fixture();
        try {
            writeFileSync(box.marker, '{');
            const result = box.run();
            assert.notEqual(result.status, 0);
            assert.equal(box.version(box.live), '3.6.0');
            assert.ok(existsSync(box.marker));
            assert.ok(!existsSync(box.calls));
        }
        finally {
            box.dispose();
        }
    });
    it('keeps the marker and both trees when a writer refuses to stop', () => {
        const box = fixture();
        try {
            box.prepare();
            const result = box.run([], { stuck: true });
            assert.notEqual(result.status, 0);
            assert.equal(box.version(box.live), '3.7.0');
            assert.equal(box.version(box.prev), '3.6.0');
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('refuses recovery while another operation holds the lock', () => {
        const box = fixture();
        try {
            box.prepare();
            const result = box.run([], { locked: true });
            assert.notEqual(result.status, 0);
            assert.equal(box.version(box.live), '3.7.0');
            assert.ok(existsSync(box.marker));
            assert.ok(!existsSync(box.calls));
        }
        finally {
            box.dispose();
        }
    });
    for (const lockBackend of ['flock', 'python']) {
        it(`recovers after a three second lock hold using ${lockBackend}`, () => {
            const box = fixture();
            try {
                box.prepare();
                const result = box.run([], { lockSeconds: 3, lockBackend });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                assert.equal(box.version(box.live), '3.6.0');
                assert.ok(!existsSync(box.marker));
                assert.match(readFileSync(box.calls, 'utf8'), /start free-sleep\n/);
            }
            finally {
                box.dispose();
            }
        });
        it(`stops after thirty seconds of lock contention using ${lockBackend}`, () => {
            const box = fixture();
            try {
                box.prepare();
                const started = Date.now();
                const result = box.run([], { lockSeconds: 35, lockBackend });
                const elapsed = Date.now() - started;
                assert.equal(result.status, 1, result.stdout + result.stderr);
                assert.match(result.stdout, lockBackend === 'flock'
                    ? /Recovery stopped: another install, update, rollback or switch is already running/
                    : /Recovery stopped: another operation is running \(or lock unavailable\)/);
                assert.ok(elapsed >= 29_000 && elapsed < 35_000, `lock wait took ${elapsed} ms`);
                assert.equal(box.version(box.live), '3.7.0');
                assert.equal(box.version(box.prev), '3.6.0');
                assert.ok(existsSync(box.marker));
                assert.ok(!existsSync(box.calls));
            }
            finally {
                box.dispose();
            }
        });
    }
    it('does not restore a stale rollback slot before the live tree moved', () => {
        const box = fixture();
        try {
            box.tree(box.prev, '3.5.0');
            box.arm();
            const result = box.run();
            assert.notEqual(result.status, 0);
            assert.equal(box.version(box.live), '3.6.0');
            assert.equal(box.version(box.prev), '3.5.0');
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
});
describe('update.sh swap marker lifecycle', () => {
    it('refuses a pending marker before replacing staging files', () => {
        const box = fixture();
        try {
            box.arm();
            box.tree(box.stage, '3.7.0', true);
            const update = readFileSync(path.join(repo, 'scripts/update.sh'), 'utf8')
                .replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh', path.join(box.root, 'restore_helpers.sh'))
                .replaceAll('/home/dac/', `${box.root}/`).replaceAll('/persistent/', `${box.root}/persistent/`);
            const result = spawnSync('bash', ['-c', `
iptables() { :; }
ip6tables() { :; }
curl() { echo 'unexpected download'; exit 99; }
${update}`], {
                encoding: 'utf8', env: { ...process.env, NIGHTSTAND_OPERATION_LOCK: path.join(box.root, 'lock') },
            });
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout, /earlier update swap still needs recovery/);
            assert.doesNotMatch(result.stdout, /unexpected download/);
            assert.equal(box.version(box.stage), '3.7.0');
            assert.ok(existsSync(path.join(box.stage, 'server/node_modules/keep')));
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    for (const healthy of [true, false]) {
        it(`keeps the marker through health checking and clears it after ${healthy ? 'success' : 'restore'}`, () => {
            const box = fixture();
            try {
                box.tree(box.stage, '3.7.0');
                writeFileSync(path.join(box.live, 'restored'), 'yes');
                const systemd = path.join(box.root, 'systemd');
                const recovery = path.join(box.root, 'recovery');
                mkdirSync(systemd);
                for (const tree of [box.live, box.stage]) {
                    mkdirSync(path.join(tree, 'scripts/systemd'));
                    writeFileSync(path.join(tree, 'scripts/recover_update.sh'), source()
                        .replaceAll('/home/dac/', `${box.root}/`).replaceAll('/persistent/', `${box.root}/persistent/`));
                    for (const file of ['setup_services.sh', 'restore_helpers.sh', 'write_result.py', 'system_scripts.py',
                        'systemd/free-sleep-recover-update.service', 'systemd/free-sleep-recover-update.timer']) {
                        writeFileSync(path.join(tree, 'scripts', file), readFileSync(path.join(repo, 'scripts', file), 'utf8'));
                    }
                }
                const update = readFileSync(path.join(repo, 'scripts/update.sh'), 'utf8');
                const helpers = update.slice(update.indexOf('stop_writer()'), update.indexOf('# Set from the moment'));
                const swap = update.slice(update.indexOf('# --- atomic swap')).replaceAll('/persistent/', `${box.root}/persistent/`)
                    .replaceAll('/etc/systemd/system/', `${systemd}/`);
                const result = spawnSync('bash', ['-c', `
set -uo pipefail
LIVE="$FIXTURE/free-sleep"; PREV="$FIXTURE/free-sleep-prev"; STAGE="$FIXTURE/free-sleep-staging"; FAILED="$FIXTURE/free-sleep-failed"
SWAP_MARKER="$FIXTURE/persistent/free-sleep-data/update-swap.json"
RECOVERY_HELPER="$FIXTURE/recovery/recover_update.sh"; SYSTEM_DIR="$FIXTURE/system"
CUR_VERSION=3.6.0; STAGED_VERSION=3.7.0; IS_DOWNGRADE=no; LOCK_SAME=yes; BK=backup
RUNNING=$(python3 -B "$LIVE/scripts/system_scripts.py" publish "$LIVE")
NEW_COPY=$(python3 -B "$STAGE/scripts/system_scripts.py" publish "$STAGE")
source "$RUNNING/scripts/restore_helpers.sh"
RESULT_REASON=; RESTORE_TREE=; SWAP_NEW=; NPX=npx
say() { echo "$*"; }; fail() { echo "$*"; exit 1; }; recheck_in_use() { :; }
systemctl() {
  case "$1" in
    is-active) if [ -f "$FIXTURE/stopped" ]; then echo inactive; return 3; else echo active; fi;;
    stop) touch "$FIXTURE/stopped";;
    start|restart) rm -f "$FIXTURE/stopped";;
  esac
}
sudo() { :; }; chown() { :; }; sleep() { :; }; sync() { :; }; fw4() { return 0; }; fw6() { return 0; }
curl() {
  [ -f "$SWAP_MARKER" ] || { echo 'health checked without marker' >&2; exit 99; }
  echo health-with-marker >> "$FIXTURE/calls"
  local out=/dev/null
  while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
  if ${healthy ? 'true' : '[ -f "$LIVE/restored" ]'}; then
    python3 - "$LIVE" "$out" <<'PY'
import json, sys
version=json.load(open(sys.argv[1]+'/server/src/serverInfo.json'))['version']
json.dump({'freeSleep': {'version': version}, 'left': {'currentTemperatureF': 80}}, open(sys.argv[2], 'w'))
PY
    printf 200
  else printf 000; fi
}
export -f systemctl sync
${helpers}
${swap}`, 'update'], {
                    encoding: 'utf8', timeout: 20000,
                    env: { ...process.env, FIXTURE: box.root, NIGHTSTAND_SYSTEMD_DIR: systemd,
                        NIGHTSTAND_SUDOERS_FILE: path.join(box.root, 'sudoers'), NIGHTSTAND_RECOVERY_DIR: recovery,
                        NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
                });
                assert.equal(result.status, healthy ? 0 : 1, result.stdout + result.stderr);
                assert.equal(box.version(box.live), healthy ? '3.7.0' : '3.6.0');
                assert.ok(!existsSync(box.marker));
                assert.match(readFileSync(box.calls, 'utf8'), /health-with-marker/);
                assert.doesNotMatch(result.stderr, /health checked without marker/);
            }
            finally {
                box.dispose();
            }
        });
    }
    it('writes the marker before the swap can lose its live directory', () => {
        const update = readFileSync(path.join(repo, 'scripts/update.sh'), 'utf8');
        const swap = update.slice(update.indexOf('# --- atomic swap'), update.indexOf('RESULT_PHASE=swapped'));
        const box = fixture();
        try {
            box.tree(box.stage, '3.7.0');
            const helper = path.join(box.root, 'helper.sh');
            writeFileSync(helper, source().replaceAll('/home/dac/', `${box.root}/`).replaceAll('/persistent/', `${box.root}/persistent/`));
            const result = spawnSync('bash', ['-c', `
set -uo pipefail
LIVE="$FIXTURE/free-sleep"; PREV="$FIXTURE/free-sleep-prev"; STAGE="$FIXTURE/free-sleep-staging"
SWAP_MARKER="$FIXTURE/persistent/free-sleep-data/update-swap.json"
NIGHTSTAND_SCRIPTS="$FIXTURE/source/scripts"; RECOVERY_HELPER="$FIXTURE/helper.sh"
CUR_VERSION=3.6.0; STAGED_VERSION=3.7.0; IS_DOWNGRADE=no
say() { :; }; fail() { echo "$*"; exit 1; }; recheck_in_use() { :; }
systemctl() { echo inactive; }; stop_writer() { :; }; stop_late_stream() { :; }; sync() { :; }
bash() { if [ "$1" = "$RECOVERY_HELPER" ]; then command bash "$@"; else return 0; fi; }
rm() {
  if [ "$*" = "-rf $PREV" ]; then [ -f "$SWAP_MARKER" ] || exit 99; fi
  command rm "$@"
}
mv() {
  [ -f "$SWAP_MARKER" ] || exit 99
  [ "$1" != -T ] || shift
  command mv "$@"
  exit 137
}
${moveTree}
${swap}`], { encoding: 'utf8', env: { ...process.env, FIXTURE: box.root } });
            assert.equal(result.status, 137, result.stdout + result.stderr);
            assert.ok(!existsSync(box.live));
            assert.equal(box.version(box.prev), '3.6.0');
            assert.ok(existsSync(box.marker));
            const marker = JSON.parse(readFileSync(box.marker, 'utf8'));
            assert.equal(marker.version, '3.6.0');
            assert.equal(marker.toVersion, '3.7.0');
            const recovered = box.run([], { healthy: true });
            assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
            assert.equal(box.version(box.live), '3.6.0');
            assert.ok(!existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
});
describe('boot recovery bounds', () => {
    it('runs once after boot without ordering its completion into a boot target', () => {
        const unit = readFileSync(path.join(repo, 'scripts/systemd/free-sleep-recover-update.service'), 'utf8');
        const timer = readFileSync(path.join(repo, 'scripts/systemd/free-sleep-recover-update.timer'), 'utf8');
        assert.doesNotMatch(unit, /WantedBy=/);
        assert.match(unit, /^After=.*multi-user.target/m);
        assert.match(unit, /^TimeoutStartSec=60$/m);
        assert.match(unit, /^TimeoutStopSec=5$/m);
        assert.match(timer, /^OnBootSec=45s$/m);
        assert.doesNotMatch(timer, /OnUnitActiveSec|OnCalendar|Persistent=true/);
        assert.doesNotMatch(unit, /^Restart=/m);
    });
});
describe('recovery settlement', () => {
    for (const healthy of [true, false]) {
        it(`the updater trap ${healthy ? 'settles a healthy restore' : 'keeps an uncertain restore armed'}`, () => {
            const box = fixture();
            try {
                box.prepare();
                if (!healthy)
                    rmSync(path.join(box.prev, 'restored'));
                const update = readFileSync(path.join(repo, 'scripts/update.sh'), 'utf8');
                const helpers = `source "${path.join(repo, 'scripts/restore_helpers.sh')}"\n`
                    + update.slice(update.indexOf('stop_writer()'), update.indexOf('cleanup() {'));
                const result = box.run([], { healthy }, `
LIVE='${box.live}'; PREV='${box.prev}'; STAGE='${box.stage}'; FAILED='${box.failed}'
SWAP_MARKER='${box.marker}'; RECOVERY_HELPER='${box.recoveryFile}'
${moveTree}
${helpers}
CUR_VERSION=3.6.0; RESTORE_TREE=$PREV; SWAP_NEW=$STAGE; RESULT_PHASE=swapped; STREAM_WAS_ACTIVE=active
export NIGHTSTAND_OPERATION_OWNER=$$
trap 'finish_interrupted_swap' EXIT
trap 'exit 143' TERM
kill -TERM $$`);
                assert.equal(result.status, 143, result.stdout + result.stderr);
                assert.equal(box.version(box.live), '3.6.0');
                assert.equal(existsSync(box.marker), !healthy);
            }
            finally {
                box.dispose();
            }
        });
    }
    it('the upstream switch refuses a marker before downloads or staging changes', () => {
        const box = fixture();
        try {
            box.arm();
            const upstream = readFileSync(path.join(repo, 'scripts/switch-to-upstream.sh'), 'utf8')
                .replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh', path.join(box.root, 'restore_helpers.sh'))
                .replaceAll('/home/dac/', `${box.root}/`).replaceAll('/persistent/', `${box.root}/persistent/`);
            const result = box.run([], {}, `iptables() { :; }; ip6tables() { :; }; curl() { echo unexpected-download; exit 99; }; ${upstream}`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stdout, /earlier update swap still needs recovery/);
            assert.doesNotMatch(result.stdout, /unexpected-download/);
            assert.ok(existsSync(box.marker));
        }
        finally {
            box.dispose();
        }
    });
    it('a successful upstream switch retires all recovery artifacts', () => {
        const box = fixture();
        try {
            const units = path.join(box.root, 'systemd');
            const recovery = path.join(box.root, 'recovery');
            mkdirSync(units);
            mkdirSync(recovery);
            for (const file of ['free-sleep-recover-update.service', 'free-sleep-recover-update.timer']) {
                writeFileSync(path.join(units, file), 'installed');
            }
            for (const file of ['recover_update.sh', 'restore_helpers.sh'])
                writeFileSync(path.join(recovery, file), 'installed');
            box.arm();
            const upstream = readFileSync(path.join(repo, 'scripts/switch-to-upstream.sh'), 'utf8');
            const begin = upstream.indexOf('if [ "$HEALTHY" = yes ]; then');
            const block = upstream.slice(begin, upstream.indexOf('# --- automatic rollback', begin))
                .replaceAll('/etc/systemd/system/', `${units}/`).replaceAll('/usr/local/lib/nightstand/recovery', recovery)
                .replaceAll('/usr/local/lib/nightstand/', `${box.root}/system/`).replaceAll('/home/dac/', `${box.root}/`)
                .replaceAll('/persistent/', `${box.root}/persistent/`);
            const result = box.run([], {}, `HEALTHY=yes; LIVE='${box.live}'; PREV='${box.prev}'; STAGED_VERSION=upstream; BK=backup;
NIGHTSTAND_SCRIPTS='${box.root}/running/scripts'; ${block}`);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(!existsSync(box.marker));
            for (const file of ['free-sleep-recover-update.service', 'free-sleep-recover-update.timer']) {
                assert.ok(!existsSync(path.join(units, file)));
            }
            assert.ok(!existsSync(recovery));
        }
        finally {
            box.dispose();
        }
    });
    it('service setup leaves the armed recovery files untouched', () => {
        const box = fixture();
        try {
            const systemd = path.join(box.root, 'systemd');
            const recovery = path.join(box.root, 'recovery');
            mkdirSync(systemd);
            mkdirSync(recovery);
            for (const file of ['free-sleep-recover-update.service', 'free-sleep-recover-update.timer']) {
                writeFileSync(path.join(systemd, file), 'complete original unit');
            }
            for (const file of ['recover_update.sh', 'restore_helpers.sh'])
                writeFileSync(path.join(recovery, file), 'complete original helper');
            box.arm();
            const result = spawnSync('bash', [path.join(repo, 'scripts/setup_services.sh'), copyOf(box.root), '--recovery-only'], {
                encoding: 'utf8', env: { ...process.env, NIGHTSTAND_SYSTEMD_DIR: systemd,
                    NIGHTSTAND_RECOVERY_DIR: recovery, NIGHTSTAND_SWAP_MARKER: box.marker, NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            for (const file of ['free-sleep-recover-update.service', 'free-sleep-recover-update.timer']) {
                assert.equal(readFileSync(path.join(systemd, file), 'utf8'), 'complete original unit');
            }
            for (const file of ['recover_update.sh', 'restore_helpers.sh']) {
                assert.equal(readFileSync(path.join(recovery, file), 'utf8'), 'complete original helper');
            }
        }
        finally {
            box.dispose();
        }
    });
});
describe('durable recovery installation', () => {
    it('installs the result writer outside the trees an update moves', () => {
        const box = fixture();
        try {
            const systemd = path.join(box.root, 'systemd');
            const recovery = path.join(box.root, 'recovery');
            mkdirSync(systemd);
            const result = spawnSync('bash', ['-c', `
systemctl() { :; }
export -f systemctl
bash "$1" "$2" --recovery-only`, 'setup', path.join(repo, 'scripts/setup_services.sh'), copyOf(box.root)], {
                encoding: 'utf8', env: { ...process.env, NIGHTSTAND_SYSTEMD_DIR: systemd,
                    NIGHTSTAND_RECOVERY_DIR: recovery, NIGHTSTAND_SWAP_MARKER: box.marker, NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const resultFile = path.join(box.root, 'result.json');
            const written = spawnSync('python3', [path.join(recovery, 'write_result.py'), resultFile,
                'update', 'rolled-back', '3.6.0', '3.7.0', 'The update was interrupted.'], { encoding: 'utf8' });
            assert.equal(written.status, 0, written.stderr);
            const record = UpdateResultSchema.parse(JSON.parse(readFileSync(resultFile, 'utf8')));
            assert.equal(record.from, '3.6.0');
            assert.equal(record.to, '3.7.0');
            assert.equal(record.outcome, 'rolled-back');
        }
        finally {
            box.dispose();
        }
    });
    it('keeps the complete installed unit when replacement is interrupted before rename', () => {
        const box = fixture();
        try {
            const systemd = path.join(box.root, 'systemd');
            const recovery = path.join(box.root, 'recovery');
            mkdirSync(systemd);
            mkdirSync(recovery);
            const unit = path.join(systemd, 'free-sleep-recover-update.service');
            writeFileSync(unit, 'complete previous unit');
            const result = spawnSync('bash', ['-c', `
python3() {
  if [ "$1" = -B ]; then command python3 "$@"; return; fi
  command python3 -c '
import os, sys
sys.argv = sys.argv[1:]
replace = os.replace
def interrupted(source, destination):
    if destination.endswith(".service"):
        sys.exit(77)
    replace(source, destination)
os.replace = interrupted
exec(sys.stdin.read())' "$@"
}
systemctl() { :; }
export -f python3 systemctl
command bash "$1" "$2" --recovery-only`, 'setup', path.join(repo, 'scripts/setup_services.sh'), copyOf(box.root)], {
                encoding: 'utf8', env: { ...process.env, NIGHTSTAND_SYSTEMD_DIR: systemd,
                    NIGHTSTAND_RECOVERY_DIR: recovery, NIGHTSTAND_SWAP_MARKER: box.marker, NIGHTSTAND_SYSTEM_DIR: path.join(box.root, 'system') },
            });
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.doesNotMatch(result.stdout, /not a root-owned copy/);
            assert.equal(readFileSync(unit, 'utf8'), 'complete previous unit');
        }
        finally {
            box.dispose();
        }
    });
});
//# sourceMappingURL=updateRecoveryScript.test.js.map