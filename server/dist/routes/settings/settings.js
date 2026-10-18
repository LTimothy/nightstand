import _ from 'lodash';
import { resumeSchedule } from '../../jobs/resumeSchedule.js';
import { endPauseHold, holdForPause } from '../../jobs/pauseHold.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import express from 'express';
import logger from '../../logger.js';
const router = express.Router();
import settingsDB, { updateSettings } from '../../db/settings.js';
import { SettingsSchema } from '../../db/settingsSchema.js';
import { changesRhythmsFlag, pauseRejection, wouldOrphanLevelFormat } from './settingsGuards.js';
import { syncRawArchiveConf } from '../../jobs/rawArchiveConf.js';
router.get('/settings', async (req, res) => {
    await settingsDB.read();
    res.json(settingsDB.data);
});
router.post('/settings', async (req, res) => {
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
    const resumed = [];
    const held = [];
    const resumedAt = new Date();
    let conflict = '';
    const rejected = {};
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
            if (draft[side].scheduleOverrides.pause.active && validatedUpdate[side]?.scheduleOverrides?.pause?.active === false)
                resumed.push(side);
        }
        _.merge(draft, validatedUpdate);
        for (const side of SCHEDULE_SIDES) {
            const pause = draft[side].scheduleOverrides.pause;
            if (validatedUpdate[side]?.scheduleOverrides?.pause?.active && pause.expiresAt)
                held.push([side, new Date(pause.expiresAt)]);
        }
        // A gesture is replaced whole, so no field of its previous action stays behind.
        for (const side of SCHEDULE_SIDES) {
            for (const [gesture, tap] of Object.entries(validatedUpdate[side]?.taps ?? {})) {
                if (tap)
                    draft[side].taps[gesture] = tap;
            }
        }
    }, async (draft) => {
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
    // Hub writes can wait for the Pod; the save is done, so answer now.
    for (const [side, end] of held)
        void holdForPause(side, end);
    for (const side of resumed) {
        void endPauseHold(side).then(() => resumeSchedule(side, resumedAt)).catch((error) => {
            logger.error(`Failed to resume the ${side} schedule: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    res.status(200).json(saved);
});
export default router;
//# sourceMappingURL=settings.js.map