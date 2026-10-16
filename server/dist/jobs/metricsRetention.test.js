import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { collectVitalsStats, readVitalsSummary } from '../db/vitalsSummary.js';
import { pruneMetrics, retentionCutoffs, reusableBytes, REUSABLE_TARGET_BYTES } from './metricsRetention.js';
import { applyMigration } from '../testing/migrations.js';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-retention-'));
mkdirSync(path.join(folder, 'lowdb'));
writeFileSync(path.join(folder, 'lowdb/settingsDB.json'), '{"features":{"sleepScore":false}}');
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { default: settings } = await import('../db/settings.js');
const now = new Date('2026-10-07T12:00:00Z');
const second = Math.floor(now.getTime() / 1000);
const day = 86400;
const age = { metricsRetention: true, metricsLowDiskProtection: false };
let sequence = 0;
const makeClient = (name) => new PrismaClient({
    datasources: { db: { url: `file:${folder}/${name}.db` } }, log: [{ emit: 'event', level: 'query' }],
});
let client;
before(async () => {
    const base = makeClient('base');
    for (const name of readdirSync('prisma/migrations').filter(name => /^\d/.test(name)).sort()) {
        await applyMigration(base, 'prisma/migrations', name);
    }
    await base.$disconnect();
});
beforeEach(() => {
    const name = `test-${sequence++}`;
    copyFileSync(`${folder}/base.db`, `${folder}/${name}.db`);
    client = makeClient(name);
});
afterEach(async () => { await client.$disconnect(); });
after(() => rmSync(folder, { recursive: true, force: true }));
async function night(side, start, end = start + 8 * 3600) {
    return client.sleep_records.create({ data: {
            side, entered_bed_at: start, left_bed_at: end, sleep_period_seconds: end - start,
            times_exited_bed: 1, present_intervals: '[]', not_present_intervals: '[]',
        } });
}
async function recentNights(side = 'left') {
    await night(side, second - day);
    await night(side, second - 2 * day);
}
const timestamps = async () => (await client.vitals.findMany({ orderBy: { timestamp: 'asc' } })).map(row => row.timestamp);
test('upgrade without retention keys on healthy storage deletes nothing', async () => {
    assert.equal(settings.data.features.metricsRetention, false);
    assert.equal(settings.data.features.metricsLowDiskProtection, true);
    assert.equal(settings.data.features.sleepScore, false);
    await night('left', second - 300 * day);
    await client.vitals.create({ data: { side: 'left', timestamp: second - 300 * day, heart_rate: 62 } });
    await client.movement.create({ data: { side: 'left', timestamp: second - 300 * day, total_movement: 1 } });
    const oldVitals = await client.vitals.findMany();
    const oldSleep = await client.sleep_records.findMany();
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 200 * 1024 * 1024, settings.data.features))).vitals, 0);
    assert.deepEqual(await client.vitals.findMany(), oldVitals);
    assert.deepEqual(await client.sleep_records.findMany(), oldSleep);
    assert.equal(await client.movement.count(), 1);
    assert.equal(await client.vitals_summaries.count(), 0);
});
test('age pruning keeps the 30-day boundary and never removes movement or sleep records', async () => {
    for (const side of ['left', 'right']) {
        await recentNights(side);
        await night(side, second - 300 * day);
        for (const timestamp of [second - 30 * day - 1, second - 30 * day, second]) {
            await client.vitals.create({ data: { side, timestamp, heart_rate: 65 } });
            await client.movement.create({ data: { side, timestamp, total_movement: 1 } });
        }
    }
    const sleep = await client.sleep_records.findMany();
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, null, age))).vitals, 2);
    assert.deepEqual(await timestamps(), [second - 30 * day, second - 30 * day, second, second]);
    assert.equal(await client.movement.count(), 6);
    assert.deepEqual(await client.sleep_records.findMany(), sleep);
});
test('low disk keeps 48 hours and each side\'s latest two nights even after a long absence', async () => {
    for (const side of ['left', 'right']) {
        await night(side, second - 10 * day);
        await night(side, second - 20 * day);
        await night(side, second - 40 * day);
        for (const timestamp of [second - 40 * day, second - 20 * day, second - 10 * day, second - 2 * day, second]) {
            await client.vitals.create({ data: { side, timestamp } });
        }
    }
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 1))).vitals, 2);
    assert.deepEqual(await timestamps(), [second - 20 * day, second - 20 * day, second - 10 * day,
        second - 10 * day, second - 2 * day, second - 2 * day, second, second]);
});
test('low disk deletes by timestamp rather than insertion order and rechecks storage between batches', async () => {
    await client.vitals.createMany({ data: Array.from({ length: 2005 }, (_, index) => ({
            side: 'left', timestamp: second - 40 * day - index,
        })) });
    let checks = 0;
    const result = await pruneMetrics(client, retentionCutoffs(now, 1), async () => ++checks === 1 ? 1 : 200 * 1024 * 1024);
    assert.equal(result.vitals, 1000);
    assert.equal(result.batches, 1);
    assert.equal(checks, 2);
    assert.equal((await timestamps())[0], second - 40 * day - 1004);
    assert.equal(await client.vitals.count(), 1005);
});
test('low disk stops once reusable pages reach headroom, without shrinking the file', async () => {
    await client.vitals.createMany({ data: Array.from({ length: 2005 }, (_, index) => ({
            side: 'left', timestamp: second - 40 * day - index,
        })) });
    await client.$executeRawUnsafe('CREATE TABLE scratch (payload BLOB)');
    // Leave slightly less than the target, so one real deletion batch crosses it.
    await client.$executeRawUnsafe('INSERT INTO scratch VALUES (zeroblob(16728000))');
    await client.$executeRawUnsafe('DELETE FROM scratch');
    const before = await reusableBytes(client);
    assert.ok(before < REUSABLE_TARGET_BYTES);
    const [pagesBefore] = await client.$queryRaw `PRAGMA page_count`;
    const result = await pruneMetrics(client, retentionCutoffs(now, 1));
    assert.equal(result.vitals, 1000);
    assert.ok(await reusableBytes(client) >= REUSABLE_TARGET_BYTES);
    const [pagesAfter] = await client.$queryRaw `PRAGMA page_count`;
    assert.equal(pagesAfter.page_count, pagesBefore.page_count);
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 1))).vitals, 0);
});
test('no progress stops after a zero-row delete instead of retrying forever', async () => {
    await client.vitals.create({ data: { side: 'left', timestamp: second - 40 * day } });
    await client.$executeRawUnsafe('CREATE TRIGGER ignore_delete BEFORE DELETE ON vitals BEGIN SELECT RAISE(IGNORE); END');
    const result = await pruneMetrics(client, retentionCutoffs(now, 1));
    assert.equal(result.vitals, 0);
    assert.equal(result.stopped, 'no progress');
    assert.equal(await client.vitals.count(), 1);
});
test('unavailable or invalid storage never activates low-disk pruning', async () => {
    for (const available of [null, NaN, -1, Infinity, 150 * 1024 * 1024]) {
        assert.equal(retentionCutoffs(now, available).lowDisk, false);
    }
    assert.throws(() => retentionCutoffs(new Date(NaN), null));
    await client.vitals.create({ data: { side: 'left', timestamp: second - 40 * day } });
    await assert.rejects(pruneMetrics(client, retentionCutoffs(now, 1), async () => NaN), /Invalid available storage/);
    assert.equal(await client.vitals.count(), 1);
});
test('partial batches preserve complete nightly averages, filters, both estimators and the score input', async () => {
    await recentNights();
    const start = second - 100 * day;
    await night('left', start, start + 2004 * 60);
    await client.vitals.createMany({ data: Array.from({ length: 2005 }, (_, index) => ({
            side: 'left', timestamp: start + index * 60, heart_rate: index % 2 ? 60 : 0,
            hrv: index % 2 ? 50 : 150, breathing_rate: index % 2 ? 14 : 25,
            resp_rate: index % 2 ? 15.5 : null,
        })) });
    const range = { side: 'left', start, end: start + 2004 * 60 };
    const beforeLegacy = await readVitalsSummary(client, range, false);
    const beforeNewer = await readVitalsSummary(client, range, true);
    const beforeStats = await collectVitalsStats(client, { side: 'left', timestamp: { gte: range.start, lte: range.end } });
    let checks = 0;
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 1), async () => ++checks === 1 ? 1 : 200 * 1024 * 1024)).vitals, 1000);
    const { retained, ...partial } = await readVitalsSummary(client, range, false);
    assert.deepEqual(partial, beforeLegacy);
    assert.deepEqual(retained, { avgHeartRate: 60, avgBreathingRate: 16 });
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, null, age))).vitals, 1005);
    const { retained: retainedNewer, ...after } = await readVitalsSummary(client, range, true);
    assert.deepEqual(after, beforeNewer);
    assert.deepEqual(retainedNewer, retained);
    assert.deepEqual(JSON.parse((await client.vitals_summaries.findFirstOrThrow()).payload).stats, beforeStats);
    assert.equal(await client.vitals_summaries.count(), 1);
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, null, age))).vitals, 0);
});
test('a failed summary write rolls back detail deletion', async () => {
    await recentNights();
    const start = second - 100 * day;
    await night('left', start);
    await client.vitals.create({ data: { side: 'left', timestamp: start, heart_rate: 62 } });
    await client.$executeRawUnsafe('CREATE TRIGGER fail_summary BEFORE INSERT ON vitals_summaries '
        + "BEGIN SELECT RAISE(ABORT, 'summary unavailable'); END");
    await assert.rejects(pruneMetrics(client, retentionCutoffs(now, null, age)));
    assert.equal(await client.vitals.count(), 1);
    assert.equal(await client.vitals_summaries.count(), 0);
});
test('older SQL readers still read and write the legacy tables after the additive migration and pruning', async () => {
    await recentNights();
    await night('left', second - 100 * day);
    await client.$executeRaw `INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
    VALUES ('left', ${second - 100 * day}, 60, 50, 14)`;
    await client.$executeRaw `INSERT INTO movement (side, timestamp, total_movement) VALUES ('left', ${second - 100 * day}, 1)`;
    const sleeps = await client.$queryRaw `SELECT id, side, entered_bed_at, left_bed_at, sleep_period_seconds,
    times_exited_bed, present_intervals, not_present_intervals FROM sleep_records`;
    await pruneMetrics(client, retentionCutoffs(now, null, age));
    assert.deepEqual(await client.$queryRaw `SELECT id, side, entered_bed_at, left_bed_at, sleep_period_seconds,
    times_exited_bed, present_intervals, not_present_intervals FROM sleep_records`, sleeps);
    await client.$executeRaw `INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES ('right', ${second}, 61, 51, 15)`;
    assert.deepEqual(await client.$queryRaw `SELECT side, heart_rate, hrv, breathing_rate FROM vitals`, [{ side: 'right', heart_rate: 61, hrv: 51, breathing_rate: 15 }]);
    assert.equal((await client.$queryRaw `SELECT * FROM movement`).length, 1);
});
test('the recent-night floor counts local wake dates rather than multiple recordings on one date', async () => {
    const oldest = Date.parse('2026-08-01T04:00:00Z') / 1000;
    const first = Date.parse('2026-08-10T04:00:00Z') / 1000;
    const next = Date.parse('2026-08-11T04:00:00Z') / 1000;
    // Both later recordings wake on August 11 in Los Angeles, despite different UTC dates.
    await night('left', oldest, oldest + 3600);
    await night('left', first, first + 3600);
    await night('left', next, next + 4 * 3600);
    await night('left', next + 22 * 3600, next + 23 * 3600);
    for (const timestamp of [oldest, first, next, next + 22 * 3600]) {
        await client.vitals.create({ data: { side: 'left', timestamp } });
    }
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 1, settings.data.features, 'America/Los_Angeles'))).vitals, 1);
    assert.deepEqual(await timestamps(), [first, next, next + 22 * 3600]);
});
test('larger ranges combine saved nights by counts and do not double-count surviving detail', async () => {
    await recentNights();
    const start = second - 100 * day;
    await night('left', start);
    await night('left', start + day);
    await client.vitals.createMany({ data: [
            { side: 'left', timestamp: start, heart_rate: 50 },
            { side: 'left', timestamp: start + 60, heart_rate: 50 },
            { side: 'left', timestamp: start + day, heart_rate: 80 },
        ] });
    const range = { side: 'left', start, end: second };
    const before = await readVitalsSummary(client, range, false);
    assert.equal(before.avgHeartRate, 60);
    await pruneMetrics(client, retentionCutoffs(now, null, age));
    assert.deepEqual(await readVitalsSummary(client, range, false), before);
});
test('upgrading a populated legacy database keeps old-reader results and healthy-disk history', async () => {
    const legacy = makeClient('legacy');
    const migrations = readdirSync('prisma/migrations').filter(name => /^\d/.test(name)).sort();
    const apply = (name) => applyMigration(legacy, 'prisma/migrations', name);
    try {
        for (const name of migrations.slice(0, -1))
            await apply(name);
        await legacy.$executeRawUnsafe(`INSERT INTO sleep_records
      (side, entered_bed_at, left_bed_at, sleep_period_seconds, times_exited_bed, present_intervals, not_present_intervals)
      VALUES ('left', 1700000000, 1700028800, 28800, 1, '[]', '[]')`);
        await legacy.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
      VALUES ('left', 1700000000, 60, 50, 14)`);
        const beforeVitals = await legacy.$queryRaw `SELECT id, side, timestamp, heart_rate, hrv, breathing_rate FROM vitals`;
        const beforeSleeps = await legacy.sleep_records.findMany();
        await apply(migrations[migrations.length - 1]);
        await pruneMetrics(legacy, retentionCutoffs(now, 200 * 1024 * 1024, settings.data.features));
        assert.deepEqual(await legacy.$queryRaw `SELECT id, side, timestamp, heart_rate, hrv, breathing_rate FROM vitals`, beforeVitals);
        assert.deepEqual(await legacy.sleep_records.findMany(), beforeSleeps);
        assert.equal(await legacy.vitals_summaries.count(), 0);
    }
    finally {
        await legacy.$disconnect();
    }
});
test('a night crossing the detail floor keeps its older prefix', async () => {
    const start = second - 4 * day;
    await night('left', start, second - day);
    await night('left', second - 12 * 3600);
    await night('left', second - 10 * day);
    for (const timestamp of [second - 10 * day, start, second - 2 * day]) {
        await client.vitals.create({ data: { side: 'left', timestamp } });
    }
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, 1))).vitals, 1);
    assert.deepEqual(await timestamps(), [start, second - 2 * day]);
});
test('one run is bounded when reusable pages stay below the target', async () => {
    for (let offset = 0; offset < 100001; offset += 5000) {
        const length = Math.min(5000, 100001 - offset);
        await client.vitals.createMany({ data: Array.from({ length }, (_, index) => ({
                side: 'left', timestamp: second - 100 * day - offset - index,
            })) });
    }
    const result = await pruneMetrics(client, retentionCutoffs(now, 1));
    assert.equal(result.vitals, 100000);
    assert.equal(result.batches, 100);
    assert.equal(result.stopped, 'batch limit');
    assert.equal(await client.vitals.count(), 1);
});
test('a low-disk batch completes with 864000 vitals and 600 nights using the side index', async (context) => {
    const start = second - 300 * day;
    for (const side of ['left', 'right']) {
        await client.$executeRaw `WITH RECURSIVE samples(offset) AS (
      SELECT 0 UNION ALL SELECT offset + 1 FROM samples WHERE offset < 431999
    ) INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
      SELECT ${side}, ${start} + offset * 60, 60, 50, 14 FROM samples`;
        await client.sleep_records.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
                side, entered_bed_at: start + index * day, left_bed_at: start + index * day + 8 * 3600,
                sleep_period_seconds: 8 * 3600, times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
            })) });
    }
    const batches = [];
    client.$on('query', event => {
        if (/^\s*SELECT id, side, timestamp FROM vitals/.test(event.query))
            batches.push(event);
    });
    let checks = 0;
    const result = await pruneMetrics(client, retentionCutoffs(now, 1), async () => ++checks === 1 ? 1 : 200 * 1024 * 1024);
    assert.equal(result.vitals, 1000);
    assert.equal(result.batches, 1);
    assert.equal(await client.vitals.count(), 863000);
    assert.equal(await client.sleep_records.count(), 600);
    assert.equal(await client.vitals_summaries.count(), 2);
    assert.equal(batches.length, 2);
    for (const batch of batches) {
        const parameters = JSON.parse(batch.params);
        const plan = await client.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${batch.query}`, ...parameters);
        context.diagnostic(plan.map(row => row.detail).join('; '));
        assert.ok(plan.some(row => /USING COVERING INDEX vitals_side_timestamp_key/.test(row.detail)), JSON.stringify(plan.map(row => row.detail)));
        assert.ok(plan.every(row => !/CORRELATED|TEMP B-TREE/.test(row.detail)), JSON.stringify(plan.map(row => row.detail)));
    }
});
test('the summary migration adds no unused timestamp index', async () => {
    const indexes = await client.$queryRaw `PRAGMA index_list(vitals)`;
    assert.ok(!indexes.some(row => row.name === 'vitals_timestamp_idx'));
});
test('age pruning keeps a night crossing 30 days with its minute of boundary slack', async () => {
    await recentNights();
    const floor = second - 30 * day;
    const start = floor - 3600;
    await night('left', start, floor + 3600);
    const kept = [start - 60, start, floor, floor + 3600 + 60];
    await client.vitals.createMany({ data: [start - 61, ...kept].map(timestamp => ({ side: 'left', timestamp })) });
    assert.equal((await pruneMetrics(client, retentionCutoffs(now, null, age))).vitals, 1);
    assert.deepEqual(await timestamps(), kept);
});
//# sourceMappingURL=metricsRetention.test.js.map