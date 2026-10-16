import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'movement-float-'));
const server = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/movement.db`;
execFileSync(process.execPath, [
    path.join(server, 'node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--schema', path.join(server, 'prisma/schema.prisma'),
], { env: process.env, stdio: 'pipe', timeout: 60_000 });
const { prisma } = await import('./prisma.js');
const { loadMovement } = await import('./movement.js');
const { default: movementRouter } = await import('../routes/metrics/movement.js');
const { loadStageSummary, summarizeStages, toStageVitals } = await import('../routes/metrics/sleepStages.js');
const { NIGHT_START, NIGHT_END, flappingNight } = await import('../routes/metrics/sleepNightFixture.js');
const T0 = 1790568000;
before(async () => {
    for (const [offset, value] of [[0, 0.4], [120, 1.7], [240, 74.99]]) {
        await prisma.$executeRaw `INSERT INTO movement (timestamp, side, total_movement) VALUES (${T0 + offset}, 'left', ${value})`;
    }
});
after(async () => {
    await prisma.$disconnect();
    fs.rmSync(folder, { recursive: true, force: true });
});
it('reads stored fractional movement as stored', async () => {
    const rows = await loadMovement('left', T0, T0 + 600);
    assert.deepEqual(rows.map((row) => row.total_movement), [0.4, 1.7, 74.99]);
});
it('keeps the /movement response in whole numbers, byte for byte', async () => {
    const app = express();
    app.use(movementRouter);
    const listener = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    try {
        const address = listener.address();
        assert.ok(address && typeof address !== 'string');
        const query = `side=left&startTime=${new Date(T0 * 1000).toISOString()}&endTime=${new Date((T0 + 600) * 1000).toISOString()}`;
        const response = await fetch(`http://127.0.0.1:${address.port}/movement?${query}`);
        assert.equal(await response.text(), `[{"id":1,"timestamp":${T0},"side":"left","total_movement":0},`
            + `{"id":2,"timestamp":${T0 + 120},"side":"left","total_movement":1},`
            + `{"id":3,"timestamp":${T0 + 240},"side":"left","total_movement":74}]`);
    }
    finally {
        listener.close();
    }
});
it('keeps the current sleep stages on whole-number movement', async () => {
    const { vitals, movements } = flappingNight();
    for (const row of vitals) {
        await prisma.$executeRaw `INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
      VALUES ('right', ${row.timestamp}, ${row.heart_rate}, ${row.hrv}, ${row.breathing_rate})`;
    }
    // Fractions everywhere, and one bucket at 50.9: above the absolute awake bar
    // only if the fraction survives.
    const stored = movements.map((row, bucket) => ({
        timestamp: row.timestamp,
        total_movement: bucket === 40 ? 50.9 : row.total_movement + 0.9,
    }));
    for (const row of stored) {
        await prisma.$executeRaw `INSERT INTO movement (timestamp, side, total_movement) VALUES (${row.timestamp}, 'right', ${row.total_movement})`;
    }
    const whole = stored.map((row) => ({ ...row, total_movement: Math.trunc(row.total_movement) }));
    const expected = summarizeStages(vitals.map(toStageVitals), whole, NIGHT_START, NIGHT_END);
    assert.deepEqual(await loadStageSummary('right', NIGHT_START, NIGHT_END), expected);
    // The fixture must exercise the difference, or the check above proves nothing.
    assert.notDeepEqual(summarizeStages(vitals.map(toStageVitals), stored, NIGHT_START, NIGHT_END), expected);
});
it('reads fractional movement written inside an optional transaction client', async () => {
    await prisma.$transaction(async (transaction) => {
        await transaction.movement.create({ data: { side: 'left', timestamp: T0 + 10000, total_movement: 50.9 } });
        const rows = await loadMovement('left', T0 + 10000, T0 + 10000, transaction);
        assert.deepEqual(rows.map(row => row.total_movement), [50.9]);
    });
});
//# sourceMappingURL=movement.test.js.map