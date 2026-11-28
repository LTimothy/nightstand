import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import nodeSchedule from 'node-schedule';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-missed-alarms-route-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

const ledger = await import('../../jobs/alarmLedger.js');
const { default: settingsDB } = await import('../../db/settings.js');
const { default: router } = await import('./missedAlarms.js');
const app = express();
app.use(express.json());
app.use('/api/', router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const request = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

before(() => { ledger.startAlarmLedger(new Date()); });
after(async () => {
  ledger.resetAlarmLedgerForTests();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(folder, { recursive: true, force: true });
});

describe('missed alarm routes', () => {
  it('lists missed alarms', async () => {
    ledger.noteMissedAlarm('left', new Date(Date.now() - 60_000), 'late');
    const response = await request('GET', '/api/alarms/missed');
    assert.equal(response.status, 200);
    assert.equal(response.body.missed.length, 1);
    assert.equal(response.body.missed[0].reason, 'late');
  });
  it('dismisses by id and rejects other shapes', async () => {
    const [item] = ledger.listMissedAlarms();
    assert.equal((await request('POST', '/api/alarms/missed/dismiss', { ids: [item.id] })).status, 204);
    assert.equal(ledger.listMissedAlarms().length, 0);
    assert.equal((await request('POST', '/api/alarms/missed/dismiss', { ids: 'x' })).status, 400);
    assert.equal((await request('POST', '/api/alarms/missed/dismiss', { ids: [], extra: 1 })).status, 400);
  });
});

describe('next alarm route', () => {
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const reset = async () => {
    Object.keys(nodeSchedule.scheduledJobs).forEach(name => nodeSchedule.cancelJob(name));
    await settingsDB.read();
    for (const side of ['left', 'right'] as const) {
      settingsDB.data[side].awayMode = false;
      settingsDB.data[side].scheduleOverrides.pause = { active: false, expiresAt: '' };
    }
  };
  after(reset);

  it('answers null for both sides without alarm jobs', async () => {
    await reset();
    nodeSchedule.scheduleJob('left-monday-21:00-power-on', inHours(1), () => undefined);
    const response = await request('GET', '/api/alarms/next');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { left: null, right: null });
  });
  it('gives the earliest alarm of a side', async () => {
    await reset();
    const soon = inHours(2);
    nodeSchedule.scheduleJob('left-one-off-alarm', inHours(30), () => undefined);
    nodeSchedule.scheduleJob('left-monday-06:30-0-alarm', soon, () => undefined);
    const response = await request('GET', '/api/alarms/next');
    assert.deepEqual(response.body, { left: { at: soon.toISOString() }, right: null });
  });
  it('answers null for an away side and a paused side', async () => {
    await reset();
    nodeSchedule.scheduleJob('left-one-off-alarm', inHours(2), () => undefined);
    nodeSchedule.scheduleJob('right-one-off-alarm', inHours(2), () => undefined);
    settingsDB.data.left.awayMode = true;
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: '' };
    const response = await request('GET', '/api/alarms/next');
    assert.deepEqual(response.body, { left: null, right: null });
  });
});
