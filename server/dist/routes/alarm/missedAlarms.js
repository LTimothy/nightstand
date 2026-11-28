import express from 'express';
import { z } from 'zod';
import { dismissMissedAlarms, listMissedAlarms, nextAlarms } from '../../jobs/alarmLedger.js';
import { rebuildSettled } from '../../jobs/rebuildState.js';
const router = express.Router();
const DismissSchema = z.object({ ids: z.array(z.string().max(120)).max(50) }).strict();
router.get('/alarms/missed', (_req, res) => {
    res.json({ missed: listMissedAlarms() });
});
// A rebuild cancels every job before planning, so the job list is empty until it settles.
router.get('/alarms/next', async (_req, res) => {
    await rebuildSettled();
    res.json(nextAlarms());
});
router.post('/alarms/missed/dismiss', (req, res) => {
    const parsed = DismissSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    dismissMissedAlarms(parsed.data.ids);
    res.status(204).end();
});
export default router;
//# sourceMappingURL=missedAlarms.js.map