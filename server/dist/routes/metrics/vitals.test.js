import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigration } from '../../testing/migrations.js';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstand-vitals-'));
fs.mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/vitals.db`;
const serverRoot = path.resolve(import.meta.dirname, '../../..');
const { prisma } = await import('../../db/prisma.js');
for (const name of fs.readdirSync(path.join(serverRoot, 'prisma/migrations')).filter(name => /^\d/.test(name)).sort()) {
    await applyMigration(prisma, path.join(serverRoot, 'prisma/migrations'), name);
}
const { default: settingsDB } = await import('../../db/settings.js');
const { default: router } = await import('./vitals.js');
const base = 'http://localhost';
async function request(url) {
    const parsed = new URL(url);
    const route = router.stack.find(layer => layer.route?.path === parsed.pathname)?.route;
    assert.ok(route);
    const handler = route.stack[0].handle;
    let status = 200;
    let body;
    const response = { status(code) { status = code; return response; }, json(value) { body = value; } };
    await handler({ query: Object.fromEntries(parsed.searchParams) }, response, () => assert.fail('Unexpected next'));
    return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
after(async () => {
    await prisma.$disconnect();
    fs.rmSync(folder, { recursive: true, force: true });
});
const NIGHT = 1790600400;
const LATER = NIGHT + 7200;
await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES
  ('left', ${NIGHT}, 61, 45, 13), ('left', ${NIGHT + 60}, 63, 0, 0)`);
await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate,
  hr_quality, rmssd, sdnn, hrv_coverage, resp_rate, resp_quality, estimator) VALUES
  ('left', ${NIGHT + 120}, 104, 38, 16, 0.81, 41.3, 38.4, 0.82, 16.2, 0.9, 2),
  ('left', ${NIGHT + 180}, 60, 0, 0, NULL, NULL, NULL, 0.4, NULL, NULL, 2)`);
// A night recorded with the toggle off, read later with it on.
await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES
  ('right', ${NIGHT}, 58, 50, 12), ('right', ${NIGHT + 60}, 62, 0, 0)`);
// Later on the right side: new-estimator rows whose breathing never passed its
// check, beside a legacy row that has one.
await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES
  ('right', ${LATER}, 60, 0, 14)`);
await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate,
  hr_quality, rmssd, sdnn, hrv_coverage, resp_rate, resp_quality, estimator) VALUES
  ('right', ${LATER + 60}, 59, 0, 0, 0.8, NULL, NULL, 0.1, NULL, NULL, 2),
  ('right', ${LATER + 120}, 61, 0, 0, 0.8, NULL, NULL, 0.1, NULL, NULL, 2)`);
const range = (side, from) => new URLSearchParams({
    side,
    startTime: new Date(from * 1000).toISOString(),
    endTime: new Date((from + 3600) * 1000).toISOString(),
}).toString();
const get = async (route, side = 'left', from = NIGHT) => (await request(`${base}${route}?${range(side, from)}`)).text();
const setV2 = (on) => { settingsDB.data.features.biometricsV2 = on; };
describe('vitals with new sleep tracking off', () => {
    it('sends the rows exactly as releases before the new columns did', async () => {
        setV2(false);
        assert.equal(await get('/vitals'), JSON.stringify([
            { id: 1, side: 'left', timestamp: NIGHT, heart_rate: 61, hrv: 45, breathing_rate: 13 },
            { id: 2, side: 'left', timestamp: NIGHT + 60, heart_rate: 63, hrv: 0, breathing_rate: 0 },
            { id: 3, side: 'left', timestamp: NIGHT + 120, heart_rate: 104, hrv: 38, breathing_rate: 16 },
            { id: 4, side: 'left', timestamp: NIGHT + 180, heart_rate: 60, hrv: 0, breathing_rate: 0 },
        ]));
    });
    it('summarizes with the legacy filters', async () => {
        setV2(false);
        assert.equal(await get('/vitals/summary'), JSON.stringify({
            avgHeartRate: 72, minHeartRate: 60, maxHeartRate: 104, avgHRV: 42, avgBreathingRate: 15,
        }));
    });
});
describe('vitals with new sleep tracking on', () => {
    it('adds the new fields to every row', async () => {
        setV2(true);
        const rows = JSON.parse(await get('/vitals'));
        assert.deepEqual(Object.keys(rows[0]), [
            'id', 'side', 'timestamp', 'heart_rate', 'hrv', 'breathing_rate',
            'hr_quality', 'rmssd', 'sdnn', 'hrv_coverage', 'resp_rate', 'resp_quality', 'estimator',
        ]);
        assert.equal(rows[0].rmssd, null);
        assert.equal(rows[2].rmssd, 41.3);
        assert.equal(rows[2].resp_rate, 16.2);
        assert.equal(rows[2].estimator, 2);
    });
    it('summarizes breathing from the rows that have it and keeps the legacy HRV', async () => {
        setV2(true);
        assert.equal(await get('/vitals/summary'), JSON.stringify({
            avgHeartRate: 72, minHeartRate: 60, maxHeartRate: 104, avgHRV: 42, avgBreathingRate: 16,
        }));
    });
    it('shows no breathing for a night recorded without the new estimates', async () => {
        setV2(true);
        assert.equal(await get('/vitals/summary', 'right'), JSON.stringify({
            avgHeartRate: 60, minHeartRate: 58, maxHeartRate: 62, avgHRV: 50, avgBreathingRate: 0,
        }));
    });
    it('does not fall back to the legacy breathing column when new rows have no breathing', async () => {
        setV2(true);
        assert.equal(await get('/vitals/summary', 'right', LATER), JSON.stringify({
            avgHeartRate: 60, minHeartRate: 59, maxHeartRate: 61, avgHRV: 0, avgBreathingRate: 0,
        }));
    });
});
it('retains both estimators and nightly summaries after detail pruning', async () => {
    const { pruneMetrics, retentionCutoffs } = await import('../../jobs/metricsRetention.js');
    await prisma.sleep_records.create({ data: {
            side: 'left', entered_bed_at: NIGHT, left_bed_at: NIGHT + 3600,
            sleep_period_seconds: 3600, times_exited_bed: 1, present_intervals: '[]', not_present_intervals: '[]',
        } });
    setV2(false);
    const legacy = await get('/vitals/summary');
    setV2(true);
    const newer = await get('/vitals/summary');
    const { loadStageSummary } = await import('./sleepStages.js');
    const stages = await loadStageSummary('left', NIGHT, NIGHT + 3600);
    for (const start of [1798704000, 1798790400]) {
        await prisma.sleep_records.create({ data: {
                side: 'left', entered_bed_at: start, left_bed_at: start + 3600,
                sleep_period_seconds: 3600, times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
            } });
    }
    await pruneMetrics(prisma, retentionCutoffs(new Date('2027-01-01T12:00:00Z'), null, { metricsRetention: true, metricsLowDiskProtection: false }));
    setV2(false);
    const { retained, ...values } = JSON.parse(await get('/vitals/summary'));
    assert.deepEqual(values, JSON.parse(legacy));
    assert.deepEqual(retained, { avgHeartRate: 72, avgBreathingRate: 16 });
    setV2(true);
    const { retained: retainedNewer, ...afterNewer } = JSON.parse(await get('/vitals/summary'));
    assert.deepEqual(afterNewer, JSON.parse(newer));
    assert.deepEqual(retainedNewer, retained);
    assert.deepEqual(await loadStageSummary('left', NIGHT, NIGHT + 3600), stages);
});
it('preserves the historical stage summary API when its vitals detail is pruned', async () => {
    const { loadStageSummary } = await import('./sleepStages.js');
    const { pruneMetrics, retentionCutoffs } = await import('../../jobs/metricsRetention.js');
    const start = NIGHT - 100 * 86400;
    await prisma.sleep_records.create({ data: {
            side: 'right', entered_bed_at: start, left_bed_at: start + 8 * 3600,
            sleep_period_seconds: 8 * 3600, times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
        } });
    for (const recent of [1798704000, 1798790400]) {
        await prisma.sleep_records.create({ data: {
                side: 'right', entered_bed_at: recent, left_bed_at: recent + 3600,
                sleep_period_seconds: 3600, times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
            } });
    }
    await prisma.vitals.createMany({ data: Array.from({ length: 96 }, (_, index) => ({
            side: 'right', timestamp: start + index * 300, heart_rate: 60, hrv: 0, breathing_rate: 13,
        })) });
    const before = await loadStageSummary('right', start, start + 8 * 3600);
    assert.ok(before.totals.deep > 0);
    await pruneMetrics(prisma, retentionCutoffs(new Date('2027-01-01T12:00:00Z'), null, { metricsRetention: true, metricsLowDiskProtection: false }));
    assert.equal(await prisma.vitals.count({ where: { side: 'right', timestamp: { gte: start, lte: start + 8 * 3600 } } }), 0);
    assert.deepEqual(await loadStageSummary('right', start, start + 8 * 3600), before);
});
it('defaults summaries to 90 days only when both bounds are absent', async () => {
    const now = Date.UTC(2026, 9, 8, 12) / 1000;
    const day = 86400;
    setV2(false);
    await prisma.vitals.createMany({ data: [
            { side: 'left', timestamp: now - 90 * day - 1, heart_rate: 20, hrv: 40, breathing_rate: 12 },
            { side: 'left', timestamp: now - 90 * day, heart_rate: 80, hrv: 60, breathing_rate: 16 },
            { side: 'left', timestamp: now, heart_rate: 80, hrv: 60, breathing_rate: 16 },
            { side: 'left', timestamp: now + 1, heart_rate: 140, hrv: 80, breathing_rate: 18 },
        ] });
    const clock = mock.method(Date, 'now', () => now * 1000);
    try {
        const expected = { avgHeartRate: 75, minHeartRate: 60, maxHeartRate: 104, avgHRV: 51, avgBreathingRate: 15 };
        const response = await request(`${base}/vitals/summary?side=left`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expected);
        const boundedQuery = new URLSearchParams({ side: 'left',
            startTime: new Date((now - 100 * day) * 1000).toISOString(), endTime: new Date(now * 1000).toISOString() });
        const bounded = await request(`${base}/vitals/summary?${boundedQuery}`);
        assert.deepEqual(await bounded.json(), {
            avgHeartRate: 67, minHeartRate: 20, maxHeartRate: 104, avgHRV: 49, avgBreathingRate: 15,
        });
        const startOnly = await request(`${base}/vitals/summary?side=left&startTime=${new Date(now * 1000).toISOString()}`);
        assert.deepEqual(await startOnly.json(), {
            avgHeartRate: 110, minHeartRate: 80, maxHeartRate: 140, avgHRV: 70, avgBreathingRate: 17,
        });
        const endOnly = await request(`${base}/vitals/summary?side=left&endTime=${new Date((now - 90 * day - 1) * 1000).toISOString()}`);
        assert.deepEqual(await endOnly.json(), {
            avgHeartRate: 20, minHeartRate: 20, maxHeartRate: 20, avgHRV: 40, avgBreathingRate: 12,
        });
    }
    finally {
        clock.mock.restore();
    }
});
it('summarizes 864000 rows and 270 retained nights in a long bounded range', async () => {
    await prisma.vitals.deleteMany({ where: { side: 'right' } });
    await prisma.vitals_summaries.deleteMany({ where: { side: 'right' } });
    const start = Date.UTC(2025, 0, 1) / 1000;
    const end = start + 600 * 86400 - 60;
    await prisma.$executeRaw `WITH RECURSIVE samples(offset) AS (
    SELECT 0 UNION ALL SELECT offset + 1 FROM samples WHERE offset < 863999
  ) INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate, resp_rate)
    SELECT 'right', ${start} + offset * 60, 60, 50, 14, 15 FROM samples`;
    const aggregate = (value) => ({ sum: value * 480, count: 480, min: value, max: value });
    const payload = JSON.stringify({ version: 1, stages: null,
        score: { minInteriorHeartRate: 60, edges: [] }, stats: {
            heart: aggregate(60), positiveHeart: aggregate(60), hrv: aggregate(50),
            breathing: aggregate(14), resp: aggregate(15), positiveResp: aggregate(15),
        } });
    await prisma.vitals_summaries.createMany({ data: Array.from({ length: 270 }, (_, index) => ({
            side: 'right', entered_bed_at: start + index * 86400, left_bed_at: start + index * 86400 + 8 * 3600 - 60, payload,
        })) });
    const query = `side=right&startTime=${new Date(start * 1000).toISOString()}&endTime=${new Date(end * 1000).toISOString()}`;
    for (const enabled of [false, true]) {
        setV2(enabled);
        const response = await request(`${base}/vitals/summary?${query}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            avgHeartRate: 60, minHeartRate: 60, maxHeartRate: 60, avgHRV: 50, avgBreathingRate: enabled ? 15 : 14,
        });
    }
});
//# sourceMappingURL=vitals.test.js.map