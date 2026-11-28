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
const { setRebuilding } = await import('../../jobs/rebuildState.js');
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
  it('answers null for an away side, and for a paused side with only weekly alarms', async () => {
    await reset();
    nodeSchedule.scheduleJob('left-one-off-alarm', inHours(2), () => undefined);
    nodeSchedule.scheduleJob('right-monday-06:30-0-alarm', inHours(2), () => undefined);
    nodeSchedule.scheduleJob('rhythm-right-2026-10-05-alarm-0630-0', inHours(3), () => undefined);
    settingsDB.data.left.awayMode = true;
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: '' };
    const response = await request('GET', '/api/alarms/next');
    assert.deepEqual(response.body, { left: null, right: null });
  });
  it('gives the one-time alarm of a paused side, since the pause does not stop it', async () => {
    await reset();
    const oneOff = inHours(5);
    nodeSchedule.scheduleJob('right-monday-06:30-0-alarm', inHours(2), () => undefined);
    nodeSchedule.scheduleJob('right-one-off-alarm', oneOff, () => undefined);
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: '' };
    const response = await request('GET', '/api/alarms/next');
    assert.deepEqual(response.body, { left: null, right: { at: oneOff.toISOString() } });
  });
  it('gives the first run of a weekly alarm after a timed pause ends, and still null when away', async () => {
    await reset();
    const due = inHours(2);
    due.setSeconds(0, 0);
    const weekly = () => {
      const rule = new nodeSchedule.RecurrenceRule();
      rule.dayOfWeek = due.getDay();
      rule.hour = due.getHours();
      rule.minute = due.getMinutes();
      return rule;
    };
    nodeSchedule.scheduleJob('left-monday-06:30-0-alarm', weekly(), () => undefined);
    nodeSchedule.scheduleJob('right-monday-06:30-0-alarm', weekly(), () => undefined);
    settingsDB.data.left.awayMode = true;
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: inHours(3).toISOString() };
    const nextWeek = new Date(due);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const response = await request('GET', '/api/alarms/next');
    assert.deepEqual(response.body, { left: null, right: { at: nextWeek.toISOString() } });
  });
  it('waits for a job rebuild in progress before answering', async () => {
    await reset();
    const soon = inHours(2);
    setRebuilding(true);
    let answered = false;
    const pending = request('GET', '/api/alarms/next').then(response => { answered = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(answered, false);
    nodeSchedule.scheduleJob('left-monday-06:30-0-alarm', soon, () => undefined);
    setRebuilding(false);
    assert.deepEqual((await pending).body, { left: { at: soon.toISOString() }, right: null });
  });
});
