import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// scripts/health_check.sh runs every minute from free-sleep-health.timer and
// restarts a server that is running but no longer answers. These run it for
// real with systemctl, curl and flock stubbed, a fake /proc/locks and a fake
// uptime, so nothing on the host is touched.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/health_check.sh');
// The key /proc/locks prints for a file: hex major:minor, then the inode.
function lockKey(file) {
    return execFileSync('python3', ['-c',
        'import os, sys; s = os.stat(sys.argv[1]); print("%02x:%02x:%d" % (os.major(s.st_dev), os.minor(s.st_dev), s.st_ino))',
        file], { encoding: 'utf8' }).trim();
}
function setup({ active = 'active', answers = false, status, silentCurl = false, lockHeld = false, otherDeviceLock = false, procLocks = true, activeSince, uptime = 100000, } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-health-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    const stub = (name, body) => {
        writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
    };
    const show = activeSince === undefined ? '' : `echo ActiveEnterTimestampMonotonic=${activeSince * 1000000}`;
    stub('systemctl', `[ "$1" = is-active ] && echo ${active}\n[ "$1" = show ] && { ${show || ':'}; }\nexit 0`);
    // Like curl -w '%{http_code}': 000 and a non-zero exit when nothing answered.
    const code = status ?? (answers ? 200 : undefined);
    // With -f, curl itself fails on an HTTP error status.
    const failFlag = code !== undefined && code >= 400
        ? `for a in "$@"; do case "$a" in --fail | -[!-]*f*) printf ${code}; exit 22 ;; esac; done\n` : '';
    stub('curl', silentCurl ? 'exit 127'
        : code === undefined ? 'printf 000; exit 28' : `${failFlag}printf ${code}; exit 0`);
    // Only reached when /proc/locks cannot be read.
    stub('flock', `exit ${lockHeld ? 1 : 0}`);
    const lock = path.join(dir, 'operation.lock');
    writeFileSync(lock, '');
    const locks = path.join(dir, 'locks');
    if (procLocks) {
        const key = lockKey(lock);
        const elsewhere = `${key.split(':')[0] === 'fe' ? 'fd' : 'fe'}:01:${statSync(lock).ino}`;
        const holder = (lockHeld ? `1: FLOCK  ADVISORY  WRITE 4242 ${key} 0 EOF\n` : '')
            + (otherDeviceLock ? `3: FLOCK  ADVISORY  WRITE 4343 ${elsewhere} 0 EOF\n4: -> FLOCK  ADVISORY  WRITE 4344 ${elsewhere} 0 EOF\n` : '');
        writeFileSync(locks, `2: FLOCK  ADVISORY  WRITE 99 08:01:1 0 EOF\n${holder}`);
    }
    const uptimeFile = path.join(dir, 'uptime');
    writeFileSync(uptimeFile, `${uptime}.42 1234.00\n`);
    const state = path.join(dir, 'failures');
    const run = () => spawnSync('bash', [SCRIPT], {
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            NIGHTSTAND_HEALTH_STATE: state,
            NIGHTSTAND_OPERATION_LOCK: lock,
            NIGHTSTAND_PROC_LOCKS: locks,
            NIGHTSTAND_UPTIME: uptimeFile,
        },
        encoding: 'utf8',
    });
    const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
    return { run, log, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
describe('health_check.sh', () => {
    it('parses and carries the exec bit', () => {
        assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
        assert.ok(statSync(SCRIPT).mode & 0o111, 'health_check.sh must carry the exec bit');
    });
    it('restarts only after three failed checks in a row', () => {
        const t = setup();
        t.run();
        t.run();
        assert.doesNotMatch(t.log(), /systemctl restart free-sleep/);
        const third = t.run();
        assert.match(t.log(), /systemctl restart free-sleep/);
        assert.match(third.stdout, /Nightstand did not answer 3 checks in a row; restarting it/);
        assert.equal(existsSync(t.state), false);
        t.cleanup();
    });
    it('asks the liveness route, which writes no files', () => {
        // The full status rewrites the services file, which every minute is
        // needless flash wear and races the server's own writes to it.
        const t = setup({ answers: true });
        t.run();
        assert.match(t.log(), /^curl .* http:\/\/127\.0\.0\.1:3000\/api\/serverStatus\/alive$/m);
        t.cleanup();
    });
    it('asks systemd for the restart without waiting on it', () => {
        // A frozen server takes systemd's whole stop timeout to kill, and the
        // check has no reason to sit through it.
        const t = setup();
        t.run();
        t.run();
        t.run();
        assert.match(t.log(), /systemctl restart free-sleep --no-block/);
        t.cleanup();
    });
    it('never restarts a server that answers, even with an error', () => {
        // An error is still an answer, and with a full or read-only /persistent
        // a restarted server could not start again at all. Only no answer counts.
        for (const status of [500, 503, 404]) {
            const t = setup({ status });
            writeFileSync(t.state, '2');
            for (let i = 0; i < 5; i++)
                t.run();
            assert.doesNotMatch(t.log(), /restart/, `HTTP ${status} must not restart the server`);
            assert.equal(existsSync(t.state), false, `HTTP ${status} is an answer and clears the count`);
            t.cleanup();
        }
    });
    it('counts only curl\'s own no-answer code, never an empty result', () => {
        // curl prints 000 whenever it runs and nothing answers. Printing nothing
        // means curl itself did not run, which says nothing about the server.
        const t = setup({ silentCurl: true });
        for (let i = 0; i < 5; i++)
            t.run();
        assert.doesNotMatch(t.log(), /restart/);
        t.cleanup();
    });
    it('forgets failures once the server answers', () => {
        const t = setup({ answers: true });
        writeFileSync(t.state, '2');
        t.run();
        assert.equal(existsSync(t.state), false);
        assert.doesNotMatch(t.log(), /restart/);
        t.cleanup();
    });
    it('treats an unreadable count as no failures', () => {
        const t = setup();
        writeFileSync(t.state, 'garbage');
        t.run();
        assert.equal(readFileSync(t.state, 'utf8').trim(), '1');
        assert.doesNotMatch(t.log(), /restart/);
        t.cleanup();
    });
    it('leaves a stopped server alone', () => {
        const t = setup({ active: 'inactive' });
        t.run();
        t.run();
        t.run();
        assert.doesNotMatch(t.log(), /restart/);
        assert.doesNotMatch(t.log(), /curl/);
        t.cleanup();
    });
    it('waits while an update, rollback or switch holds the lock', () => {
        const t = setup({ lockHeld: true });
        writeFileSync(t.state, '2');
        t.run();
        t.run();
        t.run();
        assert.doesNotMatch(t.log(), /restart/);
        assert.doesNotMatch(t.log(), /curl/);
        assert.equal(existsSync(t.state), false, 'the operation restarts the server, so the count starts over');
        t.cleanup();
    });
    it('reads the lock from /proc/locks without taking it', () => {
        // Taking the lock, even for a moment, could make an update that starts in
        // that moment refuse to run.
        const t = setup();
        t.run();
        assert.doesNotMatch(t.log(), /flock/);
        assert.match(t.log(), /curl/);
        t.cleanup();
    });
    it('ignores a lock with the same inode number on another filesystem', () => {
        const t = setup({ otherDeviceLock: true });
        t.run();
        t.run();
        t.run();
        assert.match(t.log(), /curl/);
        assert.match(t.log(), /systemctl restart free-sleep/);
        t.cleanup();
    });
    it('falls back to probing the lock where /proc/locks cannot be read', () => {
        const held = setup({ lockHeld: true, procLocks: false });
        held.run();
        held.run();
        held.run();
        assert.match(held.log(), /flock/);
        assert.doesNotMatch(held.log(), /curl|restart/);
        held.cleanup();
        const free = setup({ procLocks: false });
        free.run();
        assert.match(free.log(), /curl/);
        free.cleanup();
    });
    it('gives a server that just started two minutes before counting failures', () => {
        const t = setup({ activeSince: 1000, uptime: 1000 + 119 });
        writeFileSync(t.state, '2');
        t.run();
        t.run();
        t.run();
        assert.doesNotMatch(t.log(), /restart/);
        assert.doesNotMatch(t.log(), /curl/);
        assert.equal(existsSync(t.state), false, 'a fresh start begins a fresh count');
        t.cleanup();
        const settled = setup({ activeSince: 1000, uptime: 1000 + 120 });
        settled.run();
        settled.run();
        settled.run();
        assert.match(settled.log(), /systemctl restart free-sleep/);
        settled.cleanup();
    });
});
describe('free-sleep-health units', () => {
    const read = (name) => readFileSync(path.join(repoRoot, 'scripts/systemd', name), 'utf8');
    it('the service is a no-op on a tree without the script', () => {
        // A rollback to an older release keeps the units but not the script.
        const src = read('free-sleep-health.service');
        assert.match(src, /Type=oneshot/);
        assert.match(src, /\[ -f \/usr\/local\/lib\/nightstand\/live\/scripts\/health_check\.sh \] \|\| exit 0/);
        assert.match(src, /exec \/bin\/bash \/usr\/local\/lib\/nightstand\/live\/scripts\/health_check\.sh/);
    });
    it('the timer runs every minute and starts well after boot', () => {
        const src = read('free-sleep-health.timer');
        assert.match(src, /OnBootSec=5min/);
        assert.match(src, /OnUnitActiveSec=1min/);
        assert.match(src, /WantedBy=timers\.target/);
    });
});
//# sourceMappingURL=healthCheckScript.test.js.map