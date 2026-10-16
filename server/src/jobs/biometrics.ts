import { execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { assertOperationsIdle, OperationBusyError, runPrivilegedCommand } from './privilegedCommand.js';
import { withOperationLock } from './operationLock.js';

// Pulled out so the "when do we stop the stream" decision is unit-testable
// without spawning a real process. `deepPartial()`-parsed POST /services
// bodies only carry `biometrics.enabled` when the caller is actually
// changing it, so an explicit `=== false` (not just falsy/absent) is the
// signal that the toggle was flipped off.
export function shouldDisableBiometrics(body: { biometrics?: { enabled?: boolean } }): boolean {
  return body.biometrics?.enabled === false;
}

export function shouldEnableBiometrics(body: { biometrics?: { enabled?: boolean } }): boolean {
  return body.biometrics?.enabled === true;
}

// Every on and off request runs after the one before it, with its save, so
// quick toggles end in the state of the last request and the saved switch
// always matches the stream. Requests are not merged: disable_biometrics.sh
// and enable --now are both safe to repeat. None runs while an update,
// rollback or switch is under way, since those stop the stream to move the
// code it runs from.
let last: Promise<unknown> = Promise.resolve();
function inOrder<T>(command: () => Promise<void>, save?: () => Promise<T>): Promise<T | undefined> {
  const run = last.then(async () => {
    await command();
    return save?.();
  });
  last = run.catch(() => {});
  return run;
}

// True only when systemd says the stream unit does not exist. Any doubt
// leaves the decision to the privileged command's own checks.
function streamUnitMissing() {
  return new Promise<boolean>((resolve) => {
    execFile('/bin/systemctl', ['show', 'free-sleep-stream.service', '--property=LoadState', '--value'],
      { encoding: 'utf8', timeout: 30_000 }, (error, stdout) => resolve(!error && stdout.trim() === 'not-found'));
  });
}

// A missing stream unit needs no stop command.
async function disableStream() {
  if (await streamUnitMissing()) return;
  await runPrivilegedCommand([
    '/bin/sh', '/usr/local/lib/nightstand/live/scripts/disable_biometrics.sh',
  ], 'free-sleep-stream.service', {
    // systemd may take 90 seconds to stop the streamer.
    timeout: 120_000,
    action: 'stop and disable',
  });
}

export function triggerBiometricsDisable<T>(save?: () => Promise<T>) {
  return inOrder(async () => {
    await assertOperationsIdle();
    await disableStream();
  }, save);
}

// The one command the sudo rule allows. It never runs enable_biometrics.sh,
// which installs packages with the firewall open and posts back to this route.
function enableStream() {
  return runPrivilegedCommand(['/bin/systemctl', 'enable', '--now', 'free-sleep-stream.service'], 'free-sleep-stream.service');
}

export function triggerBiometricsEnable<T>(save?: () => Promise<T>) {
  return inOrder(async () => {
    await assertOperationsIdle();
    await enableStream();
  }, save);
}

function assertRecoveryIdle() {
  if (existsSync(process.env.NIGHTSTAND_SWAP_MARKER || '/persistent/free-sleep-data/update-swap.json')) {
    throw new OperationBusyError('Update recovery is pending. Biometrics reconciliation will retry.');
  }
}

// Read the saved switch in the toggle queue, so a pending disable wins over a stale on value.
export function reconcileBiometrics(readEnabled: () => Promise<boolean>) {
  return inOrder(async () => {
    assertRecoveryIdle();
    await withOperationLock(async () => {
      assertRecoveryIdle();
      await assertOperationsIdle();
      const enabled = await readEnabled();
      const state = await new Promise<string>((resolve, reject) => {
        execFile('/bin/systemctl', ['show', 'free-sleep-stream.service', '--property=ActiveState,UnitFileState'],
          { encoding: 'utf8', timeout: 30_000 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
      });
      const properties = state.trim().split(/\r?\n/);
      if (enabled) {
        if (properties.includes('ActiveState=active') && properties.includes('UnitFileState=enabled')) return;
        await enableStream();
      } else if ((!properties.includes('ActiveState=inactive') && !properties.includes('ActiveState=failed'))
        || !properties.includes('UnitFileState=disabled')) {
        await disableStream();
      }
    });
  });
}
