import { execFile } from 'child_process';

export class PrivilegedCommandError extends Error {}
export class OperationCheckError extends PrivilegedCommandError {}
// A refusal because another operation or a reboot is under way, not a failure.
export class OperationBusyError extends PrivilegedCommandError {}
export const privilegedErrorStatus = (error: unknown) => (error instanceof OperationBusyError ? 409 : 500);

function execute(file: string, args: readonly string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const OPERATION_UNITS = ['free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service'];
const OPERATION_RUNNING = 'An update, rollback or switch is already running. Wait for it to finish.';
const POD_RESTARTING = 'The Pod is restarting. Wait for it to come back.';
let operationStarting = false;

// Set when a reboot is issued so no operation starts while the Pod goes
// down. It lapses if the Pod is still up long after, so a reboot that never
// happened cannot block updates for good.
const REBOOT_LATCH_MS = 5 * 60_000;
let rebootIssuedAt: number | undefined;
export const rebootPending = () => rebootIssuedAt !== undefined && Date.now() - rebootIssuedAt < REBOOT_LATCH_MS;

export type StartHooks = {
  beforeStart?: () => Promise<void>;
  onStartFailure?: () => Promise<void>;
};

async function assertOperationUnitsIdle() {
  for (const unit of OPERATION_UNITS) {
    let state: string;
    try {
      state = (await execute('/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'])).trim();
    } catch {
      throw new OperationCheckError('Cannot check running operations. Check the service logs before trying again.');
    }
    if (!['inactive', 'failed'].includes(state)) {
      throw new OperationBusyError(OPERATION_RUNNING);
    }
  }
}

export async function assertOperationsIdle() {
  if (operationStarting) {
    throw new OperationBusyError(OPERATION_RUNNING);
  }
  await assertOperationUnitsIdle();
  // An operation can enter admission while the systemd checks are in flight.
  if (operationStarting) {
    throw new OperationBusyError(OPERATION_RUNNING);
  }
}

// Admits a reboot only when no operation is starting or running, and holds
// the reboot latch from the first check so an operation or a second reboot
// cannot slip in while the systemd checks run.
export async function admitReboot() {
  if (rebootPending()) throw new OperationBusyError(POD_RESTARTING);
  if (operationStarting) throw new OperationBusyError(OPERATION_RUNNING);
  const issuedAt = Date.now();
  rebootIssuedAt = issuedAt;
  try {
    await assertOperationUnitsIdle();
  } catch (error) {
    if (rebootIssuedAt === issuedAt) rebootIssuedAt = undefined;
    throw error;
  }
}

export function releaseRebootLatch() {
  rebootIssuedAt = undefined;
}

type CommandOptions = StartHooks & { timeout?: number; action?: string };

async function startCommand(command: readonly string[], unit: string, operation: boolean, hooks: CommandOptions) {
  try {
    const state = await execute('/bin/systemctl', ['show', unit, '--property=LoadState', '--value']);
    if (state.trim() !== 'loaded') throw new Error(`Unit is ${state.trim()}`);
    await execute('sudo', ['-n', '-l', '--', ...command]);
  } catch {
    throw new PrivilegedCommandError(`Cannot run ${unit}: its service or sudo permission is missing. `
      + 'A successful update repairs these rules and services.');
  }
  if (operation) await assertOperationUnitsIdle();
  try {
    await hooks.beforeStart?.();
    await execute('sudo', ['-n', '--', ...command], hooks.timeout);
  } catch {
    await hooks.onStartFailure?.();
    throw new PrivilegedCommandError(`Unable to ${hooks.action ?? 'start'} ${unit}. Check the service logs and try again.`);
  }
}

// A queued systemd start is fast, but its exit status still matters. Check
// both the unit and the exact sudo grant before reporting acceptance.
export async function runPrivilegedCommand(command: readonly string[], unit: string, hooks: CommandOptions = {}): Promise<void> {
  const operation = OPERATION_UNITS.includes(unit);
  if (operation && rebootPending()) {
    throw new OperationBusyError(POD_RESTARTING);
  }
  if (operation && operationStarting) {
    throw new OperationBusyError(OPERATION_RUNNING);
  }
  if (operation) operationStarting = true;
  try {
    await startCommand(command, unit, operation, hooks);
  } finally {
    if (operation) operationStarting = false;
  }
}
