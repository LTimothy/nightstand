import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import moment from 'moment-timezone';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-presence-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { default: router } = await import('./presence.js');
const { default: eventBus } = await import('../../events/eventBus.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/presence`;
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

test('heartbeat freshness advances without resetting the presence transition', async (t) => {
  let now = Date.parse('2026-09-28T05:00:00Z');
  t.mock.method(moment, 'now', () => now);
  const post = async (present: boolean) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ left: { present } }) });
    return await response.json() as { left: { stateChangedAt?: string; lastUpdatedAt: string } };
  };
  const entry = await post(true);
  assert.equal(entry.left.stateChangedAt, '2026-09-28T05:00:00Z');
  now += 60_000;
  const heartbeat = await post(true);
  assert.equal(heartbeat.left.stateChangedAt, entry.left.stateChangedAt);
  assert.equal(moment(heartbeat.left.lastUpdatedAt).valueOf(), now);
  now += 60_000;
  const exit = await post(false);
  assert.equal(exit.left.stateChangedAt, '2026-09-28T05:02:00Z');
});

test('presence updates require a boolean observation instead of accepting an empty side', async () => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ left: {} }) });
  assert.equal(response.status, 400);
});

test('pushes presence on first observation and on change, not on a heartbeat', async () => {
  const seen: unknown[] = [];
  const stop = eventBus.subscribe('presence', env => seen.push(env.payload));
  const post = (present: boolean) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ right: { present } }) });
  await post(false); await post(false); await post(true); await post(true); await post(false);
  stop();
  assert.deepEqual(seen, [
    { side: 'right', present: false }, { side: 'right', present: true }, { side: 'right', present: false },
  ]);
});
