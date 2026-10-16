import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-settings-resume-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

// A resume that waits on the Pod for as long as the test runs.
const resumes: string[] = [];
const releases: Array<() => void> = [];
mock.module(new URL('../../jobs/resumeSchedule.js', import.meta.url).href, {
  namedExports: {
    resumeSchedule: (side: string) => {
      resumes.push(side);
      return new Promise<void>(resolve => releases.push(resolve));
    },
  },
});

const { default: router } = await import('./settings.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings`;
after(async () => {
  releases.forEach(release => release());
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

const post = (body: unknown) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
});

it('answers Resume schedule without waiting for the side to come on', async () => {
  assert.equal((await post({ left: { scheduleOverrides: { pause: { active: true, expiresAt: '' } } } })).status, 200);
  const response = await post({ left: { scheduleOverrides: { pause: { active: false, expiresAt: '' } } } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).left.scheduleOverrides.pause, { active: false, expiresAt: '' });
  assert.deepEqual(resumes, ['left']);
});
