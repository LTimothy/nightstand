import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstand-swap-metrics-'));
const server = path.resolve(import.meta.dirname, '../../..');
fs.mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/swap.db`;
execFileSync(process.execPath, [
  path.join(server, 'node_modules/prisma/build/index.js'),
  'migrate', 'deploy', '--schema', path.join(server, 'prisma/schema.prisma'),
], { env: process.env, stdio: 'pipe', timeout: 60_000 });

const { prisma } = await import('../../db/prisma.js');
const { setSideSwaps } = await import('../../db/sideSwaps.js');
const { parseNightQuery } = await import('./metricsQuery.js');
const { readVitalsSummary } = await import('../../db/vitalsSummary.js');
const { default: vitals } = await import('./vitals.js');
const { default: movement } = await import('./movement.js');
const { default: sleep } = await import('./sleep.js');

const now = Math.floor(Date.now() / 1000);
const swap = now - 2 * 86400;
const before = swap - 86400;
const later = swap + 3600;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const app = express();
app.use(vitals, movement, sleep);
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
after(async () => {
  setSideSwaps([]);
  await new Promise<void>(resolve => listener.close(() => resolve()));
  await prisma.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
});

for (const side of ['left', 'right']) {
  for (const at of [before, later]) {
    await prisma.sleep_records.create({ data: {
      side, entered_bed_at: at, left_bed_at: at + 1800, sleep_period_seconds: 1800,
      times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
    } });
    await prisma.$executeRaw`INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (${side}, ${at}, 60, 50, 14)`;
    await prisma.$executeRaw`INSERT INTO movement (timestamp, side, total_movement) VALUES (${at}, ${side}, 3)`;
  }
}

const sidesOf = async (url: string, time: 'entered_bed_at' | 'timestamp') => {
  const rows = await (await fetch(url)).json() as Array<Record<string, unknown>>;
  return rows.map(row => [row.side, time === 'entered_bed_at' ? Date.parse(row[time] as string) / 1000 : row[time]]);
};
const range = `startTime=${iso(before - 60)}&endTime=${iso(now)}`;

test('without a swap, a side reads only its own rows', async () => {
  setSideSwaps([]);
  assert.deepEqual(await sidesOf(`${base}/sleep?side=left&${range}`, 'entered_bed_at'), [['left', before], ['left', later]]);
  assert.deepEqual(await sidesOf(`${base}/vitals?side=left&${range}`, 'timestamp'), [['left', before], ['left', later]]);
});

test('after a swap, a side reads the earlier rows from the other side, each with its real side', async () => {
  setSideSwaps([swap]);
  assert.deepEqual(await sidesOf(`${base}/sleep?side=left&${range}`, 'entered_bed_at'), [['right', before], ['left', later]]);
  assert.deepEqual(await sidesOf(`${base}/vitals?side=left&${range}`, 'timestamp'), [['right', before], ['left', later]]);
  assert.deepEqual(await sidesOf(`${base}/movement?side=left&${range}`, 'timestamp'), [['right', before], ['left', later]]);
  assert.equal((await sidesOf(`${base}/sleep?${range}`, 'entered_bed_at')).length, 4);
});

test('a single night is read from the side that recorded it', () => {
  setSideSwaps([swap]);
  assert.equal(parseNightQuery({ side: 'left', startTime: iso(before), endTime: iso(before + 1800) })?.side, 'right');
  assert.equal(parseNightQuery({ side: 'left', startTime: iso(later), endTime: iso(later + 1800) })?.side, 'left');
});

test('a vitals summary of a night before the swap finds that night on the other side', async () => {
  setSideSwaps([swap]);
  const stats = { sum: 600, count: 10, min: 60, max: 60 };
  const empty = { sum: 0, count: 0, min: null, max: null };
  await prisma.vitals_summaries.create({ data: { side: 'right', entered_bed_at: before, left_bed_at: before + 1800,
    payload: JSON.stringify({ version: 1, stages: null, score: { minInteriorHeartRate: null, edges: [] },
      stats: { heart: stats, positiveHeart: stats, hrv: empty, breathing: empty, resp: empty, positiveResp: empty } }) } });
  const summary = await readVitalsSummary(prisma, { side: 'left', start: before, end: before + 1800 }, false);
  assert.equal(summary.retained?.avgHeartRate, 60);
});
