import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const calls: string[][] = [];
const timeouts: number[] = [];
let loadState = 'loaded';
let denied = false;
let startFailed = false;
let activeUnit = '';
let holdLoadCheck: ((release: () => void) => void) | undefined;
mock.module('child_process', { namedExports: {
  spawn: (_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter();
    Object.assign(child, { unref() {} });
    queueMicrotask(() => child.emit('exit', startFailed ? 1 : 0));
    return child;
  },
  execFile: (command: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
    calls.push([command, ...args]);
    timeouts.push(options.timeout);
    if (command === '/bin/systemctl') {
      if (args.includes('--property=ActiveState')) callback(null, args.includes(activeUnit) ? 'active' : 'inactive');
      else if (holdLoadCheck) holdLoadCheck(() => callback(null, loadState));
      else callback(null, loadState);
    }
    else callback((denied || (startFailed && !args.includes('-l'))) ? new Error('denied') : null, '');
  },
} });
const { assertOperationsIdle, holdOperations, OperationBusyError } = await import('./privilegedCommand.js');
const { triggerUpdateService } = await import('./update.js');
const { triggerRollbackService } = await import('./rollback.js');
const { triggerRevertToStockService } = await import('./revertToStock.js');
const { triggerBiometricsDisable, triggerBiometricsEnable } = await import('./biometrics.js');

const failedStart: Record<string, RegExp> = { biometrics: /Unable to stop and disable/ };
for (const [name, trigger] of [
  ['update', triggerUpdateService], ['rollback', triggerRollbackService],
  ['switch', triggerRevertToStockService], ['biometrics', triggerBiometricsDisable],
  ['biometrics on', triggerBiometricsEnable],
] as const) {
  it(`${name} ${name === 'biometrics' ? 'turns off' : 'rejects'} a missing unit without executing sudo`, async () => {
    calls.length = 0; loadState = 'not-found'; denied = false; startFailed = false;
    // With no stream unit there is nothing to stop, so turning Biometrics
    // off still succeeds; everything else needs its unit.
    if (name === 'biometrics') await trigger();
    else await assert.rejects(async () => trigger(), /successful update.*repair/i);
    assert.equal(calls.some(args => args[0] === 'sudo'), false);
  });
  it(`${name} rejects missing sudo permissions and failed starts`, async () => {
    loadState = 'loaded'; denied = true;
    await assert.rejects(async () => trigger(), /successful update.*repair/i);
    denied = false; startFailed = true;
    await assert.rejects(async () => trigger(), failedStart[name] ?? /Unable to start/);
    startFailed = false;
  });
  it(`${name} checks exact sudo command before awaiting success`, async () => {
    calls.length = 0; loadState = 'loaded'; denied = false; startFailed = false;
    await trigger();
    const check = calls.find(args => args[0] === 'sudo' && args.includes('-l'));
    const start = calls.find(args => args[0] === 'sudo' && !args.includes('-l'));
    assert.ok(check); assert.ok(start);
    assert.deepEqual(check.slice(4), start.slice(3));
  });
}

for (const unit of ['free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service']) {
  it(`refuses update while ${unit} is active`, async () => {
    activeUnit = unit;
    try { await assert.rejects(triggerUpdateService(), /already running/); }
    finally { activeUnit = ''; }
  });
}
it('refuses overlapping local admissions until the first start is acknowledged', async () => {
  let release: (() => void) | undefined;
  holdLoadCheck = resume => { release = resume; holdLoadCheck = undefined; };
  const first = triggerUpdateService();
  try {
    await assert.rejects(triggerRollbackService(), /already running/);
    await assert.rejects(assertOperationsIdle(), /already running/);
  } finally {
    holdLoadCheck = undefined;
    release?.();
    await first;
  }
});

it('keeps admission locked until failed-start target cleanup finishes', async () => {
  startFailed = true;
  let cleanupStarted: (() => void) | undefined;
  const cleanupEntered = new Promise<void>(resolve => { cleanupStarted = resolve; });
  let finishCleanup: (() => void) | undefined;
  const cleanupDone = new Promise<void>(resolve => { finishCleanup = resolve; });
  const first = triggerUpdateService({ onStartFailure: async () => { cleanupStarted?.(); await cleanupDone; } });
  const rejected = assert.rejects(first, /Unable to start/);
  try {
    await cleanupEntered;
    await assert.rejects(triggerRollbackService(), /already running/);
    await assert.rejects(assertOperationsIdle(), /already running/);
  } finally {
    finishCleanup?.();
    await rejected;
    startFailed = false;
  }
});

it('does not run target hooks when another operation is active', async () => {
  activeUnit = 'free-sleep-revert.service';
  let writes = 0;
  let deletes = 0;
  try {
    await assert.rejects(triggerUpdateService({
      beforeStart: async () => { writes++; },
      onStartFailure: async () => { deletes++; },
    }), /already running/);
    assert.equal(writes, 0);
    assert.equal(deletes, 0);
  } finally { activeUnit = ''; }
});

// The Biometrics switch would otherwise start or stop the stream while one
// of these moves the code it runs from.
for (const unit of ['free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service']) {
  it(`does not turn Biometrics on or off while ${unit} is running`, async () => {
    calls.length = 0; loadState = 'loaded'; denied = false; startFailed = false;
    activeUnit = unit;
    try {
      for (const trigger of [triggerBiometricsEnable, triggerBiometricsDisable]) {
        let saved = false;
        await assert.rejects(trigger(async () => { saved = true; }),
          (error: Error) => error instanceof OperationBusyError && /already running/.test(error.message));
        assert.equal(saved, false);
      }
      assert.equal(calls.some(args => args[0] === 'sudo'), false);
    } finally { activeUnit = ''; }
  });
}

it('does not turn Biometrics on while an update is being started', async () => {
  let release: (() => void) | undefined;
  holdLoadCheck = resume => { release = resume; holdLoadCheck = undefined; };
  const update = triggerUpdateService();
  try {
    await assert.rejects(triggerBiometricsEnable(), /already running/);
  } finally {
    holdLoadCheck = undefined;
    release?.();
    await update;
  }
});

it('turns the stream on with the one command its sudo rule allows, not enable_biometrics.sh', async () => {
  calls.length = 0; loadState = 'loaded'; denied = false; startFailed = false;
  await triggerBiometricsEnable();
  const start = calls.find(args => args[0] === 'sudo' && !args.includes('-l'));
  assert.deepEqual(start, ['sudo', '-n', '--', '/bin/systemctl', 'enable', '--now', 'free-sleep-stream.service']);
  assert.ok(!calls.flat().some(arg => arg.includes('enable_biometrics')));
  assert.ok(calls.some(args => args[0] === '/bin/systemctl' && args.includes('free-sleep-stream.service')), 'checks the unit is loaded');
});

it('allows the synchronous biometrics stop longer than the systemd stop deadline', async () => {
  calls.length = 0;
  timeouts.length = 0;
  await triggerBiometricsDisable();
  const stopIndex = calls.findIndex(args => args[0] === 'sudo' && !args.includes('-l'));
  assert.ok(timeouts[stopIndex] > 90_000);
  assert.equal(timeouts[stopIndex], 120_000);
});

it('holds off updates and a second hold while held work runs, after checking no operation is running', async () => {
  loadState = 'loaded'; denied = false; startFailed = false; activeUnit = '';
  let release!: () => void;
  const held = holdOperations(() => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(async () => triggerUpdateService(), OperationBusyError);
  await assert.rejects(async () => holdOperations(async () => {}), OperationBusyError);
  release();
  await held;
  await assert.doesNotReject(async () => assertOperationsIdle());
});

it('does not run held work while an update unit is active', async () => {
  activeUnit = 'free-sleep-update.service';
  let ran = false;
  await assert.rejects(async () => holdOperations(async () => { ran = true; }), OperationBusyError);
  assert.equal(ran, false);
  await assert.doesNotReject(async () => { activeUnit = ''; await holdOperations(async () => {}); });
});
