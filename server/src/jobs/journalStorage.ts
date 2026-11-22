import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import logger from '../logger.js';
import { runPrivilegedCommand } from './privilegedCommand.js';

export const JOURNAL_DROPIN = '/etc/systemd/journald.conf.d/10-nightstand-memory.conf';
export const JOURNAL_DIR = '/var/log/journal';
const RETRY_MS = 60 * 60 * 1000;

// The unit name only satisfies runPrivilegedCommand's unit check; journald is not restarted.
// Literal commands, so setupServicesScript.test.ts can match them to the sudo rules.
const runScript = async (inMemory: boolean) => {
  if (config.remoteDevMode) return;
  await (inMemory
    ? runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/journal_storage.sh', 'memory'], 'systemd-journald.service')
    : runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/journal_storage.sh', 'disk'], 'systemd-journald.service'));
};

// Never fails the caller. The change applies at the next restart of the Pod.
export async function syncJournalStorage(inMemory: boolean, dropin = JOURNAL_DROPIN, run = runScript) {
  if (existsSync(dropin) === inMemory) return;
  try {
    await run(inMemory);
  } catch (error) {
    logger.warn(`Could not ${inMemory ? 'move the system log to memory' : 'keep the system log on flash'}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}

const runTidy = async () => {
  if (config.remoteDevMode) return;
  await runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/journal_storage.sh', 'tidy'], 'systemd-journald.service');
};

// Journal files sit one machine-id folder down; the folder may be the stock link to /persistent/journal.
export function hasOldJournalFiles(dir = JOURNAL_DIR): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .some(entry => readdirSync(path.join(dir, entry.name)).some(name => /\.journal~?$/.test(name)));
  } catch {
    return false;
  }
}

// The script itself waits until journald writes to memory and the files have gone quiet.
export async function tidyJournal(inMemory: boolean, dropin = JOURNAL_DROPIN, tidy = runTidy, left = hasOldJournalFiles) {
  if (!inMemory || !existsSync(dropin) || !left()) return;
  try {
    await tidy();
  } catch (error) {
    logger.warn(`Could not remove old system log files: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let retry: NodeJS.Timeout | null = null;

// At startup, then hourly: an install or update writes the sudo rule and the
// script copy only after the server starts, so the first try can be refused.
export function startJournalTidy(inMemory: () => boolean) {
  if (retry) return;
  void tidyJournal(inMemory());
  retry = setInterval(() => { void tidyJournal(inMemory()); }, RETRY_MS);
  retry.unref?.();
}
