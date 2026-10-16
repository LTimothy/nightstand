import express from 'express';
import { parseMetricsQuery, parseRowsQuery, ROWS_QUERY_ERROR } from './metricsQuery.js';
import { prisma } from '../../db/prisma.js';
import { biometricsV2Enabled } from '../../features/biometricsV2.js';
import { legacyVitalsSelect } from './vitalsV2.js';
import { readVitalsSummary, VitalsSummaryBusyError } from '../../db/vitalsSummary.js';
const router = express.Router();
const DEFAULT_SUMMARY_SECONDS = 90 * 24 * 3600;
router.get('/vitals', async (req, res) => {
    const range = parseRowsQuery(req.query);
    if (!range)
        return res.status(400).json({ error: ROWS_QUERY_ERROR });
    const query = { side: range.side, timestamp: { gte: range.start, lte: range.end } };
    // With new sleep tracking off the response carries only the columns every
    // release has sent; on, the newer estimate columns come too.
    const vitals = biometricsV2Enabled()
        ? await prisma.vitals.findMany({ where: query, orderBy: { timestamp: 'asc' } })
        : await prisma.vitals.findMany({ where: query, orderBy: { timestamp: 'asc' }, select: legacyVitalsSelect });
    // Timestamps go out as the epoch seconds they are stored as. They used to
    // be reformatted here into an ISO8601 string in the user's timezone, which
    // silently emptied the chart: the client scales the value to milliseconds
    // and discards anything that is not a finite number, so every record was
    // filtered out. Returning the row unchanged keeps one type across the wire,
    // and the client already renders in local time.
    res.json(vitals);
});
router.get('/vitals/summary', async (req, res) => {
    const range = parseMetricsQuery(req.query);
    if (!range)
        return res.status(400).json({ error: 'Invalid side, startTime or endTime' });
    if (range.start === undefined && range.end === undefined) {
        range.end = Math.floor(Date.now() / 1000);
        range.start = range.end - DEFAULT_SUMMARY_SECONDS;
    }
    try {
        res.json(await readVitalsSummary(prisma, range, biometricsV2Enabled()));
    }
    catch (error) {
        if (error instanceof VitalsSummaryBusyError)
            return res.status(503).json({ error: error.message });
        throw error;
    }
});
export default router;
//# sourceMappingURL=vitals.js.map