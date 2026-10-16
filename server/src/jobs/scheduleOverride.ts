// Logic for "if user manually changes temp shortly before the next scheduled
// change, suppress the rest of the schedule."
//
// Wiring: call markManualTempChange() from each manual-change path
// (POST /api/deviceStatus, tap gestures). DO NOT call it from the scheduler
// jobs themselves, those are the ones we want to be suppressed.
import moment from 'moment-timezone';
import settingsDB, { updateSettings } from '../db/settings.js';
import schedulesDB from '../db/schedules.js';
import { Side } from '../db/schedulesSchema.js';
import logger from '../logger.js';
import { nextScheduledChange } from './scheduleQueries.js';
import { smartManualChange } from './rhythms/curveController.js';
import { recordHandChange, type HandChange } from './rhythms/handChanges.js';

export const OVERRIDE_WINDOW_HOURS = 3;
export const OVERRIDE_DURATION_HOURS = 12;

export const isTempScheduleOverridden = (side: Side): boolean => {
  const override = settingsDB.data[side]?.scheduleOverrides?.temperatureSchedules;
  if (!override?.disabled) return false;
  if (!override.expiresAt) return false;
  return moment(override.expiresAt).isAfter(moment());
};

export const markManualTempChange = async (side: Side, change?: HandChange): Promise<void> => {
  // Noted first, so the note sees the hold or override from before this change.
  if (change) recordHandChange(side, change);
  // Smart Schedule nights hold the curve until its next phase instead.
  if (smartManualChange(side) !== 'not-smart') return;
  await schedulesDB.read();
  await updateSettings(draft => {
    const timeZone = draft.timeZone || 'UTC';
    const now = moment.tz(timeZone);
    const nextAt = nextScheduledChange(side, now.toDate());
    if (!nextAt) return false;
    const next = moment.tz(nextAt, timeZone);
    if (next.diff(now, 'minutes') / 60 > OVERRIDE_WINDOW_HOURS) return false;
    const expiresAt = now.clone().add(OVERRIDE_DURATION_HOURS, 'hours').format();
    draft[side].scheduleOverrides.temperatureSchedules = { disabled: true, expiresAt };
    logger.info(`[manual temp] ${side}: schedule paused until ${expiresAt} (next change was at ${next.format()}).`);
  });
};
