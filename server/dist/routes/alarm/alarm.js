import express from 'express';
import { z } from 'zod';
import { AlarmJobSchema, SideSchema, } from '../../db/schedulesSchema.js';
import logger from '../../logger.js';
import schedulesDB from '../../db/schedules.js';
import settingsDB from '../../db/settings.js';
import { executeAlarm } from '../../jobs/alarmScheduler.js';
import { activeAlarms } from '../../jobs/activeAlarms.js';
import { handleAlarmTap } from '../../8sleep/tapAlarm.js';
const router = express.Router();
router.post('/alarm', async (req, res) => {
    const body = req.body;
    const validationResult = AlarmJobSchema.safeParse(body);
    if (!validationResult.success) {
        logger.error('Invalid schedules update:', validationResult.error);
        res.status(400).json({
            error: 'Invalid request data',
            details: validationResult?.error?.errors,
        });
        return;
    }
    const alarmJob = validationResult.data;
    // Answer after the start command, so a Pod that could not be reached is not reported as ringing.
    const ringMs = await executeAlarm(alarmJob);
    if (!ringMs) {
        res.status(503).json({ error: { message: 'The alarm did not start. Try again in a moment.' } });
        return;
    }
    res.status(200).json(schedulesDB.data);
});
const SnoozeSchema = z.object({ side: SideSchema }).strict();
// The app's default snooze length when no gesture is set to snooze.
const DEFAULT_SNOOZE_SECONDS = 300;
router.post('/alarm/snooze', async (req, res) => {
    const parsed = SnoozeSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const { side } = parsed.data;
    // A snoozed alarm is no longer in activeAlarms, so it answers 409 too.
    if (!activeAlarms.has(side)) {
        res.status(409).json({ error: 'No alarm is ringing on this side' });
        return;
    }
    const { taps } = settingsDB.data[side];
    const gesture = [taps.doubleTap, taps.tripleTap, taps.quadTap]
        .find((tap) => tap.type === 'alarm' && tap.behavior === 'snooze');
    const snoozeDuration = gesture?.snoozeDuration ?? DEFAULT_SNOOZE_SECONDS;
    // The snooze timer starts after the stop, so the time is read after it too.
    const until = () => new Date(Date.now() + snoozeDuration * 1_000).toISOString();
    try {
        await handleAlarmTap(side, { type: 'alarm', behavior: 'snooze', snoozeDuration, inactiveAlarmBehavior: 'none' });
    }
    catch (error) {
        // handleAlarmTap arms the snooze even when the stop fails.
        logger.error(error);
        const snoozedUntil = until();
        res.status(503).json({ error: { message: `The alarm did not stop, but it is snoozed until ${snoozedUntil}.` } });
        return;
    }
    res.status(200).json({ snoozedUntil: until() });
});
export default router;
//# sourceMappingURL=alarm.js.map