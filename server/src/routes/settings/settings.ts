import _ from 'lodash';
import { resumeSchedule } from '../../jobs/resumeSchedule.js';
import { endPauseHold, holdForPause } from '../../jobs/pauseHold.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import type { Side } from '../../db/schedulesSchema.js';
import express, { Request, Response } from 'express';
import logger from '../../logger.js';

const router = express.Router();

import settingsDB, { updateSettings } from '../../db/settings.js';
import { GestureSchema, SettingsSchema, type TapAction } from '../../db/settingsSchema.js';
import { changesRhythmsFlag, pauseRejection } from './settingsGuards.js';
import { syncRawArchiveConf } from '../../jobs/rawArchiveConf.js';
import { syncJournalStorage } from '../../jobs/journalStorage.js';
import { syncFlashCommit } from '../../jobs/flashCommit.js';
import { applyOtherSlot } from '../../jobs/otherSlot.js';
import { OperationBusyError, privilegedErrorStatus } from '../../jobs/privilegedCommand.js';

router.get('/settings', async (req: Request, res: Response) => {
  await settingsDB.read();
  res.json(settingsDB.data);
});


router.post('/settings', async (req: Request, res: Response) => {
  const { body } = req;
  const validationResult = SettingsSchema.deepPartial().safeParse(body);
  if (!validationResult.success) {
    logger.error('Invalid settings update:', validationResult.error);
    res.status(400).json({
      error: 'Invalid request data',
      details: validationResult?.error?.errors,
    });
    return;
  }
  // Merge the validated/stripped result, not the raw body: some nested
  // schemas here aren't `.strict()`, so extra attacker-supplied properties
  // on those nested objects pass validation and would otherwise be written
  // into settingsDB.data verbatim if the raw body were merged instead.
  const validatedUpdate = validationResult.data;
  delete validatedUpdate.id;
  const otherSlot = validatedUpdate.features?.otherSlotAccess;
  if (otherSlot !== undefined) await settingsDB.read();
  // Saved only once the script succeeds, so the switch never reads on without a way in.
  if (otherSlot !== undefined && otherSlot !== settingsDB.data.features.otherSlotAccess) {
    try {
      await applyOtherSlot(otherSlot);
    } catch (error) {
      logger.warn(`Could not ${otherSlot ? 'prepare' : 'put back'} the other boot slot: `
        + `${error instanceof Error ? error.message : String(error)}`);
      res.status(privilegedErrorStatus(error)).json({
        error: error instanceof OperationBusyError ? error.message : otherSlot
          ? 'Could not prepare the other boot slot. It needs an SSH key and a rewt password on this Pod. '
            + 'Run boot_slot.sh other-status over SSH for details.'
          : 'Could not put the other boot slot back. Run boot_slot.sh other-undo over SSH for details.',
      });
      return;
    }
  }
  const resumed: Side[] = [];
  const held: Array<[Side, Date]> = [];
  const resumedAt = new Date();
  let conflict = '';
  const rejected: { error?: string } = {};
  const saved = await updateSettings(draft => {
    if (changesRhythmsFlag(draft, validatedUpdate)) {
      conflict = 'Use /rhythms/enable or /rhythms/disable to turn Rhythms on or off';
      return false;
    }
    const pauseError = pauseRejection(draft, validatedUpdate, new Date());
    if (pauseError) {
      rejected.error = pauseError;
      return false;
    }
    for (const side of SCHEDULE_SIDES) {
      if (draft[side].scheduleOverrides.pause.active && validatedUpdate[side]?.scheduleOverrides?.pause?.active === false) resumed.push(side);
    }
    _.merge(draft, validatedUpdate);
    for (const side of SCHEDULE_SIDES) {
      const pause = draft[side].scheduleOverrides.pause;
      if (validatedUpdate[side]?.scheduleOverrides?.pause?.active && pause.expiresAt) held.push([side, new Date(pause.expiresAt)]);
    }
    // A gesture is replaced whole, so no field of its previous action stays behind.
    for (const side of SCHEDULE_SIDES) {
      for (const gesture of GestureSchema.options) {
        const tap = validatedUpdate[side]?.taps?.[gesture];
        if (tap) draft[side].taps[gesture] = tap as TapAction;
      }
    }
  }, async draft => {
    if (validatedUpdate.rawArchiveRetentionDays !== undefined) {
      await syncRawArchiveConf(draft.rawArchiveRetentionDays);
    }
    if (validatedUpdate.features?.journalInMemory !== undefined) {
      await syncJournalStorage(draft.features.journalInMemory);
    }
    if (validatedUpdate.features?.longFlashCommit !== undefined) {
      await syncFlashCommit(draft.features.longFlashCommit);
    }
  });
  if (conflict) {
    res.status(409).json({ error: conflict });
    return;
  }
  if (rejected.error) {
    res.status(400).json({ error: rejected.error });
    return;
  }
  // Hub writes can wait for the Pod; the save is done, so answer now.
  for (const [side, end] of held) void holdForPause(side, end);
  for (const side of resumed) {
    void endPauseHold(side).then(() => resumeSchedule(side, resumedAt)).catch((error: unknown) => {
      logger.error(`Failed to resume the ${side} schedule: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  res.status(200).json(saved);
});


export default router;
