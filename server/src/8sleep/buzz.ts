import cbor from 'cbor';
import logger from '../logger.js';
import type { Side } from '../db/schedulesSchema.js';
import { activeAlarms, hasSnooze } from '../jobs/activeAlarms.js';
import { alarmStarting } from '../jobs/alarmScheduler.js';
import { alarmActivityWithin } from '../jobs/alarmActivity.js';
import { isRebuilding, rebuildSettled } from '../jobs/rebuildState.js';
import { executeFunction } from './deviceApi.js';

export const BUZZ_POWER = 50;
const BUZZ_HOLD_MS = 2_000;
const GUARD_WINDOW_MS = 7_000;
// Past this a confirmation means nothing, so a long re-plan skips the buzz.
const REBUILD_WAIT_MS = 5_000;

export class BuzzSkipped extends Error {
  constructor(readonly rebuilding = false) { super(); }
}

const inFlight = new Set<Side>();

export const alarmBusy = (side: Side, untilMs: number): boolean =>
  activeAlarms.has(side) || hasSnooze(side) || alarmStarting(side) || alarmActivityWithin(side, new Date(untilMs));

// A 1 s pulse that never replaces an alarm; false when skipped or failed.
export async function buzz(side: Side): Promise<boolean> {
  if (inFlight.has(side)) return false;
  inFlight.add(side);
  const send = () => executeFunction(side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT',
    cbor.encode({ pl: BUZZ_POWER, du: 1, pi: 'double', tt: Math.floor(Date.now() / 1_000) }).toString('hex'),
    { beforeSend: () => { if (alarmBusy(side, Date.now() + GUARD_WINDOW_MS)) throw new BuzzSkipped(isRebuilding()); } });
  try {
    try {
      await send();
    } catch (error) {
      // A press can itself start a re-plan (a manual change written to settings); wait it out and check again.
      if (!(error instanceof BuzzSkipped && error.rebuilding)) throw error;
      const timeout = new Promise<'late'>(resolve => setTimeout(() => resolve('late'), REBUILD_WAIT_MS).unref());
      if (await Promise.race([rebuildSettled(), timeout]) === 'late') throw new BuzzSkipped();
      await send();
    }
    return true;
  } catch (error) {
    if (!(error instanceof BuzzSkipped)) logger.warn(`Buzz on the ${side} side failed: ${error}`);
    return false;
  } finally {
    // Held a little past the send so quick taps cannot stack pulses.
    setTimeout(() => inFlight.delete(side), BUZZ_HOLD_MS).unref();
  }
}

// Test isolation only: forget the held sides.
export function resetBuzz() {
  inFlight.clear();
}
