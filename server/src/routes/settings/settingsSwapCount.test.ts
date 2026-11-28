import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-settings-swap-count-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

const { setSideSwaps } = await import('../../db/sideSwaps.js');
const { default: router } = await import('./settings.js');
const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/swap-count`;
after(async () => {
  setSideSwaps([]);
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

it('counts the swaps, so each phone can tell whether its selected side changed hands', async () => {
  setSideSwaps([]);
  assert.deepEqual(await (await fetch(url)).json(), { count: 0 });
  setSideSwaps([100, 200, 300]);
  assert.deepEqual(await (await fetch(url)).json(), { count: 3 });
});
