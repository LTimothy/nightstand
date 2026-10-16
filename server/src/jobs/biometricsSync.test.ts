import assert from 'node:assert/strict';
import { after, beforeEach, it, mock } from 'node:test';
import fs, { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Request, Response } from 'express';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-biometrics-sync-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.NIGHTSTAND_OPERATION_LOCK = path.join(folder, 'operation.lock');
const marker = path.join(folder, 'update-swap.json');
process.env.NIGHTSTAND_SWAP_MARKER = marker;
let activeState = 'active';
let unitFileState = 'disabled';
let operationRunning = false;
let denied = false;
let onMarkerCheck: (() => void) | undefined;
let onLockAcquired: (() => void) | undefined;
let lockSpawns = 0;
const starts: string[][] = [];
const commands: string[][] = [];
mock.module('node:fs', { defaultExport: { ...fs }, namedExports: {
  ...fs,
  existsSync: (file: Parameters<typeof existsSync>[0]) => {
    if (file === marker) onMarkerCheck?.();
    return existsSync(file);
  },
} });
const probeLock = () => spawnSync('python3', ['-c',
  'import fcntl, sys; fcntl.flock(open(sys.argv[1], "r"), fcntl.LOCK_EX | fcntl.LOCK_NB)',
  process.env.NIGHTSTAND_OPERATION_LOCK as string]);
mock.module('child_process', { namedExports: {
  spawn: (...args: Parameters<typeof spawn>) => {
    lockSpawns++;
    const holder = spawn(...args);
    holder.stdout?.once('data', () => onLockAcquired?.());
    return holder;
  },
  execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    commands.push([command, ...args]);
    if (command === '/bin/systemctl') {
      if (args.includes('--property=ActiveState,UnitFileState')) {
        callback(null, `ActiveState=${activeState}\nUnitFileState=${unitFileState}\n`);
      } else if (args.includes('--property=ActiveState')) {
        callback(null, operationRunning ? 'active' : 'inactive');
      } else callback(null, 'loaded');
    } else if (denied) callback(new Error('denied'), '');
    else {
      if (!args.includes('-l')) {
        starts.push(args);
        const turnOn = args.includes('/bin/systemctl');
        activeState = turnOn ? 'active' : 'inactive';
        unitFileState = turnOn ? 'enabled' : 'disabled';
      }
      callback(null, '');
    }
  },
} });
const { default: config } = await import('../config.js');
const { default: services } = await import('../db/services.js');
const { default: logger } = await import('../logger.js');
const { syncBiometrics } = await import('./biometricsSync.js');
const { default: router } = await import('../routes/services/services.js');
const handler = router.stack.find(layer => layer.route?.path === '/services' && layer.route.stack[0].method === 'post')
  ?.route?.stack[0].handle;
assert.ok(handler);

async function postStatus() {
  assert.ok(handler);
  let status = 0;
  let saved: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(data: unknown) { saved = data; return this; },
  };
  await handler({ body: { biometrics: { jobs: { stream: { status: 'healthy' } } } } } as Request, response as Response, () => {});
  return { status, saved };
}

beforeEach(async () => {
  config.remoteDevMode = false;
  activeState = 'active';
  unitFileState = 'disabled';
  operationRunning = false;
  denied = false;
  onMarkerCheck = undefined;
  onLockAcquired = undefined;
  lockSpawns = 0;
  starts.length = 0;
  commands.length = 0;
  rmSync(marker, { force: true });
  writeFileSync(process.env.NIGHTSTAND_OPERATION_LOCK as string, '');
  services.data.biometrics.enabled = true;
  await services.write();
});
after(() => rmSync(folder, { recursive: true, force: true }));

it('restores autostart from the persisted on switch at startup', async () => {
  services.data.biometrics.enabled = false;
  await syncBiometrics();
  assert.equal(unitFileState, 'enabled', 'the saved file must win over stale memory');
  assert.equal(activeState, 'active');
});

it('keeps the empty reset database off', async () => {
  activeState = 'inactive';
  services.data.biometrics.enabled = false;
  await services.write();
  await syncBiometrics();
  assert.deepEqual(starts, []);
  assert.equal(unitFileState, 'disabled');
});

it('stops and disables the stream when persisted data turns biometrics off', async () => {
  services.data.biometrics.enabled = false;
  await services.write();
  unitFileState = 'enabled';
  await syncBiometrics();
  assert.equal(activeState, 'inactive');
  assert.equal(unitFileState, 'disabled');
  assert.deepEqual(starts, [['-n', '--', '/bin/sh', '/usr/local/lib/nightstand/live/scripts/disable_biometrics.sh']]);
});

it('does not touch systemd in local development', async () => {
  config.remoteDevMode = true;
  await syncBiometrics();
  assert.deepEqual(starts, []);
});

it('reconciles a job status write while the saved biometrics switch is on', async () => {
  const { status, saved } = await postStatus();
  assert.equal(status, 200);
  assert.ok(saved);
  assert.equal(services.data.biometrics.jobs.stream.status, 'healthy');
  assert.equal(unitFileState, 'enabled');
});

it('retries startup reconciliation after the updater exits', async t => {
  let retry: (() => Promise<void>) | undefined;
  const timer = t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>) => {
    retry = callback;
    return { unref() {} } as NodeJS.Timeout;
  });
  operationRunning = true;
  await syncBiometrics();
  await syncBiometrics();
  assert.deepEqual(starts, []);
  assert.equal(timer.mock.calls.length, 1, 'only one retry should be pending');
  assert.ok(retry);
  operationRunning = false;
  await retry();
  assert.equal(unitFileState, 'enabled');
});

it('leaves recovery the lock and retries after the swap marker is removed', async t => {
  let retry: (() => Promise<void>) | undefined;
  const timer = t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>, delay: number) => {
    assert.equal(delay, 1_000);
    retry = callback;
    return { unref() {} } as NodeJS.Timeout;
  });
  writeFileSync(marker, '{}');
  let markerChecks = 0;
  onMarkerCheck = () => {
    markerChecks++;
    assert.equal(probeLock().status, 0, 'recovery can acquire the lock during the marker check');
  };
  await syncBiometrics();
  assert.deepEqual(commands, []);
  assert.equal(timer.mock.calls.length, 1);
  assert.ok(retry);
  assert.equal(markerChecks, 1, 'the lock probe ran during reconciliation');
  await retry();
  assert.deepEqual(commands, []);
  assert.equal(timer.mock.calls.length, 2);
  onMarkerCheck = undefined;
  rmSync(marker);
  await retry();
  assert.equal(activeState, 'active');
  assert.equal(unitFileState, 'enabled');
});

it('never starts a lock holder when the swap marker is present', async t => {
  let retry: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>) => {
    retry = callback;
    return { unref() {} } as NodeJS.Timeout;
  });
  writeFileSync(marker, '{}');
  await syncBiometrics();
  assert.equal(lockSpawns, 0);
  assert.deepEqual(commands, []);
  assert.ok(retry);
  rmSync(marker);
  await retry();
  assert.equal(lockSpawns, 1);
  assert.equal(unitFileState, 'enabled');
});

it('rechecks a swap marker created during lock admission', async t => {
  let retry: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>) => {
    retry = callback;
    return { unref() {} } as NodeJS.Timeout;
  });
  onLockAcquired = () => writeFileSync(marker, '{}');
  await syncBiometrics();
  assert.equal(lockSpawns, 1);
  assert.deepEqual(commands, []);
  assert.ok(retry);
  assert.equal(probeLock().status, 0);
  onLockAcquired = undefined;
  rmSync(marker);
  await retry();
  assert.equal(unitFileState, 'enabled');
});

it('retries reconciliation after a CLI operation releases the shared lock', async t => {
  let retry: (() => Promise<void>) | undefined;
  const timer = t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>) => {
    retry = callback;
    return { unref() {} } as NodeJS.Timeout;
  });
  const holder = spawn('python3', ['-c',
    'import fcntl, sys; handle=open(sys.argv[1], "a+"); fcntl.flock(handle, fcntl.LOCK_EX);'
    + ' print("ready", flush=True); sys.stdin.read()', process.env.NIGHTSTAND_OPERATION_LOCK as string]);
  const closed = new Promise<void>(resolve => holder.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', () => reject(new Error('lock holder exited')));
      holder.stdout.once('data', () => resolve());
    });
    await syncBiometrics();
    await syncBiometrics();
    assert.deepEqual(starts, []);
    assert.equal(timer.mock.calls.length, 1);
    assert.ok(retry);
    holder.stdin.end();
    await closed;
    await retry();
    assert.equal(activeState, 'active');
    assert.equal(unitFileState, 'enabled');
  } finally {
    holder.stdin.end();
    await closed;
  }
});

it('logs a failed repair without failing a status write', async t => {
  denied = true;
  const errors: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => { errors.push(args); return logger; });
  const { status } = await postStatus();
  assert.equal(status, 200);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /sudo permission is missing/);
  assert.deepEqual(starts, []);
});

it('skips a missing operation lock, warns once and retries on the next trigger', async t => {
  const lock = process.env.NIGHTSTAND_OPERATION_LOCK as string;
  rmSync(lock);
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  t.mock.method(logger, 'warn', (...args: unknown[]) => { warnings.push(args); return logger; });
  t.mock.method(logger, 'error', (...args: unknown[]) => { errors.push(args); return logger; });
  const timer = t.mock.method(globalThis, 'setTimeout');
  await syncBiometrics();
  const { status } = await postStatus();
  assert.equal(status, 200);
  assert.deepEqual(starts, []);
  assert.equal(existsSync(lock), false, 'the server must never create the lock');
  assert.equal(warnings.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(timer.mock.calls.length, 0, 'a missing file waits for the next trigger');
  writeFileSync(lock, '');
  await syncBiometrics();
  assert.equal(unitFileState, 'enabled');
});
