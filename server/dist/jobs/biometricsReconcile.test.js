import assert from 'node:assert/strict';
import { after, beforeEach, it, mock } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const folder = mkdtempSync(path.join(tmpdir(), 'biometrics-reconcile-'));
const lock = path.join(folder, 'operation.lock');
const marker = path.join(folder, 'update-swap.json');
process.env.NIGHTSTAND_OPERATION_LOCK = lock;
process.env.NIGHTSTAND_SWAP_MARKER = marker;
after(() => rmSync(folder, { recursive: true, force: true }));
const probe = () => spawnSync('python3', ['-c',
    'import fcntl, sys; fcntl.flock(open(sys.argv[1], "r"), fcntl.LOCK_EX | fcntl.LOCK_NB)', lock]);
const calls = [];
let enabled = true;
let activeState = 'active';
let unitFileState = 'disabled';
let operationRunning = false;
let denied = false;
let checkLock = false;
mock.module('child_process', { namedExports: {
        spawn,
        execFile: (command, args, _options, callback) => {
            calls.push([command, ...args]);
            if (checkLock)
                assert.notEqual(probe().status, 0, 'a CLI operation cannot enter during systemd checks or commands');
            if (command === '/bin/systemctl') {
                if (args.includes('--property=ActiveState,UnitFileState')) {
                    callback(null, `ActiveState=${activeState}\nUnitFileState=${unitFileState}\n`);
                }
                else if (args.includes('--property=ActiveState')) {
                    callback(null, operationRunning ? 'active' : 'inactive');
                }
                else
                    callback(null, 'loaded');
            }
            else if (denied)
                callback(new Error('denied'), '');
            else {
                if (!args.includes('-l')) {
                    const turnOn = args.includes('/bin/systemctl');
                    activeState = turnOn ? 'active' : 'inactive';
                    unitFileState = turnOn ? 'enabled' : 'disabled';
                }
                callback(null, '');
            }
        },
    } });
const biometrics = await import('./biometrics.js');
const reconcile = () => {
    return biometrics.reconcileBiometrics(async () => enabled);
};
const starts = () => calls.filter(call => call[0] === 'sudo' && !call.includes('-l'));
beforeEach(() => {
    writeFileSync(lock, '');
    rmSync(marker, { force: true });
    calls.length = 0;
    enabled = true;
    activeState = 'active';
    unitFileState = 'disabled';
    operationRunning = false;
    denied = false;
    checkLock = false;
});
it('defers under the lock while a swap marker exists without running systemctl', async () => {
    writeFileSync(marker, '{}');
    let reads = 0;
    await assert.rejects(biometrics.reconcileBiometrics(async () => { reads++; return true; }), /recovery/i);
    assert.equal(reads, 0);
    assert.deepEqual(calls, []);
    assert.equal(probe().status, 0, 'recovery can take the lock immediately');
    rmSync(marker);
    await reconcile();
    assert.equal(unitFileState, 'enabled');
});
for (const [active, autostart] of [['active', 'disabled'], ['inactive', 'enabled'], ['failed', 'disabled'], ['active', 'enabled-runtime']]) {
    it(`repairs a saved on switch with stream ${active} and ${autostart}`, async () => {
        activeState = active;
        unitFileState = autostart;
        await reconcile();
        assert.equal(activeState, 'active');
        assert.equal(unitFileState, 'enabled');
        assert.deepEqual(starts(), [['sudo', '-n', '--', '/bin/systemctl', 'enable', '--now', 'free-sleep-stream.service']]);
    });
}
it('does not run sudo for an enabled, active stream', async () => {
    unitFileState = 'enabled';
    await reconcile();
    assert.deepEqual(starts(), []);
});
it('does nothing when the saved switch is off and the stream is stopped and disabled', async () => {
    enabled = false;
    activeState = 'inactive';
    await reconcile();
    assert.equal(unitFileState, 'disabled');
    assert.deepEqual(starts(), []);
    assert.equal(calls.some(call => call[0] === 'sudo'), false);
});
for (const [active, autostart] of [['active', 'enabled'], ['active', 'disabled'], ['inactive', 'enabled']]) {
    it(`stops and disables a saved off switch with stream ${active} and ${autostart}`, async () => {
        enabled = false;
        activeState = active;
        unitFileState = autostart;
        await reconcile();
        assert.equal(activeState, 'inactive');
        assert.equal(unitFileState, 'disabled');
        assert.deepEqual(starts(), [['sudo', '-n', '--', '/bin/sh', '/usr/local/lib/nightstand/live/scripts/disable_biometrics.sh']]);
    });
}
it('holds the operation lock while reading the switch and issuing the command', async () => {
    // The initial queue guard precedes lock admission.
    await biometrics.reconcileBiometrics(async () => {
        assert.notEqual(probe().status, 0, 'a CLI operation cannot enter during the saved-setting read');
        checkLock = true;
        return true;
    });
    assert.equal(probe().status, 0, 'the lock is released after reconciliation');
});
it('releases the operation lock after a failed command', async () => {
    denied = true;
    await assert.rejects(reconcile(), /sudo permission is missing/);
    assert.equal(probe().status, 0);
});
it('refuses reconciliation before reading settings when a CLI operation holds the lock', async () => {
    const holder = spawn('python3', ['-c',
        'import fcntl, sys; handle=open(sys.argv[1], "a+"); fcntl.flock(handle, fcntl.LOCK_EX);'
            + ' print("ready", flush=True); sys.stdin.read()', lock]);
    const closed = new Promise(resolve => holder.once('close', () => resolve()));
    try {
        await new Promise((resolve, reject) => {
            holder.once('error', reject);
            holder.once('exit', () => reject(new Error('lock holder exited before admission')));
            holder.stdout.once('data', () => resolve());
        });
        let reads = 0;
        await assert.rejects(biometrics.reconcileBiometrics(async () => { reads++; return true; }), /already running/);
        assert.equal(reads, 0);
        assert.deepEqual(starts(), []);
    }
    finally {
        holder.stdin.end();
        await closed;
    }
    await reconcile();
    assert.equal(unitFileState, 'enabled');
});
it('reads the switch in queue order instead of using a stale on value', async () => {
    const off = biometrics.triggerBiometricsDisable(async () => { enabled = false; });
    const sync = reconcile();
    await Promise.all([off, sync]);
    assert.equal(starts().length, 1);
    assert.ok(starts()[0].includes('/usr/local/lib/nightstand/live/scripts/disable_biometrics.sh'));
    assert.equal(activeState, 'inactive');
    assert.equal(unitFileState, 'disabled');
});
it('does not start the stream during an update', async () => {
    operationRunning = true;
    await assert.rejects(reconcile(), /already running/);
    assert.deepEqual(starts(), []);
});
it('reports a missing sudo grant without starting the stream', async () => {
    denied = true;
    await assert.rejects(reconcile(), /sudo permission is missing/);
    assert.deepEqual(starts(), []);
});
it('takes an exclusive lock on a file that is only readable', async () => {
    chmodSync(lock, 0o444);
    try {
        await biometrics.reconcileBiometrics(async () => {
            assert.notEqual(probe().status, 0);
            return true;
        });
        assert.equal(unitFileState, 'enabled');
    }
    finally {
        chmodSync(lock, 0o644);
    }
    assert.equal(probe().status, 0, 'reconciliation releases the read-only lock');
});
//# sourceMappingURL=biometricsReconcile.test.js.map