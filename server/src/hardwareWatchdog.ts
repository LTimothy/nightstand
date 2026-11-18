import { readFileSync } from 'node:fs';
import { StatusInfo } from './routes/serverStatus/serverStatusSchema.js';

// Written by scripts/setup_watchdog.sh. Read only, so the row never runs anything as root.
const DROPIN = process.env.NIGHTSTAND_WATCHDOG_DROPIN || '/etc/systemd/system.conf.d/10-nightstand-watchdog.conf';
const TRIAL_MARK = process.env.NIGHTSTAND_WATCHDOG_TRIAL_MARK || '/persistent/free-sleep-data/watchdog-trial';
const OWNER_NOTE = 'turned off by the owner with --remove';

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export const readWatchdogDropin = () => read(DROPIN);
export const readWatchdogMark = () => read(TRIAL_MARK)?.split('\n')[0];

export function hardwareWatchdogStatus(dropin: string | undefined, mark: string | undefined): Pick<StatusInfo, 'status' | 'message'> {
  if (dropin !== undefined && /^RuntimeWatchdogSec=30s$/m.test(dropin)) {
    return { status: 'healthy', message: 'Hardware watchdog on (30 s).' };
  }
  if (mark === OWNER_NOTE) return { status: 'healthy', message: 'Hardware watchdog turned off by hand.' };
  if (mark !== undefined) {
    return { status: 'healthy', message: 'Hardware watchdog off: its first try did not finish.' };
  }
  return { status: 'healthy', message: 'Hardware watchdog off on this Pod.' };
}
