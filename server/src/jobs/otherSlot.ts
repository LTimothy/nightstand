import config from '../config.js';
import logger from '../logger.js';
import { holdOperations, PrivilegedCommandError, runPrivilegedCommand } from './privilegedCommand.js';

type Action = 'access' | 'undo' | 'status';

// The unit name only satisfies runPrivilegedCommand's unit check; nothing restarts.
// Literal commands, so setupServicesScript.test.ts can match them to the sudo rules.
const runScript = async (action: Action) => {
  if (config.remoteDevMode) return;
  if (action === 'access') {
    await runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/boot_slot.sh', 'other-access'], 'systemd-journald.service');
  } else if (action === 'undo') {
    await runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/boot_slot.sh', 'other-undo'], 'systemd-journald.service');
  } else {
    await runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/boot_slot.sh', 'other-status'], 'systemd-journald.service');
  }
};

// Held so a reboot or update cannot land while the other slot's files are rewritten.
export async function applyOtherSlot(on: boolean, run = runScript, hold = holdOperations) {
  await hold(() => run(on ? 'access' : 'undo'));
}

// Never fails the caller. Off does nothing, so a slot prepared by hand stays prepared.
export async function syncOtherSlot(on: boolean, run = runScript, hold = holdOperations) {
  if (!on) return;
  try {
    await run('status');
    return;
  } catch {
    // Not prepared, or the slot was rewritten: prepare it again.
  }
  try {
    await applyOtherSlot(true, run, hold);
  } catch (error) {
    logger.warn(`Could not prepare the other boot slot: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const checkSupported = () => runPrivilegedCommand(
  ['/bin/bash', '/usr/local/lib/nightstand/live/scripts/boot_slot.sh', 'other-supported'], 'systemd-journald.service');

let supported: boolean | undefined;

// Null when it cannot tell yet: right after an update the sudo rule lands after the server starts.
export async function otherSlotSupported(run: () => Promise<void> = checkSupported): Promise<boolean | null> {
  if (config.remoteDevMode) return null;
  if (supported !== undefined) return supported;
  try {
    await run();
    supported = true;
  } catch (error) {
    if (error instanceof PrivilegedCommandError && error.message.startsWith('Cannot run ')) return null;
    supported = false;
  }
  return supported;
}
