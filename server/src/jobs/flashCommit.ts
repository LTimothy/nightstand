import { readFileSync } from 'node:fs';
import config from '../config.js';
import logger from '../logger.js';
import { runPrivilegedCommand } from './privilegedCommand.js';

const LONG_COMMIT_SECONDS = 60;

// The commit interval of /persistent from /proc/mounts: ext4's 5 s unless commit= says otherwise.
export function commitSeconds(procMounts: string, mountPoint = '/persistent'): number | null {
  const line = procMounts.split('\n').map(row => row.split(' ')).find(fields => fields[1] === mountPoint && fields[2] === 'ext4');
  if (!line) return null;
  const option = line[3]?.split(',').find(item => item.startsWith('commit='));
  return option ? Number(option.slice('commit='.length)) : 5;
}

// The unit name only satisfies runPrivilegedCommand's unit check; nothing restarts.
// Literal commands, so setupServicesScript.test.ts can match them to the sudo rules.
const runScript = async (long: boolean) => {
  if (config.remoteDevMode) return;
  await (long
    ? runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/flash_commit.sh', 'long'], 'persistent.mount')
    : runPrivilegedCommand(['/bin/bash', '/usr/local/lib/nightstand/live/scripts/flash_commit.sh', 'default'], 'persistent.mount'));
};

const readMounts = () => readFileSync('/proc/mounts', 'utf8');

// Never fails the caller. Applies at once; a restart of the Pod goes back to 5 s until the server starts.
export async function syncFlashCommit(long: boolean, mounts: () => string = readMounts, run = runScript) {
  let current: number | null;
  try {
    current = commitSeconds(mounts());
  } catch {
    return;
  }
  if (current === null || (current === LONG_COMMIT_SECONDS) === long) return;
  try {
    await run(long);
  } catch (error) {
    logger.warn(`Could not ${long ? 'lengthen' : 'restore'} the flash commit interval: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}
