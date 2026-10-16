import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { applyMigration } from '../../testing/migrations.js';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nightstand-sleep-summaries-'));
fs.mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.DATABASE_URL = `file:${folder}/sleep.db`;
const serverRoot = path.resolve(import.meta.dirname, '../../..');
const { prisma } = await import('../../db/prisma.js');
for (const name of fs.readdirSync(path.join(serverRoot, 'prisma/migrations')).filter(name => /^\d/.test(name)).sort()) {
  await applyMigration(prisma, path.join(serverRoot, 'prisma/migrations'), name);
}
const { default: router } = await import('./sleep.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sleep`;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
});

const NIGHT = 1790600400;
const HOURS_8 = 8 * 3600;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const send = (method: string, id: number, body?: unknown) => fetch(`${base}/${id}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const night = (start: number, end = start + HOURS_8) => prisma.sleep_records.create({ data: {
  side: 'left', entered_bed_at: start, left_bed_at: end, sleep_period_seconds: end - start,
  times_exited_bed: 0, present_intervals: '[]', not_present_intervals: '[]',
} });
const summary = (start: number, end = start + HOURS_8) => prisma.vitals_summaries.create({ data: {
  side: 'left', entered_bed_at: start, left_bed_at: end, payload: `{"night":${start}}`,
} });
const summaries = async () => (await prisma.vitals_summaries.findMany({ orderBy: { entered_bed_at: 'asc' } }))
  .map(row => [row.side, row.entered_bed_at, row.left_bed_at, row.payload]);

beforeEach(async () => {
  await prisma.vitals_summaries.deleteMany();
  await prisma.sleep_records.deleteMany();
});

it('moves a night\'s retained summary to its new bounds', async () => {
  const record = await night(NIGHT);
  await summary(NIGHT);
  const response = await send('PUT', record.id, { entered_bed_at: iso(NIGHT - 1800) });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(await summaries(), [['left', NIGHT - 1800, NIGHT + HOURS_8, `{"night":${NIGHT}}`]]);
});

it('moves the summary with a night moved to the other side', async () => {
  const record = await night(NIGHT);
  await summary(NIGHT);
  assert.equal((await send('PUT', record.id, { side: 'right' })).status, 200);
  assert.deepEqual(await summaries(), [['right', NIGHT, NIGHT + HOURS_8, `{"night":${NIGHT}}`]]);
});

it('refuses bounds that overlap another night on the side and changes nothing', async () => {
  const first = await night(NIGHT);
  await night(NIGHT + 86_400);
  await summary(NIGHT);
  const response = await send('PUT', first.id, { left_bed_at: iso(NIGHT + 86_400 + 3600) });
  assert.equal(response.status, 409);
  assert.equal((await prisma.sleep_records.findUnique({ where: { id: first.id } }))?.left_bed_at, NIGHT + HOURS_8);
  assert.deepEqual(await summaries(), [['left', NIGHT, NIGHT + HOURS_8, `{"night":${NIGHT}}`]]);
});

it('lets a night end the second the next one starts', async () => {
  const first = await night(NIGHT);
  await night(NIGHT + 86_400);
  assert.equal((await send('PUT', first.id, { left_bed_at: iso(NIGHT + 86_400) })).status, 200);
});

it('deleting a night removes its retained summary', async () => {
  const record = await night(NIGHT);
  await summary(NIGHT);
  await summary(NIGHT + 86_400);
  assert.equal((await send('DELETE', record.id)).status, 204);
  assert.deepEqual(await summaries(), [['left', NIGHT + 86_400, NIGHT + 86_400 + HOURS_8, `{"night":${NIGHT + 86_400}}`]]);
});

it('leaves a summary orphaned at the new key alone when the night has none of its own', async () => {
  const record = await night(NIGHT + 86_400);
  await summary(NIGHT);
  assert.equal((await send('PUT', record.id, { entered_bed_at: iso(NIGHT), left_bed_at: iso(NIGHT + HOURS_8) })).status, 200);
  assert.deepEqual(await summaries(), [['left', NIGHT, NIGHT + HOURS_8, `{"night":${NIGHT}}`]]);
});

it('replaces a summary at the new key with the one that moves with the night', async () => {
  const record = await night(NIGHT + 86_400);
  await summary(NIGHT + 86_400);
  await summary(NIGHT);
  assert.equal((await send('PUT', record.id, { entered_bed_at: iso(NIGHT), left_bed_at: iso(NIGHT + HOURS_8) })).status, 200);
  assert.deepEqual(await summaries(), [['left', NIGHT, NIGHT + HOURS_8, `{"night":${NIGHT + 86_400}}`]]);
});
