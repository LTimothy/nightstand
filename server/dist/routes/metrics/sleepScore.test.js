import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-score-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/score.db`;
const serverRoot = path.resolve(import.meta.dirname, '../../..');
execFileSync(process.execPath, [
    path.join(serverRoot, 'node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--schema', path.join(serverRoot, 'prisma/schema.prisma'),
], { env: process.env, stdio: 'pipe', timeout: 60_000 });
const { durationComponent, default: router } = await import('./sleepScore.js');
const { prisma } = await import('../../db/prisma.js');
const { default: settingsDB } = await import('../../db/settings.js');
const { default: servicesDB } = await import('../../db/services.js');
const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
    rmSync(folder, { recursive: true, force: true });
});
const IN_BED_SECONDS = 5 * 3600 + 46 * 60;
test('duration is scored on time in bed', () => {
    const component = durationComponent(IN_BED_SECONDS);
    assert.equal(component.value, '5h 46m in bed');
    assert.equal(component.score, 78);
});
test('whole hours drop the minutes like the app does', () => {
    const component = durationComponent(8 * 3600);
    assert.equal(component.value, '8h in bed');
    assert.equal(component.score, 100);
});
async function scoreFor(side, from) {
    await settingsDB.read();
    settingsDB.data.features.sleepScore = true;
    await settingsDB.write();
    await servicesDB.read();
    servicesDB.data.biometrics.enabled = true;
    await servicesDB.write();
    const query = new URLSearchParams({
        side,
        startTime: new Date(from * 1000).toISOString(),
        endTime: new Date((from + 3600) * 1000).toISOString(),
    });
    return (await fetch(`${base}/sleep-score?${query}`)).json();
}
test('never uses HRV, whatever the stored values', async () => {
    const night = 1790600400;
    await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES
    ('left', ${night}, 60, 60, 13), ('left', ${night + 60}, 58, 70, 13), ('left', ${night + 120}, 59, 80, 13),
    ('right', ${night}, 60, 0, 13), ('right', ${night + 60}, 58, 0, 13), ('right', ${night + 120}, 59, 0, 13)`);
    const withHrv = await scoreFor('left', night);
    const withoutHrv = await scoreFor('right', night);
    assert.deepEqual(withHrv.components.hrv, { score: 0, weight: 0.15, value: '', available: false });
    assert.deepEqual(withoutHrv.components.hrv, withHrv.components.hrv);
    assert.equal(withHrv.score, withoutHrv.score);
});
async function seedNight(side, from, exits, heartRates) {
    await prisma.$executeRawUnsafe(`INSERT INTO sleep_records
    (side, entered_bed_at, left_bed_at, sleep_period_seconds, times_exited_bed, present_intervals, not_present_intervals)
    VALUES ('${side}', ${from - 60}, ${from + 3660}, 3720, ${exits}, '[]', '[]')`);
    const rows = heartRates.map((bpm, index) => `('${side}', ${from + index * 60}, ${bpm}, 0, 13)`).join(', ');
    await prisma.$executeRawUnsafe(`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES ${rows}`);
}
test('counts trips out of bed in words and leaves the lowest heart rate out of the score', async () => {
    const night = 1790700000;
    await seedNight('left', night, 1, [52, 60, 64]);
    await seedNight('right', night, 1, [90, 95, 99]);
    const low = await scoreFor('left', night);
    const high = await scoreFor('right', night);
    assert.equal(low.components.continuity.value, '1 trip out of bed');
    assert.equal(low.components.restingHr.available, false);
    assert.equal(low.components.restingHr.value, '52 bpm');
    assert.equal(high.components.restingHr.value, '90 bpm');
    assert.equal(low.components.restingHr.score, 0);
    assert.equal(low.score, high.score);
    const { duration, continuity } = low.components;
    assert.equal(low.score, Math.round((duration.score * 0.4 + continuity.score * 0.3) / 0.7));
});
test('says 0 trips and plural trips out of bed', async () => {
    const night = 1790800000;
    await seedNight('left', night, 0, [60, 61]);
    await seedNight('right', night, 3, [60, 61]);
    assert.equal((await scoreFor('left', night)).components.continuity.value, '0 trips out of bed');
    assert.equal((await scoreFor('right', night)).components.continuity.value, '3 trips out of bed');
});
test('leaves the lowest heart rate blank when the night has no estimate', async () => {
    const night = 1790900000;
    await seedNight('left', night, 0, [0, 0]);
    const response = await scoreFor('left', night);
    assert.equal(response.components.restingHr.available, false);
    assert.equal(response.components.restingHr.value, '');
});
test('skips failed-estimate minutes when finding the lowest heart rate', async () => {
    const night = 1791000000;
    await seedNight('left', night, 0, [0, 55, 61]);
    assert.equal((await scoreFor('left', night)).components.restingHr.value, '55 bpm');
});
test('the score route reports time in bed for a night with plenty of heart readings', async () => {
    const night = 1791100000;
    await seedNight('left', night, 0, Array.from({ length: 60 }, (_, index) => 55 + index % 7));
    const response = await scoreFor('left', night);
    assert.equal(response.components.duration.value, '1h 2m in bed');
});
test('nightly score and every component stay identical after detail pruning', async () => {
    const { pruneMetrics, retentionCutoffs } = await import('../../jobs/metricsRetention.js');
    const night = 1750000000;
    await seedNight('left', night, 2, [0, 52, 64]);
    await prisma.vitals.create({ data: { side: 'left', timestamp: night - 60, heart_rate: 40 } });
    const before = await scoreFor('left', night);
    const sleeps = await prisma.sleep_records.findMany();
    await pruneMetrics(prisma, retentionCutoffs(new Date('2027-01-01T12:00:00Z'), null, { metricsRetention: true, metricsLowDiskProtection: false }));
    assert.equal(await prisma.vitals.count({ where: { side: 'left', timestamp: { gte: night, lte: night + 3600 } } }), 0);
    assert.deepEqual(await scoreFor('left', night), before);
    assert.deepEqual(await prisma.sleep_records.findMany(), sleeps);
});
//# sourceMappingURL=sleepScore.test.js.map