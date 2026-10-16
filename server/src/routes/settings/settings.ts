import _ from 'lodash';
import { resumeSchedule } from '../../jobs/resumeSchedule.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import type { Side } from '../../db/schedulesSchema.js';
import express, { Request, Response } from 'express';
import logger from '../../logger.js';

const router = express.Router();

import settingsDB, { updateSettings } from '../../db/settings.js';
import { SettingsSchema } from '../../db/settingsSchema.js';
import { changesRhythmsFlag, pauseRejection, wouldOrphanLevelFormat } from './settingsGuards.js';
import { syncRawArchiveConf } from '../../jobs/rawArchiveConf.js';

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
  const resumed: Side[] = [];
  const resumedAt = new Date();
  let conflict = '';
  const rejected: { error?: string } = {};
  const saved = await updateSettings(draft => {
    if (changesRhythmsFlag(draft, validatedUpdate)) {
      conflict = 'Use /rhythms/enable or /rhythms/disable to turn Rhythms on or off';
      return false;
    }
    if (wouldOrphanLevelFormat(draft, validatedUpdate)) {
      conflict = 'Set temperature display away from Level before disabling this feature';
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
  }, async draft => {
    if (validatedUpdate.rawArchiveRetentionDays !== undefined) {
      await syncRawArchiveConf(draft.rawArchiveRetentionDays);
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
  // A resume can wait minutes for the Pod; the save is done, so answer now.
  for (const side of resumed) {
    void resumeSchedule(side, resumedAt).catch((error: unknown) => {
      logger.error(`Failed to resume the ${side} schedule: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  res.status(200).json(saved);
});


export default router;
