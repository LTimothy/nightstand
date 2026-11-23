import { readFileSync } from 'node:fs';
import { StatusInfo } from './routes/serverStatus/serverStatusSchema.js';

// Written by root's health check from fw_printenv, at most an hour old.
const BOOT_SETTINGS = process.env.NIGHTSTAND_BOOT_SETTINGS || '/run/nightstand-boot-settings.json';

type BootSettings = { bootdelay?: unknown; currentSlot?: unknown; nextSlot?: unknown; currentMarked?: unknown; currentRetries?: unknown };

export function readBootSettings(file = BOOT_SETTINGS): BootSettings | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data as BootSettings : undefined;
  } catch {
    return undefined;
  }
}

export function bootRescueStatus(settings: BootSettings | undefined): Pick<StatusInfo, 'status' | 'message'> {
  const { bootdelay, currentSlot, nextSlot, currentMarked, currentRetries } = settings ?? {};
  const delay = typeof bootdelay === 'string' && /^-?\d+$/.test(bootdelay) ? bootdelay : undefined;
  const messages: string[] = [];
  // -1 waits at the prompt for good; only -2 and below skip it.
  if (delay !== undefined && Number(delay) <= -2) {
    messages.push(`Startup no longer pauses for serial access (bootdelay ${delay}), so serial rescue will not work. `
      + 'See Keeping Eight Sleep updates out in the installation guide.');
  }
  if (typeof currentSlot === 'string' && typeof nextSlot === 'string' && currentSlot !== nextSlot) {
    messages.push(`Boot settings list slot ${currentSlot} now and slot ${nextSlot} next. A stock update may be waiting. `
      + 'Do not restart or unplug the Pod; open an issue on GitHub.');
  }
  const slot = currentSlot === 'a' || currentSlot === 'b' ? currentSlot : undefined;
  // An unmarked slot counts down boots, then the hub starts its other slot, which runs Eight Sleep's own system.
  if (slot && currentMarked === '0') {
    const left = typeof currentRetries === 'string' && /^\d+$/.test(currentRetries) ? `${currentRetries} boots left` : 'boots left unknown';
    messages.push(`Slot ${slot} is not marked good (${left}). When the boots run out the Pod starts Eight Sleep's own system. `
      + 'Updating Nightstand marks it; until then, avoid restarting the Pod.');
  }
  if (messages.length) return { status: 'failed', message: messages.join(' ') };
  if (delay !== undefined) {
    const marked = slot && currentMarked === '1' ? ` Slot ${slot} is marked good.` : '';
    return { status: 'healthy', message: `Serial rescue is available (bootdelay ${delay}).${marked}` };
  }
  return { status: 'not_started', message: settings ? 'Boot settings could not be read.' : 'Boot settings not read yet.' };
}
