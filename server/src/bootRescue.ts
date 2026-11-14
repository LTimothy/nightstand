import { readFileSync } from 'node:fs';
import { StatusInfo } from './routes/serverStatus/serverStatusSchema.js';

// Written by root's health check once per boot from fw_printenv.
const BOOT_SETTINGS = process.env.NIGHTSTAND_BOOT_SETTINGS || '/run/nightstand-boot-settings.json';

type BootSettings = { bootdelay?: unknown; currentSlot?: unknown; nextSlot?: unknown };

export function readBootSettings(file = BOOT_SETTINGS): BootSettings | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data as BootSettings : undefined;
  } catch {
    return undefined;
  }
}

export function bootRescueStatus(settings: BootSettings | undefined): Pick<StatusInfo, 'status' | 'message'> {
  const { bootdelay, currentSlot, nextSlot } = settings ?? {};
  const delay = typeof bootdelay === 'string' && /^-?\d+$/.test(bootdelay) ? bootdelay : undefined;
  const messages: string[] = [];
  // -1 waits at the prompt for good; only -2 and below skip it.
  if (delay !== undefined && Number(delay) <= -2) {
    messages.push(`Startup no longer pauses for serial access (bootdelay ${delay}), so serial rescue will not work. `
      + 'Set it back with fw_setenv bootdelay 2 over SSH. This row updates after the next restart.');
  }
  if (typeof currentSlot === 'string' && typeof nextSlot === 'string' && currentSlot !== nextSlot) {
    messages.push('The next restart will start from the other system slot. A stock update may be waiting; check before restarting.');
  }
  if (messages.length) return { status: 'failed', message: messages.join(' ') };
  if (delay !== undefined) {
    return { status: 'healthy', message: `Startup pauses for serial access (bootdelay ${delay}).` };
  }
  return { status: 'not_started', message: settings ? 'Boot settings could not be read.' : 'Boot settings not read yet.' };
}
