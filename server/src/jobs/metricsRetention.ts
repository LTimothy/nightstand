import { Prisma, type PrismaClient } from '@prisma/client';
import { collectNightSummary, parseVitalsStats } from '../db/vitalsSummary.js';
import { defaultFeatures } from '../db/settingsSchema.js';
import moment from 'moment-timezone';

const DAY_SECONDS = 86400;
export const LOW_DISK_BYTES = 150 * 1024 * 1024;
export const REUSABLE_TARGET_BYTES = 16 * 1024 * 1024;
const BATCH_ROWS = 1000;
const MAX_BATCHES = 100;

type RetentionFeatures = Pick<typeof defaultFeatures, 'metricsRetention' | 'metricsLowDiskProtection'>;
type FeatureValues = { [Key in keyof RetentionFeatures]: boolean };

export function retentionCutoffs(now: Date, availableBytes: number | null, features: FeatureValues = defaultFeatures, timeZone = 'UTC') {
  const timestamp = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid retention date');
  const lowDisk = features.metricsLowDiskProtection && availableBytes !== null && Number.isFinite(availableBytes)
    && availableBytes >= 0 && availableBytes < LOW_DISK_BYTES;
  if (!moment.tz.zone(timeZone)) throw new Error('Invalid retention timezone');
  return { timestamp, detail: features.metricsRetention ? timestamp - 30 * DAY_SECONDS : null, lowDisk, timeZone };
}

export async function reusableBytes(client: PrismaClient): Promise<number> {
  const [free] = await client.$queryRaw<{ freelist_count: bigint | number }[]>`PRAGMA freelist_count`;
  const [size] = await client.$queryRaw<{ page_size: bigint | number }[]>`PRAGMA page_size`;
  return Number(free.freelist_count) * Number(size.page_size);
}

// Movement of a night is only dropped once its saved summary holds the stages computed from it.
// Driven from the summaries so each delete is a bounded range on the (side, timestamp) index.
async function deleteSummarizedMovement(client: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>, floors: Record<string, number>) {
  let deleted = 0;
  for (const side of ['left', 'right']) {
    const nights = await client.$queryRaw<{ entered_bed_at: number; left_bed_at: number }[]>(Prisma.sql`
      SELECT entered_bed_at, left_bed_at FROM vitals_summaries
      WHERE side = ${side} AND entered_bed_at < ${floors[side]}
        AND EXISTS (SELECT 1 FROM movement m WHERE m.side = vitals_summaries.side
          AND m.timestamp >= entered_bed_at AND m.timestamp <= MIN(left_bed_at, ${floors[side] - 1}))
        AND json_extract(payload, '$.stages') IS NOT NULL
      ORDER BY entered_bed_at ASC`);
    for (const night of nights) {
      if (deleted >= BATCH_ROWS) return deleted;
      deleted += await client.$executeRaw(Prisma.sql`
        DELETE FROM movement WHERE id IN (
          SELECT id FROM movement
          WHERE side = ${side} AND timestamp >= ${night.entered_bed_at}
            AND timestamp <= ${Math.min(night.left_bed_at, floors[side] - 1)}
          ORDER BY timestamp ASC LIMIT ${BATCH_ROWS - deleted})`);
    }
  }
  return deleted;
}

// Summarize and delete in the same transaction. Small batches let the live writer run between them.
export async function pruneMetrics(
  client: PrismaClient, cutoffs: ReturnType<typeof retentionCutoffs>, readAvailableBytes?: () => Promise<number>,
) {
  const totals = { vitals: 0, movement: 0, batches: 0, stopped: 'complete' };
  if (!cutoffs.lowDisk && cutoffs.detail === null) return totals;
  const floors: Record<string, number> = {};
  const detailFloors: Record<string, number> = {};
  for (const side of ['left', 'right']) {
    const latest = await client.sleep_records.findMany({
      where: { side }, orderBy: { left_bed_at: 'desc' }, take: 100,
      select: { entered_bed_at: true, left_bed_at: true },
    });
    const dates = new Set<string>();
    let floor = cutoffs.timestamp - 2 * DAY_SECONDS;
    let reachedOlderNight = false;
    for (const record of latest) {
      const date = moment.tz(record.left_bed_at * 1000, cutoffs.timeZone).format('YYYY-MM-DD');
      if (!dates.has(date) && dates.size === 2) { reachedOlderNight = true; break; }
      dates.add(date);
      floor = Math.min(floor, record.entered_bed_at);
    }
    // If a bounded read cannot locate two complete nights, retain this side's detail.
    floor = latest.length === 100 && !reachedOlderNight ? 0 : floor;
    const protectCrossingNight = async (boundary: number) => {
      const crossing = await client.sleep_records.aggregate({
        where: { side, left_bed_at: { gte: boundary } }, _min: { entered_bed_at: true },
      });
      return Math.min(boundary, crossing._min.entered_bed_at === null ? boundary : crossing._min.entered_bed_at - 60);
    };
    floors[side] = await protectCrossingNight(floor);
    detailFloors[side] = await protectCrossingNight(Math.min(floor, cutoffs.detail ?? Infinity));
  }
  let lowDisk = cutoffs.lowDisk;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (lowDisk) {
      if (readAvailableBytes) {
        const available = await readAvailableBytes();
        if (!Number.isFinite(available) || available < 0) throw new Error('Invalid available storage');
        lowDisk = available < LOW_DISK_BYTES;
      }
      if (lowDisk && await reusableBytes(client) >= REUSABLE_TARGET_BYTES) lowDisk = false;
    }
    if (!lowDisk && cutoffs.detail === null) return totals;
    const batchFloors = lowDisk ? floors : detailFloors;
    let removed: number;
    let movement = 0;
    try {
      removed = await client.$transaction(async transaction => {
        const candidates: { id: number; side: string; timestamp: number }[] = [];
        for (const side of ['left', 'right']) {
          candidates.push(...await transaction.$queryRaw<typeof candidates>(Prisma.sql`
          SELECT id, side, timestamp FROM vitals
          WHERE side = ${side} AND timestamp < ${batchFloors[side]}
          ORDER BY timestamp ASC, id ASC LIMIT ${BATCH_ROWS}`));
        }
        const rows = candidates.sort((left, right) => left.timestamp - right.timestamp || left.id - right.id).slice(0, BATCH_ROWS);
        if (!rows.length) {
          if (lowDisk) movement = await deleteSummarizedMovement(transaction, floors);
          return movement > 0 ? 0 : -1;
        }
        const nights = await transaction.sleep_records.findMany({ where: { OR: ['left', 'right'].flatMap(side => {
          const timestamps = rows.filter(row => row.side === side).map(row => row.timestamp);
          return timestamps.length ? [{ side, entered_bed_at: { lte: Math.max(...timestamps) + 60 },
            left_bed_at: { gte: Math.min(...timestamps) - 60 } }] : [];
        }) } });
        for (const night of nights) {
          const key = { side: night.side, entered_bed_at: night.entered_bed_at, left_bed_at: night.left_bed_at };
          const saved = await transaction.vitals_summaries.findUnique({
            where: { side_entered_bed_at_left_bed_at: key },
          });
          if (saved) parseVitalsStats(saved.payload);
          else {
            const payload = await collectNightSummary(transaction, night.side, night.entered_bed_at, night.left_bed_at);
            parseVitalsStats(payload);
            await transaction.vitals_summaries.create({ data: { ...key, payload } });
          }
        }
        return transaction.$executeRaw(Prisma.sql`DELETE FROM vitals WHERE id IN (${Prisma.join(rows.map(row => row.id))})`);
      }, { timeout: 3000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2028'
        || !/expired|timed out/i.test(error.message)) throw error;
      totals.stopped = 'transaction timeout';
      return totals;
    }
    if (movement > 0) {
      totals.movement += movement;
      totals.batches++;
      await new Promise<void>(resolve => setImmediate(resolve));
      continue;
    }
    if (removed <= 0) { totals.stopped = removed < 0 ? 'no eligible rows' : 'no progress'; return totals; }
    totals.vitals += removed;
    totals.batches++;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  totals.stopped = 'batch limit';
  return totals;
}
