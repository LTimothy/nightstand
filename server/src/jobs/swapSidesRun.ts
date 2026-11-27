import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import type { Settings } from '../db/settingsSchema.js';
import { SCHEDULE_SIDES } from '../db/scheduleKeys.js';
import type { Side } from '../db/schedulesSchema.js';
import { swapSides } from '../db/swapSides.js';
import { sideSwaps } from '../db/sideSwaps.js';
import { bedInUseReasons, type InUseReason } from './bedInUse.js';
import { holdOperations } from './privilegedCommand.js';
import { holdJobRebuilds } from './rebuildState.js';
import { resumeSchedule } from './resumeSchedule.js';

export class SwapRefused extends Error {}

const defaults = {
  inUse: (): Promise<InUseReason[]> => bedInUseReasons(),
  settings: async (): Promise<Settings> => { await settingsDB.read(); return settingsDB.data; },
  holdOperations: <T>(work: () => Promise<T>) => holdOperations(work),
  holdJobRebuilds: <T>(work: () => Promise<T>) => holdJobRebuilds(work),
  swap: () => swapSides(),
  resume: (side: Side) => resumeSchedule(side),
  lastSwap: (): number | undefined => sideSwaps().at(-1),
  now: () => Math.floor(Date.now() / 1000),
};

// Sends nothing to the hardware itself; afterwards each side resumes its schedule, which can turn a side on.
export async function runSideSwap(deps = defaults): Promise<void> {
  await deps.holdOperations(async () => {
    // A retry after an answer was lost would swap the sides back.
    if (deps.now() - (deps.lastSwap() ?? 0) < 60) throw new SwapRefused('The sides were swapped a moment ago.');
    const reasons = await deps.inUse();
    if (reasons.includes('status-unknown')) throw new SwapRefused("Nightstand cannot read the bed's state right now. Try again in a moment.");
    if (reasons.some(reason => reason !== 'alarm-soon')) throw new SwapRefused('Turn both sides off first.');
    if (reasons.includes('alarm-soon')) throw new SwapRefused('An alarm is due in the next 15 minutes. Try again after it.');
    const settings = await deps.settings();
    // A pause is held on its physical side, so it would not move with the person.
    if (SCHEDULE_SIDES.some(side => settings[side].scheduleOverrides.pause.active)) throw new SwapRefused('End the pause on both sides first.');
    await deps.holdJobRebuilds(() => deps.swap());
  });
  // Not awaited: a resume can wait on the hardware longer than the app waits for an answer.
  for (const side of SCHEDULE_SIDES) {
    deps.resume(side).catch((error: unknown) => {
      logger.warn(`Could not resume the ${side} schedule after a side swap: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
