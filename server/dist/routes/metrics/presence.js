import express from 'express';
import moment from 'moment-timezone';
import { z } from 'zod';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import eventBus from '../../events/eventBus.js';
const router = express.Router();
const PresenceSideSchema = z.object({
    present: z.boolean(),
    lastUpdatedAt: z.string().optional(),
    stateChangedAt: z.string().optional(),
    // Last time `present` was reported as true. Used by the auto-off monitor
    // and surfaced to integrations (e.g. Home Assistant) to compute "minutes
    // since presence". Distinct from lastUpdatedAt, which advances every POST.
    lastPresenceAt: z.string().optional(),
});
export const PresenceDataSchema = z.object({
    left: PresenceSideSchema.optional(),
    right: PresenceSideSchema.optional(),
});
// In-memory storage for presence data
// No observation timestamps until the first update.
const presenceData = {
    left: {
        present: false,
    },
    right: {
        present: false,
    },
};
// In-process accessor for the auto-off monitor. Avoids a self-HTTP call.
export const getPresenceData = () => presenceData;
/**
 * POST /presence
 * Update presence data for one or both sides
 */
router.post('/presence', async (req, res) => {
    try {
        await settingsDB.read();
        const { body } = req;
        const validationResult = PresenceDataSchema.safeParse(body);
        if (!validationResult.success) {
            logger.error('Invalid device status update:', validationResult.error);
            res.status(400).json({
                error: 'Invalid request data',
                details: validationResult?.error?.errors,
            });
            return;
        }
        const updates = validationResult.data;
        // Check if at least one side is provided
        if (!updates.left && !updates.right) {
            return res.status(400).json({
                error: 'At least one side (left or right) must be specified',
                message: 'Please provide "left" and/or "right" with boolean values'
            });
        }
        const currentTime = moment.tz(settingsDB.data.timeZone).format();
        for (const side of ['left', 'right']) {
            const update = updates[side];
            if (!update)
                continue;
            const wasPresent = presenceData[side].present;
            const changed = !presenceData[side].stateChangedAt || wasPresent !== update.present;
            if (changed)
                presenceData[side].stateChangedAt = currentTime;
            presenceData[side].present = update.present;
            if (changed)
                eventBus.emit('presence', { side, present: update.present });
            presenceData[side].lastUpdatedAt = currentTime;
            // lastPresenceAt = the most recent moment the system believed someone
            // was on this side. Update on entry (update.present == true), on the
            // true-to-false transition (we just observed they left), or
            // steady-state present. Without the exit case, the auto-off monitor
            // would treat lastPresenceAt as 8h stale once the user gets out of
            // bed and fire immediately, since the Python stream only POSTs on
            // transitions, so there are no in-between heartbeats to refresh it.
            if (update.present || wasPresent) {
                presenceData[side].lastPresenceAt = currentTime;
            }
        }
        return res.status(200).json(presenceData);
    }
    catch (error) {
        logger.error('Error updating presence:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});
/**
 * GET /presence
 */
router.get('/presence', (req, res) => {
    return res.status(200).json(presenceData);
});
export default router;
//# sourceMappingURL=presence.js.map