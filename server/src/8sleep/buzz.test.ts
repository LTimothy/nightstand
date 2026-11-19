import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
import schedule from 'node-schedule';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-buzz-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

type Send = { command: string; hex: string; notAfter: number | undefined };
const sends: Send[] = [];
let beforeQueue = () => {};
let release: Promise<void> | undefined;
let statusProbe = () => {};
const franken = {
  getDeviceStatus: async () => {
    statusProbe();
    return { left: { isOn: true }, right: { isOn: true }, hubVersion: 'Pod 5', coverVersion: 'Pod 5' };
  },
  callFunction: async (command: string, hex: string, notAfter?: number, beforeSend?: () => void) => {
    beforeQueue();
    await release;
    beforeSend?.();
    sends.push({ command, hex, notAfter });
  },
};
mock.module('./frankenServer.js', { namedExports: { connectFrankenWithin: async () => franken } });
const { BUZZ_POWER, buzz, resetBuzz } = await import('./buzz.js');
const { activeAlarms, setSnooze, forgetActiveAlarm } = await import('../jobs/activeAlarms.js');
const { alarmStarting, executeAlarm } = await import('../jobs/alarmScheduler.js');
const { setRebuilding } = await import('../jobs/rebuildState.js');
after(() => rmSync(folder, { recursive: true, force: true }));

const ring = { vibrationIntensity: 50, duration: 30, vibrationPattern: 'double' } as const;
const inSeconds = (s: number) => new Date(Date.now() + s * 1_000);

beforeEach(() => { resetBuzz(); sends.length = 0; beforeQueue = () => {}; release = undefined; statusProbe = () => {}; });
afterEach(() => {
  for (const name of Object.keys(schedule.scheduledJobs)) schedule.cancelJob(name);
  for (const side of ['left', 'right'] as const) forgetActiveAlarm(side);
  setRebuilding(false);
});

describe('buzz', () => {
  it('sends one short double pulse', async () => {
    assert.equal(await buzz('left'), true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].command, 'ALARM_LEFT');
    const payload = cbor.decodeFirstSync(Buffer.from(sends[0].hex, 'hex'));
    assert.deepEqual({ ...payload, tt: typeof payload.tt }, { pl: BUZZ_POWER, du: 1, pi: 'double', tt: 'number' });
  });

  it('skips while a ringing alarm is recorded', async () => {
    activeAlarms.set('left', ring);
    assert.equal(await buzz('left'), false);
    assert.equal(sends.length, 0);
  });

  it('skips while an alarm is snoozed', async () => {
    setSnooze('left', 60_000, () => {});
    assert.equal(await buzz('left'), false);
    assert.equal(sends.length, 0);
    forgetActiveAlarm('left');
  });

  it('skips while an alarm is starting', async () => {
    let busy = false;
    statusProbe = () => { busy = alarmStarting('left'); };
    await executeAlarm({ ...ring, side: 'left', force: true });
    assert.equal(busy, true);
    assert.equal(alarmStarting('left'), false);
  });

  it('skips when a one-time or Rhythms alarm is due within seconds', async () => {
    for (const name of ['left-one-off-alarm', 'rhythm-left-2026-11-20-alarm-0700-0']) {
      schedule.scheduleJob(name, inSeconds(5), () => {});
      assert.equal(await buzz('left'), false, name);
      schedule.cancelJob(name);
    }
    assert.equal(sends.length, 0);
  });

  it('waits out a schedule rebuild, then buzzes', async () => {
    setRebuilding(true);
    const result = buzz('left');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sends.length, 0);
    setRebuilding(false);
    assert.equal(await result, true);
    assert.equal(sends.length, 1);
  });

  it('checks the alarms again after a rebuild', async () => {
    setRebuilding(true);
    const result = buzz('left');
    await new Promise(resolve => setImmediate(resolve));
    activeAlarms.set('left', ring);
    setRebuilding(false);
    assert.equal(await result, false);
    assert.equal(sends.length, 0);
  });

  it('skips when a rebuild outlasts the wait', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      setRebuilding(true);
      const result = buzz('left');
      await new Promise(resolve => setImmediate(resolve));
      mock.timers.tick(5_000);
      assert.equal(await result, false);
      assert.equal(sends.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it('checks the guard at send time', async () => {
    beforeQueue = () => { activeAlarms.set('left', ring); };
    assert.equal(await buzz('left'), false);
    assert.equal(sends.length, 0);
  });

  it('allows one buzz per side at a time', async () => {
    let open = () => {};
    release = new Promise<void>(resolve => { open = resolve; });
    const first = buzz('left');
    assert.equal(await buzz('left'), false);
    const other = buzz('right');
    open();
    assert.equal(await first, true);
    assert.equal(await other, true);
    assert.deepEqual(sends.map(send => send.command).sort(), ['ALARM_LEFT', 'ALARM_RIGHT']);
  });

  it('never records an active alarm', async () => {
    await buzz('left');
    assert.equal(activeAlarms.has('left'), false);
  });
});
