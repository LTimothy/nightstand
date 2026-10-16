import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { legacyMovement, loadMovement } from './movement.js';
import type { VitalsSummary } from './vitalsRecordSchema.js';
import type { MetricsQuery } from '../routes/metrics/metricsQuery.js';
import { summarizeStages, toStageVitals, type StageSummary } from './sleepStageSummary.js';

export type SummaryClient = Pick<Prisma.TransactionClient, 'vitals' | 'vitals_summaries' | 'movement'>;
type Aggregate = { sum: number; count: number; min: number | null; max: number | null };
export type VitalsStats = Record<'heart' | 'positiveHeart' | 'hrv' | 'breathing' | 'resp' | 'positiveResp', Aggregate>;

// Store sums and counts, so larger ranges can combine nights without rounding averages twice.
export async function collectVitalsStats(client: SummaryClient, where: Prisma.vitalsWhereInput): Promise<VitalsStats> {
  const aggregate = async (column: 'heart_rate' | 'hrv' | 'breathing_rate' | 'resp_rate', filter = {}) => {
    const result = await client.vitals.aggregate({
      where: { ...where, ...filter },
      _sum: { [column]: true }, _count: { [column]: true },
      _min: { [column]: true }, _max: { [column]: true },
    });
    return { sum: result._sum[column] ?? 0, count: result._count[column],
      min: result._min[column], max: result._max[column] };
  };
  return {
    heart: await aggregate('heart_rate'),
    positiveHeart: await aggregate('heart_rate', { heart_rate: { gt: 0 } }),
    hrv: await aggregate('hrv', { hrv: { gte: 30, lte: 120 } }),
    breathing: await aggregate('breathing_rate', { breathing_rate: { gte: 5, lte: 20 } }),
    resp: await aggregate('resp_rate'),
    positiveResp: await aggregate('resp_rate', { resp_rate: { gt: 0 } }),
  };
}

async function collectStageSummary(client: SummaryClient, side: string, start: number, end: number): Promise<StageSummary> {
  const vitals = await client.vitals.findMany({
    where: { side, timestamp: { gte: start, lte: end } }, orderBy: { timestamp: 'asc' },
    select: { timestamp: true, heart_rate: true, hrv: true, breathing_rate: true },
  });
  const movement = await loadMovement(side, start, end, client);
  return summarizeStages(vitals.map(toStageVitals), legacyMovement(movement), start, end);
}

export async function collectNightSummary(client: SummaryClient, side: string, start: number, end: number) {
  const stats = await collectVitalsStats(client, { side, timestamp: { gte: start, lte: end } });
  const interior = await client.vitals.aggregate({
    where: { side, timestamp: { gte: start + 60, lte: end - 60 }, heart_rate: { gt: 0 } },
    _min: { heart_rate: true },
  });
  // The score route accepts a minute of boundary slack. Keep those few readings exactly.
  const edges = await client.vitals.findMany({
    where: { side, timestamp: { gte: start - 60, lte: end + 60 }, heart_rate: { gt: 0 },
      OR: [{ timestamp: { lt: start + 60 } }, { timestamp: { gt: end - 60 } }] },
    select: { timestamp: true, heart_rate: true }, orderBy: { timestamp: 'asc' },
  });
  const stages = end > start && end - start <= 48 * 3600 ? await collectStageSummary(client, side, start, end) : null;
  return JSON.stringify({ version: 1, stats, stages, score: { minInteriorHeartRate: interior._min.heart_rate,
    edges: edges.map(row => ({ timestamp: row.timestamp, heartRate: row.heart_rate })) } });
}


const average = (value: Aggregate) => value.count ? value.sum / value.count : 0;
export function formatVitalsSummary(stats: VitalsStats, newerBreathing: boolean) {
  return {
    avgHeartRate: Math.round(average(stats.heart)),
    minHeartRate: Math.round(stats.heart.min ?? 0),
    maxHeartRate: Math.round(stats.heart.max ?? 0),
    avgHRV: Math.round(average(stats.hrv)),
    avgBreathingRate: Math.round(average(newerBreathing ? stats.resp : stats.breathing)),
  };
}

const aggregateSchema = z.object({
  sum: z.number().finite(), count: z.number().int().nonnegative(),
  min: z.number().finite().nullable(), max: z.number().finite().nullable(),
});
const stageTotalsSchema = z.object({ awake: z.number(), rem: z.number(), light: z.number(), deep: z.number() });
const stageSummarySchema = z.object({
  epochs: z.array(z.object({ startUnix: z.number(), endUnix: z.number(), stage: z.enum(['awake', 'rem', 'light', 'deep']) })),
  totals: stageTotalsSchema, percentages: stageTotalsSchema, totalSeconds: z.number(),
  asleepSeconds: z.number(), lowCoverage: z.boolean(),
});
const storedStatsSchema = z.object({ version: z.literal(1), stages: stageSummarySchema.nullable(), score: z.object({
  minInteriorHeartRate: z.number().finite().positive().nullable(),
  edges: z.array(z.object({ timestamp: z.number().int(), heartRate: z.number().finite().positive() })),
}), stats: z.object({
  heart: aggregateSchema, positiveHeart: aggregateSchema, hrv: aggregateSchema,
  breathing: aggregateSchema, resp: aggregateSchema, positiveResp: aggregateSchema,
}) });

export function parseVitalsStats(payload: string): VitalsStats {
  return storedStatsSchema.parse(JSON.parse(payload)).stats;
}

export function retainedRestingHeartRate(payload: string, start: number, end: number): number {
  const { score } = storedStatsSchema.parse(JSON.parse(payload));
  const candidates = score.edges.filter(row => row.timestamp >= start && row.timestamp <= end).map(row => row.heartRate);
  if (score.minInteriorHeartRate !== null) candidates.push(score.minInteriorHeartRate);
  return candidates.length ? Math.min(...candidates) : 0;
}

export async function readStageSummary(client: SummaryClient, side: string, start: number, end: number): Promise<StageSummary> {
  const saved = await client.vitals_summaries.findUnique({ where: { side_entered_bed_at_left_bed_at: {
    side, entered_bed_at: start, left_bed_at: end,
  } } });
  if (saved) {
    const { stages } = storedStatsSchema.parse(JSON.parse(saved.payload));
    if (stages) return stages;
  }
  return collectStageSummary(client, side, start, end);
}

export class VitalsSummaryBusyError extends Error {}

export async function readVitalsSummary(client: SummaryClient, range: MetricsQuery, newerBreathing: boolean): Promise<VitalsSummary> {
  const loadSaved = () => client.vitals_summaries.findMany({
    where: { side: range.side, entered_bed_at: { gte: range.start }, left_bed_at: { lte: range.end } },
    orderBy: { entered_bed_at: 'asc' },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = await loadSaved();
    // Exact nights also retain the positive-only averages displayed by the app.
    const exact = saved.find(row => row.side === range.side
      && row.entered_bed_at === range.start && row.left_bed_at === range.end);
    if (exact) {
      const stats = parseVitalsStats(exact.payload);
      return { ...formatVitalsSummary(stats, newerBreathing), retained: {
        avgHeartRate: Math.round(average(stats.positiveHeart)),
        avgBreathingRate: Math.round(average(stats.positiveResp)),
      } };
    }
    // Overlapping records must not count the same readings twice.
    const disjoint: typeof saved = [];
    for (const row of saved) {
      if (!disjoint.some(kept => kept.side === row.side && kept.left_bed_at > row.entered_bed_at)) disjoint.push(row);
    }
    const stats = await collectVitalsStats(client, {
      side: range.side, timestamp: { gte: range.start, lte: range.end },
      NOT: disjoint.map(row => ({ side: row.side, timestamp: { gte: row.entered_bed_at, lte: row.left_bed_at } })),
    });
    // Retention may commit between reads. Retry without taking SQLite's writer lock.
    const confirmed = await loadSaved();
    const confirmedById = new Map(confirmed.map(row => [row.id, row]));
    if (saved.length !== confirmed.length || saved.some(row => {
      const current = confirmedById.get(row.id);
      return !current || current.side !== row.side || current.entered_bed_at !== row.entered_bed_at
        || current.left_bed_at !== row.left_bed_at || current.payload !== row.payload;
    })) continue;
    for (const row of disjoint) {
      const retained = parseVitalsStats(row.payload);
      for (const key of Object.keys(stats) as (keyof VitalsStats)[]) {
        const source = retained[key];
        const target = stats[key];
        target.sum += source.sum;
        target.count += source.count;
        if (source.min !== null) target.min = target.min === null ? source.min : Math.min(target.min, source.min);
        if (source.max !== null) target.max = target.max === null ? source.max : Math.max(target.max, source.max);
      }
    }
    return formatVitalsSummary(stats, newerBreathing);
  }
  throw new VitalsSummaryBusyError('Vitals summary busy, retry');
}
