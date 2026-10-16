import express from 'express';
import { prisma } from '../../db/prisma.js';
import settingsDB from '../../db/settings.js';
import servicesDB from '../../db/services.js';
import { isSleepScoreActive } from './sleepScoreGuard.js';
import { parseNightQuery } from './metricsQuery.js';
import { readStageSummary } from '../../db/vitalsSummary.js';
export { summarizeStages, toStageVitals } from '../../db/sleepStageSummary.js';
const router = express.Router();
export async function loadStageSummary(side, startUnix, endUnix) {
    return prisma.$transaction(transaction => readStageSummary(transaction, side, startUnix, endUnix));
}
router.get('/sleep-stages', async (req, res) => {
    const night = parseNightQuery(req.query);
    if (!night) {
        return res.status(400).json({ error: 'side, startTime and endTime are required, and the range must be at most 48 hours' });
    }
    const { side, start: startUnix, end: endUnix } = night;
    await settingsDB.read();
    await servicesDB.read();
    if (!isSleepScoreActive(settingsDB.data, servicesDB.data)) {
        return res.json({
            active: false,
            epochs: [],
            totals: { awake: 0, rem: 0, light: 0, deep: 0 },
            percentages: { awake: 0, rem: 0, light: 0, deep: 0 },
            totalSeconds: 0,
        });
    }
    const { epochs, totals, percentages, totalSeconds, lowCoverage } = await loadStageSummary(side, startUnix, endUnix);
    return res.json({ active: true, epochs, totals, percentages, totalSeconds, lowCoverage });
});
export default router;
//# sourceMappingURL=sleepStages.js.map