import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstand-rows-range-'));
const server = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/rows.db`;
execFileSync(process.execPath, [
    path.join(server, 'node_modules/prisma/build/index.js'),
    'migrate', 'deploy', '--schema', path.join(server, 'prisma/schema.prisma'),
], { env: process.env, stdio: 'pipe', timeout: 60_000 });
const { prisma } = await import('../../db/prisma.js');
const { default: vitals } = await import('./vitals.js');
const { default: movement } = await import('./movement.js');
const { default: sleep } = await import('./sleep.js');
const now = Math.floor(Date.now() / 1000);
const recent = now - 3600;
const lastWeek = now - 5 * 86400;
const old = now - 30 * 86400;
const ancient = now - 120 * 86400;
const boundary = now - 90 * 86400;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const app = express();
app.use(vitals, movement, sleep);
const listener = app.listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}`;
before(async () => {
    for (const [entered, left] of [[ancient, ancient + 3600], [boundary - 3600, boundary + 3600], [old, old + 3600], [recent, now]]) {
        await prisma.sleep_records.create({ data: {
                side: 'left', entered_bed_at: entered, left_bed_at: left, sleep_period_seconds: left - entered,
                times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
            } });
    }
    for (const timestamp of [old, lastWeek, recent]) {
        await prisma.$executeRaw `INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate)
      VALUES ('left', ${timestamp}, 60, 50, 14)`;
        await prisma.$executeRaw `INSERT INTO movement (timestamp, side, total_movement) VALUES (${timestamp}, 'left', 3)`;
    }
});
test('sleep defaults to 90 days and includes records overlapping the boundary', async () => {
    for (const query of ['', 'side=left', 'junk=1']) {
        const response = await fetch(`${base}/sleep?${query}`);
        assert.equal(response.status, 200);
        const records = await response.json();
        assert.deepEqual(records.map(record => Date.parse(record.entered_bed_at) / 1000), [boundary - 3600, old, recent]);
    }
});
test('sleep preserves explicit ranges, including one-sided and long ranges', async () => {
    for (const query of [`startTime=${iso(ancient)}`, `endTime=${iso(now)}`, `startTime=${iso(ancient)}&endTime=${iso(now)}`]) {
        const response = await fetch(`${base}/sleep?${query}`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).length, 4);
    }
    assert.equal((await fetch(`${base}/sleep?side=middle`)).status, 400);
    assert.equal((await fetch(`${base}/sleep?startTime=invalid`)).status, 400);
});
after(async () => {
    await new Promise(resolve => listener.close(() => resolve()));
    await prisma.$disconnect();
    fs.rmSync(folder, { recursive: true, force: true });
});
const timestamps = async (route, query) => {
    const response = await fetch(`${base}${route}?${query}`);
    assert.equal(response.status, 200, `${route}?${query}`);
    return (await response.json()).map(row => row.timestamp);
};
test('vitals and movement without a range return the last day, not every row', async () => {
    for (const route of ['/vitals', '/movement']) {
        assert.deepEqual(await timestamps(route, ''), [recent], route);
        assert.deepEqual(await timestamps(route, 'side=left&junk=1'), [recent], route);
    }
});
test('vitals and movement answer a range within a week as before', async () => {
    for (const route of ['/vitals', '/movement']) {
        assert.deepEqual(await timestamps(route, `side=left&startTime=${iso(lastWeek)}&endTime=${iso(now)}`), [lastWeek, recent]);
        assert.deepEqual(await timestamps(route, `startTime=${iso(lastWeek)}`), [lastWeek, recent]);
        assert.deepEqual(await timestamps(route, `startTime=${iso(now)}&endTime=${iso(old)}`), []);
    }
});
test('vitals and movement refuse a range longer than a week', async () => {
    for (const route of ['/vitals', '/movement']) {
        for (const query of [`startTime=${iso(old)}&endTime=${iso(now)}`, `startTime=${iso(old)}`]) {
            const response = await fetch(`${base}${route}?${query}`);
            assert.equal(response.status, 400, `${route}?${query}`);
        }
    }
});
//# sourceMappingURL=rowsRange.test.js.map