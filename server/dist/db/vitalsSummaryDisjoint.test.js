import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-summary-disjoint-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
after(() => rmSync(folder, { recursive: true, force: true }));
const { readVitalsSummary } = await import('./vitalsSummary.js');
const aggregate = (sum, count) => ({ sum, count, min: count ? sum / count : null, max: count ? sum / count : null });
const payload = (heartAverage) => JSON.stringify({
    version: 1, stages: null, score: { minInteriorHeartRate: null, edges: [] },
    stats: { heart: aggregate(heartAverage * 10, 10), positiveHeart: aggregate(heartAverage * 10, 10), hrv: aggregate(0, 0),
        breathing: aggregate(0, 0), resp: aggregate(0, 0), positiveResp: aggregate(0, 0) },
});
const row = (id, start, end, heart) => ({ id, side: 'left', entered_bed_at: start, left_bed_at: end, payload: payload(heart) });
const average = async (saved) => {
    const client = {
        vitals_summaries: { findMany: async () => saved, findUnique: async () => null },
        vitals: {
            aggregate: async (args) => {
                const column = Object.keys(args._sum)[0];
                return { _sum: { [column]: 0 }, _count: { [column]: 0 }, _min: { [column]: null }, _max: { [column]: null } };
            },
            findMany: async () => [],
        },
        movement: { findMany: async () => [] },
    };
    const result = await readVitalsSummary(client, { side: 'left', start: 0, end: 100 }, false);
    return result.avgHeartRate;
};
it('counts every retained night that overlaps none it kept', async () => {
    // B overlaps A and is left out; C overlaps only B, so it counts.
    assert.equal(await average([row(1, 0, 10, 60), row(2, 9, 30, 100), row(3, 20, 40, 80)]), 70);
});
it('keeps both of two nights that only touch', async () => {
    assert.equal(await average([row(1, 0, 10, 60), row(2, 10, 30, 100)]), 80);
});
//# sourceMappingURL=vitalsSummaryDisjoint.test.js.map