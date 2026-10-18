import schedule from 'node-schedule';
import { resumeSchedule } from './resumeSchedule.js';
import { endPauseHold } from './pauseHold.js';
import logger from '../logger.js';
import { updateSettings } from '../db/settings.js';
import { Settings } from '../db/settingsSchema.js';
import { Side } from '../db/schedulesSchema.js';

// The clear runs after the end, not at it, so an alarm due exactly at the end
// still reads the pause however node-schedule orders jobs due together.
export const PAUSE_RESUME_DELAY_MS = 60 * 1000;

// Clears only the pause that ended, so a newer pause saved meanwhile stays.
// An off side resumes the current night after the pause is cleared.
export async function clearEndedPause(side: Side, expiresAt: string): Promise<boolean> {
  let cleared = false;
  try {
    await updateSettings(draft => {
      const pause = draft[side].scheduleOverrides.pause;
      if (!pause?.active || pause.expiresAt !== expiresAt) return false;
      draft[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
      cleared = true;
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to end the ${side} schedule pause: ${message}`);
    return false;
  }
  if (cleared) {
    logger.info(`Schedule pause for ${side} ended at ${expiresAt}`);
    await endPauseHold(side);
    const endedAt = new Date(expiresAt);
    await resumeSchedule(side, Number.isFinite(endedAt.getTime()) ? endedAt : new Date());
  }
  return cleared;
}

// Always a job, never inline: a rebuild that waited for the resume would plan
// nothing meanwhile, and a weekly job due in that wait would skip a week. A
// pause that already ended, or whose end cannot be read, ends a second later.
export function schedulePauseResume(settings: Settings, side: Side, now = new Date()): void {
  const pause = settings[side]?.scheduleOverrides?.pause;
  if (!pause?.active || !pause.expiresAt) return;
  const { expiresAt } = pause;
  const end = Date.parse(expiresAt);
  const due = Math.max(Number.isFinite(end) ? end + PAUSE_RESUME_DELAY_MS : 0, now.getTime() + 1000);
  logger.debug(`Scheduling the ${side} schedule pause to end at ${expiresAt}`);
  schedule.scheduleJob(`${side}-pause-resume`, new Date(due), () => clearEndedPause(side, expiresAt));
}
