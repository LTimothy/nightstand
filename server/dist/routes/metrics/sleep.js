import express from 'express';
import { z } from 'zod';
import { SideSchema } from '../../db/schedulesSchema.js';
import { loadSleepRecords } from '../../db/loadSleepRecords.js';
import { prisma } from '../../db/prisma.js';
import { parseMetricsQuery } from './metricsQuery.js';
const router = express.Router();
const DEFAULT_SLEEP_SECONDS = 90 * 24 * 3600;
router.get('/sleep', async (req, res) => {
    const range = parseMetricsQuery(req.query);
    if (!range)
        return res.status(400).json({ error: 'Invalid side, startTime or endTime' });
    if (range.start === undefined && range.end === undefined) {
        range.end = Math.floor(Date.now() / 1000);
        range.start = range.end - DEFAULT_SLEEP_SECONDS;
    }
    const query = {
        side: range.side,
        left_bed_at: { gte: range.start },
        entered_bed_at: { lte: range.end },
    };
    const sleepRecords = await prisma.sleep_records.findMany({
        where: query,
        orderBy: { entered_bed_at: 'asc' },
    });
    const formattedRecords = await loadSleepRecords(sleepRecords);
    res.json(formattedRecords);
});
// Sleep record columns are 32-bit integers holding epoch seconds.
const MAX_INT32 = 2_147_483_647;
const parseRecordId = (raw) => {
    if (!/^\d{1,10}$/.test(raw))
        return undefined;
    const id = Number(raw);
    return id >= 1 && id <= MAX_INT32 ? id : undefined;
};
const EpochSecondsSchema = z.string().datetime({ offset: true })
    .transform(value => Math.floor(Date.parse(value) / 1000))
    .refine(seconds => seconds >= 0 && seconds <= MAX_INT32, 'Time is out of range');
const IntervalsSchema = z.array(z.tuple([EpochSecondsSchema, EpochSecondsSchema]))
    .refine(pairs => pairs.every(([start, end]) => end >= start), 'Interval ends before it starts');
const CountSchema = z.number().int().min(0).max(MAX_INT32);
// Fields a client may change. The id comes from the path only.
const SleepRecordUpdateSchema = z.object({
    side: SideSchema,
    entered_bed_at: EpochSecondsSchema,
    left_bed_at: EpochSecondsSchema,
    sleep_period_seconds: CountSchema,
    times_exited_bed: CountSchema,
    present_intervals: IntervalsSchema,
    not_present_intervals: IntervalsSchema,
}).partial();
const isPrismaError = (error, code) => error?.code === code;
// One transaction: the record, the overlap check and the retained summary
// keyed by the night's bounds move together or not at all.
async function applySleepRecordUpdate(tx, id, body) {
    const existing = await tx.sleep_records.findUnique({ where: { id } });
    if (!existing)
        return { status: 404, body: { error: 'Sleep record not found' } };
    const parsedData = SleepRecordUpdateSchema.safeParse(body);
    if (!parsedData.success)
        return { status: 400, body: { error: 'Invalid request body', details: parsedData.error.format() } };
    const { present_intervals: presentIntervals, not_present_intervals: notPresentIntervals, ...fields } = parsedData.data;
    const side = fields.side ?? existing.side;
    const enteredBedAt = fields.entered_bed_at ?? existing.entered_bed_at;
    const leftBedAt = fields.left_bed_at ?? existing.left_bed_at;
    if (leftBedAt < enteredBedAt) {
        return { status: 400, body: { error: 'Invalid request body', details: 'left_bed_at is before entered_bed_at' } };
    }
    const data = { ...fields };
    if (presentIntervals)
        data.present_intervals = JSON.stringify(presentIntervals);
    if (notPresentIntervals)
        data.not_present_intervals = JSON.stringify(notPresentIntervals);
    // Moving either end changes the period and which absences fall inside it.
    if (fields.entered_bed_at !== undefined || fields.left_bed_at !== undefined) {
        data.sleep_period_seconds ??= leftBedAt - enteredBedAt;
        const absences = notPresentIntervals
            ?? (existing.not_present_intervals ? JSON.parse(existing.not_present_intervals) : []);
        data.times_exited_bed ??= absences.filter(([start, end]) => start >= enteredBedAt && end <= leftBedAt).length;
    }
    const moved = side !== existing.side || enteredBedAt !== existing.entered_bed_at || leftBedAt !== existing.left_bed_at;
    if (moved) {
        const overlap = await tx.sleep_records.findFirst({ where: {
                id: { not: id }, side, entered_bed_at: { lt: leftBedAt }, left_bed_at: { gt: enteredBedAt },
            } });
        if (overlap)
            return { status: 409, body: { error: 'Another sleep record on this side overlaps that time' } };
    }
    const record = await tx.sleep_records.update({ where: { id }, data });
    if (moved) {
        const oldKey = { side: existing.side, entered_bed_at: existing.entered_bed_at, left_bed_at: existing.left_bed_at };
        // Only a summary that travels with the night may replace one at the new key;
        // otherwise the night adopts whatever is already there.
        if (await tx.vitals_summaries.findFirst({ where: oldKey })) {
            await tx.vitals_summaries.deleteMany({ where: { side, entered_bed_at: enteredBedAt, left_bed_at: leftBedAt } });
            await tx.vitals_summaries.updateMany({ where: oldKey, data: { side, entered_bed_at: enteredBedAt, left_bed_at: leftBedAt } });
        }
    }
    return { record };
}
router.put('/sleep/:id', async (req, res) => {
    const id = parseRecordId(req.params.id);
    if (id === undefined) {
        return res.status(400).json({ error: 'Invalid ID' });
    }
    try {
        const outcome = await prisma.$transaction(tx => applySleepRecordUpdate(tx, id, req.body));
        if ('status' in outcome)
            return res.status(outcome.status).json(outcome.body);
        const [loaded] = await loadSleepRecords([outcome.record]);
        return res.json(loaded);
    }
    catch (error) {
        if (isPrismaError(error, 'P2025'))
            return res.status(404).json({ error: 'Sleep record not found' });
        if (isPrismaError(error, 'P2002')) {
            return res.status(409).json({ error: 'Another sleep record on this side overlaps that time' });
        }
        throw error;
    }
});
router.delete('/sleep/:id', async (req, res) => {
    const id = parseRecordId(req.params.id);
    if (id === undefined) {
        return res.status(400).json({ error: 'Invalid ID' });
    }
    const deleted = await prisma.$transaction(async (tx) => {
        const existing = await tx.sleep_records.findUnique({ where: { id } });
        if (!existing)
            return false;
        const { count } = await tx.sleep_records.deleteMany({ where: { id } });
        if (count === 0)
            return false;
        await tx.vitals_summaries.deleteMany({ where: {
                side: existing.side, entered_bed_at: existing.entered_bed_at, left_bed_at: existing.left_bed_at,
            } });
        return true;
    });
    if (!deleted) {
        return res.status(404).json({ error: 'Sleep record not found' });
    }
    res.status(204).send();
});
export default router;
//# sourceMappingURL=sleep.js.map