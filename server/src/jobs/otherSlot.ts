import config from '../config.js';
import logger from '../logger.js';
import { holdOperations, runPrivilegedCommand } from './privilegedCommand.js';

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
