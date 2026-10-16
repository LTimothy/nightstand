import express from 'express';
import { prisma } from '../../db/prisma.js';
import settingsDB from '../../db/settings.js';
import servicesDB from '../../db/services.js';
import { isSleepScoreActive } from './sleepScoreGuard.js';
import { parseNightQuery } from './metricsQuery.js';
import { retainedRestingHeartRate } from '../../db/vitalsSummary.js';
const router = express.Router();
// --- Component scorers (each returns 0-100) ---
function scoreDuration(seconds) {
    const hours = seconds / 3600;
    // 8h = 100, falls ~10pts per hour away, floor at 0
    const delta = Math.abs(hours - 8);
    return Math.max(0, Math.round(100 - delta * 10));
}
function scoreContinuity(timesExited) {
    // 0 trips = 100, -15 per trip, floor at 0
    return Math.max(0, 100 - timesExited * 15);
}
function formatHours(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${m ? ` ${m}m` : ''}`;
}
// Scores time in bed: the stages classifier cannot yet place sleep onset reliably.
export function durationComponent(inBedSeconds) {
    return {
        score: scoreDuration(inBedSeconds),
        weight: 0.4,
        value: `${formatHours(inBedSeconds)} in bed`,
        available: true,
    };
}
router.get('/sleep-score', async (req, res) => {
    const night = parseNightQuery(req.query);
    if (!night) {
        return res.status(400).json({ error: 'side, startTime and endTime are required, and the range must be at most 48 hours' });
    }
    const { side, start: startUnix, end: endUnix } = night;
    await settingsDB.read();
    await servicesDB.read();
    if (!isSleepScoreActive(settingsDB.data, servicesDB.data)) {
        return res.json({ active: false, score: null, components: {} });
    }
    // Sleep record covering this window (used for duration + bed exits)
    const sleepRecord = await prisma.sleep_records.findFirst({
        where: {
            side,
            entered_bed_at: { lte: startUnix + 60 },
            left_bed_at: { gte: endUnix - 60 },
        },
        orderBy: { entered_bed_at: 'asc' },
    });
    // Vitals during the window
    const vitalsQuery = {
        side,
        timestamp: { gte: startUnix, lte: endUnix },
    };
    const hrAgg = await prisma.vitals.aggregate({
        where: { ...vitalsQuery, heart_rate: { gt: 0 } },
        _min: { heart_rate: true },
    });
    const inBedSec = sleepRecord?.sleep_period_seconds ?? endUnix - startUnix;
    const exits = sleepRecord?.times_exited_bed ?? 0;
    const saved = sleepRecord && Math.abs(sleepRecord.entered_bed_at - startUnix) <= 60
        && Math.abs(sleepRecord.left_bed_at - endUnix) <= 60
        ? await prisma.vitals_summaries.findUnique({ where: { side_entered_bed_at_left_bed_at: {
                    side, entered_bed_at: sleepRecord.entered_bed_at, left_bed_at: sleepRecord.left_bed_at,
                } } }) : null;
    const minHr = saved ? retainedRestingHeartRate(saved.payload, startUnix, endUnix) : hrAgg._min.heart_rate ?? 0;
    const components = {
        duration: durationComponent(inBedSec),
        continuity: {
            score: scoreContinuity(exits),
            weight: 0.3,
            value: `${exits} ${exits === 1 ? 'trip' : 'trips'} out of bed`,
            available: true,
        },
        // Kept in the response for older apps. The estimate is not used in the
        // score, so its weight goes to the other components.
        hrv: { score: 0, weight: 0.15, value: '', available: false },
        // The lowest estimate is reported for the info sheet only: one low
        // reading says little about rest, so it carries no weight in the score.
        restingHr: {
            score: 0,
            weight: 0.15,
            value: minHr > 0 ? `${Math.round(minHr)} bpm` : '',
            available: false,
        },
    };
    // Reweight: distribute missing components' weight proportionally across present ones.
    const totalAvailableWeight = Object.values(components)
        .filter((c) => c.available)
        .reduce((acc, c) => acc + c.weight, 0);
    let weightedSum = 0;
    for (const c of Object.values(components)) {
        if (!c.available)
            continue;
        const adjustedWeight = c.weight / totalAvailableWeight;
        weightedSum += c.score * adjustedWeight;
    }
    const score = Math.round(weightedSum);
    return res.json({ active: true, score, components });
});
export default router;
//# sourceMappingURL=sleepScore.js.map