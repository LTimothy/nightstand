import settingsDB from '../db/settings.js';
import type { Settings } from '../db/settingsSchema.js';
import { SCHEDULE_SIDES } from '../db/scheduleKeys.js';
import type { Side } from '../db/schedulesSchema.js';
import { swapSides } from '../db/swapSides.js';
import { bedInUseReasons, type InUseReason } from './bedInUse.js';
import { holdOperations } from './privilegedCommand.js';
import { holdJobRebuilds } from './rebuildState.js';
import { resumeSchedule } from './resumeSchedule.js';
import { isSchedulePaused } from './schedulePause.js';

export class SwapRefused extends Error {}

const defaults = {
  inUse: (): Promise<InUseReason[]> => bedInUseReasons(),
  settings: async (): Promise<Settings> => { await settingsDB.read(); return settingsDB.data; },
  holdOperations: <T>(work: () => Promise<T>) => holdOperations(work),
  holdJobRebuilds: <T>(work: () => Promise<T>) => holdJobRebuilds(work),
  swap: () => swapSides(),
  resume: (side: Side) => resumeSchedule(side),
};

// Nothing reaches the hardware: the bed is idle, and the schedule resumes on the new sides after.
export async function runSideSwap(deps = defaults, now = new Date()): Promise<void> {
  await deps.holdOperations(async () => {
    const reasons = await deps.inUse();
    if (reasons.some(reason => reason !== 'alarm-soon')) throw new SwapRefused('Turn both sides off first.');
    if (reasons.includes('alarm-soon')) throw new SwapRefused('An alarm is due in the next 15 minutes. Try again after it.');
    const settings = await deps.settings();
    // A pause is held on its physical side, so it would not move with the person.
    if (SCHEDULE_SIDES.some(side => isSchedulePaused(settings, side, now))) throw new SwapRefused('End the pause on both sides first.');
    await deps.holdJobRebuilds(() => deps.swap());
  });
  await Promise.all(SCHEDULE_SIDES.map(side => deps.resume(side)));
}
