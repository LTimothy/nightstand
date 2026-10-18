import type { Side } from '../db/schedulesSchema.js';
import { connectFrankenWithin } from '../8sleep/frankenServer.js';
import { MAX_ON_DURATION_SECONDS } from '../routes/deviceStatus/deviceStatusSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { getPresenceData } from '../routes/metrics/presence.js';
import { PRESENCE_STALE_MS } from '../8sleep/presenceStale.js';
import { smartOffExtendedUntil } from './rhythms/curveController.js';

// A pause with an end keeps a side that is on running until that end, since
// it skips the power-off that would end it. When the pause ends the side gets
// back the off time it had before. Memory only.
type Hold = { before: number; until: number };
const holds = new Map<Side, Hold>();

// A timer this far from the one the pause set was changed by someone else.
const SAME_TIMER_MS = 10 * 60 * 1000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readSide(side: Side) {
  return (await (await connectFrankenWithin()).getDeviceStatus())[side];
}

// In bed by a fresh presence reading, with the presence auto-off on to turn
// the side off once they are up.
async function inBed(side: Side, now: number): Promise<boolean> {
  await settingsDB.read();
  if (settingsDB.data.features?.presenceAutoOff === false || settingsDB.data[side].awayMode) return false;
  const presence = getPresenceData()[side];
  const updated = presence.lastUpdatedAt ? Date.parse(presence.lastUpdatedAt) : NaN;
  return presence.present && now - updated <= PRESENCE_STALE_MS;
}

export const pauseHoldUntil = (side: Side): number | undefined => holds.get(side)?.until;

export async function holdForPause(side: Side, end: Date): Promise<void> {
  try {
    const status = await readSide(side);
    if (!status.isOn || !Number.isFinite(status.secondsRemaining)) return;
    const now = Date.now();
    const current = now + status.secondsRemaining * 1000;
    const until = Math.min(end.getTime(), now + MAX_ON_DURATION_SECONDS * 1000);
    if (until <= current) return;
    await updateDeviceStatus({ [side]: { isOn: true } }, { onUntil: new Date(until) });
    // An earlier hold's off time stands only while its timer is still the one in place.
    const earlier = holds.get(side);
    const kept = earlier && Math.abs(current - earlier.until) <= SAME_TIMER_MS;
    holds.set(side, { before: kept ? earlier.before : current, until });
    logger.info(`Schedule pause keeps ${side} on until ${new Date(until).toISOString()}`);
  } catch (error: unknown) {
    logger.warn(`Could not keep ${side} on for its schedule pause: ${message(error)}`);
  }
}

// Runs before the resume, which only turns on a side that is off.
export async function endPauseHold(side: Side): Promise<void> {
  const hold = holds.get(side);
  if (!hold) return;
  holds.delete(side);
  try {
    const status = await readSide(side);
    const now = Date.now();
    const timerEnd = now + status.secondsRemaining * 1000;
    if (!status.isOn || !Number.isFinite(timerEnd) || Math.abs(timerEnd - Math.max(hold.until, now)) > SAME_TIMER_MS) return;
    // A sleep kept on until up goes back to its steps, which presence ends.
    const back = hold.before > now ? hold.before : Math.min(hold.until, smartOffExtendedUntil(side)?.getTime() ?? 0);
    if (back > now) {
      await updateDeviceStatus({ [side]: { isOn: true } }, { onUntil: new Date(back) });
      logger.info(`Schedule pause for ${side} ended, it turns off at ${new Date(back).toISOString()} again`);
    } else if (await inBed(side, now)) {
      logger.info(`Schedule pause for ${side} ended after its planned off while in bed, it turns off once they are up`);
    } else {
      await updateDeviceStatus({ [side]: { isOn: false } });
      logger.info(`Schedule pause for ${side} ended after its planned off, turning it off`);
    }
  } catch (error: unknown) {
    logger.warn(`Could not give ${side} back its off time after the schedule pause: ${message(error)}`);
  }
}
