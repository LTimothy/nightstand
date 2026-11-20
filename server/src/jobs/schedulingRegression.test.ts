import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';
import schedule from 'node-schedule';
import type { DailySchedule } from '../db/schedulesSchema.js';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-scheduling-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const commands: unknown[][] = [];
let sendError: Error | undefined;
const updates: unknown[] = [];
const analyses: string[][] = [];
mock.module(new URL('../8sleep/deviceApi.js', import.meta.url).href, {
  namedExports: { executeFunction: async (command: string, arg?: string | (() => string), ...rest: unknown[]) => {
    if (sendError) throw sendError;
    commands.push([command, typeof arg === 'function' ? arg() : arg, ...rest]);
  } },
});
let leftOn = true;
mock.module(new URL('../8sleep/frankenServer.js', import.meta.url).href, {
  namedExports: { connectFrankenWithin: async () => ({
    getDeviceStatus: async () => ({ left: { isOn: leftOn }, right: { isOn: true } }),
  }) },
});
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: { updateDeviceStatus: async (value: { left?: { isOn?: boolean } }) => {
    updates.push(value);
    if (value?.left?.isOn !== undefined) leftOn = value.left.isOn;
  } },
});
mock.module(new URL('./analyzeSleep.js', import.meta.url).href, {
  namedExports: { executeAnalyzeSleep: (...args: string[]) => { analyses.push(args); } },
});
const { default: settings } = await import('../db/settings.js');
const { default: schedules } = await import('../db/schedules.js');
const { default: memory } = await import('../db/memoryDB.js');
const { default: services } = await import('../db/services.js');
const { default: logger } = await import('../logger.js');
let { executeAlarm, scheduleAlarm, scheduleAlarmOverride } = await import('./alarmScheduler.js');
let schedulerInstance = 0;
const { scheduleTemperatures } = await import('./temperatureScheduler.js');
const { scheduleSleepAnalysis, schedulePowerOn, schedulePowerOff, resetPowerOnTimes } = await import('./powerScheduler.js');
const { markManualTempChange } = await import('./scheduleOverride.js');
const { resetAlarmActivity, abortAlarmWaits } = await import('./alarmActivity.js');
const ledger = await import('./alarmLedger.js');
const { markCommandWritten } = await import('../8sleep/frankenErrors.js');

const alarm = {
  time: '07:00', enabled: true, vibrationIntensity: 100,
  duration: 10, vibrationPattern: 'rise' as const, alarmTemperature: 80,
};
const night: DailySchedule = {
  power: { on: '21:00', off: '09:00', enabled: true, onTemperature: 82 },
  temperatures: {}, alarm, alarms: [alarm],
};
let now = Date.parse('2026-09-28T20:00:00Z');
const originalMomentNow = moment.now;
beforeEach(async () => {
  ({ executeAlarm, scheduleAlarm, scheduleAlarmOverride } = await import(`./alarmScheduler.js?instance=${schedulerInstance++}`));
  now = Date.parse('2026-09-28T20:00:00Z');
  moment.now = () => now;
  commands.length = 0;
  sendError = undefined;
  updates.length = 0;
  leftOn = true;
  analyses.length = 0;
  settings.data.timeZone = 'UTC';
  settings.data.features.alarmsWhenOff = false;
  settings.data.left.awayMode = false;
  settings.data.left.alarmsEnabled = true;
  settings.data.left.scheduleOverrides = {
    alarm: { disabled: false, timeOverride: '', expiresAt: '' },
    temperatureSchedules: { disabled: false, expiresAt: '' },
    pause: { active: false, expiresAt: '' },
  };
  await settings.write();
  memory.data.left = { isAlarmVibrating: false, analyzeSleep: {} };
  await memory.write();
  for (const day of Object.values(schedules.data.left)) {
    day.temperatures = {};
    day.power.enabled = false;
  }
  schedules.data.left.monday = structuredClone(night);
  await schedules.write();
});
afterEach(() => {
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  resetAlarmActivity();
  ledger.resetAlarmLedgerForTests();
  rmSync(path.join(folder, 'alarm-ledger.json'), { force: true });
  resetPowerOnTimes();
  moment.now = originalMomentNow;
});
after(() => rmSync(folder, { recursive: true, force: true }));

test('distinct alarms fifteen minutes apart both reach the device', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  scheduleAlarm(settings.data, 'left', 'monday', {
    ...night, alarms: [alarm, { ...alarm, time: '07:15' }],
  });
  now = Date.parse('2026-09-29T07:00:00Z');
  await schedule.scheduledJobs['left-monday-07:00-0-alarm'].invoke();
  now += 15 * 60_000;
  await schedule.scheduledJobs['left-monday-07:15-1-alarm'].invoke();
  assert.equal(commands.length, 2);
});

test('the repeated DST wall-clock occurrence fires only once', async (t) => {
  settings.data.timeZone = 'America/Los_Angeles';
  await settings.write();
  now = Date.parse('2026-11-01T07:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  scheduleAlarm(settings.data, 'left', 'saturday', { ...night, alarms: [{ ...alarm, time: '01:30' }] });
  now = Date.parse('2026-11-01T08:30:00Z');
  await schedule.scheduledJobs['left-saturday-01:30-0-alarm'].invoke();
  now = Date.parse('2026-11-01T09:30:00Z');
  await schedule.scheduledJobs['left-saturday-01:30-0-alarm'].invoke();
  assert.equal(commands.length, 1);
});

test('a forced alarm test does not suppress the upcoming alarm', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  scheduleAlarm(settings.data, 'left', 'monday', night);
  now = Date.parse('2026-09-29T06:55:00Z');
  await executeAlarm({ side: 'left', ...alarm, force: true });
  now = Date.parse('2026-09-29T07:00:00Z');
  await schedule.scheduledJobs['left-monday-07:00-0-alarm'].invoke();
  assert.equal(commands.length, 2);
});

test('a scheduled alarm on a side that is off is reported as missed, a manual one is not', async (t) => {
  t.mock.method(Date, 'now', () => now);
  ledger.startAlarmLedger(new Date(now));
  leftOn = false;
  assert.equal(await executeAlarm({ side: 'left', ...alarm }), 0);
  assert.deepEqual(ledger.listMissedAlarms(new Date(now)), []);
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, { background: true, dueAt: now }), 0);
  const [missed] = ledger.listMissedAlarms(new Date(now));
  assert.equal(missed.reason, 'side-off');
  assert.equal(missed.side, 'left');
  assert.equal(missed.at, new Date(now).toISOString());
  assert.equal(commands.length, 0);
});

test('with alarms ringing when the side is off, a scheduled alarm rings on an off side', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  ledger.startAlarmLedger(new Date(now));
  settings.data.features.alarmsWhenOff = true;
  await settings.write();
  leftOn = false;
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, { background: true, dueAt: now }), 10_000);
  assert.equal(commands.length, 1);
  assert.deepEqual(ledger.listMissedAlarms(new Date(now)), []);
});

test('with alarms ringing when the side is off, an away side stays quiet', async (t) => {
  t.mock.method(Date, 'now', () => now);
  settings.data.features.alarmsWhenOff = true;
  settings.data.left.awayMode = true;
  await settings.write();
  leftOn = false;
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, { background: true, dueAt: now }), 0);
  assert.equal(commands.length, 0);
});

const missedReasons = () => ledger.listMissedAlarms(new Date(now)).map(item => item.reason);
const background = () => ({ background: true, dueAt: now });
const named = (name: string) => Object.assign(new Error(name), { name });

test('an alarm the Pod is already ringing is never reported, even if the bookkeeping after it fails', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  ledger.startAlarmLedger(new Date(now));
  t.mock.method(memory, 'write', async () => { throw new Error('no space left'); });
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, background()), 0);
  assert.equal(commands.length, 1);
  assert.deepEqual(missedReasons(), []);
});

test('a send that breaks is reported as failed, a command that gets no answer as unconfirmed', async (t) => {
  t.mock.method(Date, 'now', () => now);
  ledger.startAlarmLedger(new Date(now));
  sendError = new Error('write EPIPE');
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, background()), 0);
  sendError = named('FrankenCommandTimeoutError');
  markCommandWritten(sendError);
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, { ...background(), dueAt: now + 1 }), 0);
  assert.deepEqual(missedReasons().sort(), ['failed', 'unconfirmed']);
});

test('a Pod that became reachable too late is reported as late', async (t) => {
  t.mock.method(Date, 'now', () => now);
  ledger.startAlarmLedger(new Date(now));
  sendError = named('FrankenUnavailableError');
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, background()), 0);
  assert.deepEqual(missedReasons(), ['late']);
});

test('an error before the Pod is asked is reported as an error, and a manual alarm is not reported', async (t) => {
  t.mock.method(Date, 'now', () => now);
  ledger.startAlarmLedger(new Date(now));
  const read = t.mock.method(settings, 'read', async () => { throw new Error('read failed'); });
  assert.equal(await executeAlarm({ side: 'left', ...alarm }, undefined, background()), 0);
  assert.equal(await executeAlarm({ side: 'left', ...alarm, force: true }), 0);
  read.mock.restore();
  assert.deepEqual(missedReasons(), ['error']);
});

test('disabled nights do not create temperature commands', async () => {
  scheduleTemperatures(settings.data, 'left', 'monday', { '22:00': 55 }, { ...night.power, enabled: false });
  const job = schedule.scheduledJobs['left-monday-22:00-55-temperature-adjustment'];
  assert.equal(job, undefined);
  assert.deepEqual(updates, []);
});

test('a Tuesday manual change protects Monday night adjustments', async () => {
  now = Date.parse('2026-09-29T01:00:00Z');
  schedules.data.left.monday.temperatures = { '02:00': 70 };
  await schedules.write();
  await markManualTempChange('left');
  await settings.read();
  assert.equal(settings.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
});

test('disabled temperature schedules do not create manual overrides', async () => {
  now = Date.parse('2026-09-28T21:00:00Z');
  schedules.data.left.monday.power.enabled = false;
  schedules.data.left.monday.temperatures = { '22:00': 70 };
  await schedules.write();
  await markManualTempChange('left');
  await settings.read();
  assert.equal(settings.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
});

test('an earlier override suppresses the original alarm for that night', async (t) => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '05:00', expiresAt: '2026-09-29T05:02:00Z',
  };
  await settings.write();
  scheduleAlarmOverride(settings.data, 'left');
  scheduleAlarm(settings.data, 'left', 'monday', night);
  now = Date.parse('2026-09-29T05:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-05:00'].invoke();
  now = Date.parse('2026-09-29T07:00:00Z');
  await schedule.scheduledJobs['left-monday-07:00-0-alarm'].invoke();
  assert.equal(commands.length, 1);
  now = Date.parse('2026-10-06T07:00:00Z');
  await schedule.scheduledJobs['left-monday-07:00-0-alarm'].invoke();
  assert.equal(commands.length, 2, 'an expired override must not suppress the following week');
});

test('noon analysis includes the preceding evening', async () => {
  now = Date.parse('2026-09-29T12:00:00Z');
  services.data.biometrics.enabled = true;
  await services.write();
  scheduleSleepAnalysis(settings.data, 'left');
  await schedule.scheduledJobs['daily-analyze-sleep-left'].invoke();
  assert.equal(analyses[0][1], '2026-09-28T12:00:00.000Z');
  assert.equal(analyses[0][2], '2026-09-29T13:00:00.000Z');
});

test('rebuilding after a replacement has rung cannot replay it tomorrow', t => {
  now = Date.parse('2026-09-29T06:00:00Z');
  t.mock.method(Date, 'now', () => now);
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '05:00', expiresAt: '2026-09-29T09:00:00Z',
  };
  scheduleAlarmOverride(settings.data, 'left');
  assert.equal(schedule.scheduledJobs['left-alarm-override-05:00'], undefined);
});

test('an overnight replacement inherits the enabled alarm from the starting night', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  schedules.data.left.monday.alarms = [
    { ...alarm, enabled: false, vibrationIntensity: 10 },
    { ...alarm, time: '07:15', vibrationIntensity: 70, duration: 20 },
  ];
  await schedules.write();
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '05:00', expiresAt: '2026-09-29T09:00:00Z',
  };
  await settings.write();
  scheduleAlarmOverride(settings.data, 'left');
  now = Date.parse('2026-09-29T05:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-05:00'].invoke();
  const { default: cbor } = await import('cbor');
  const payload = cbor.decodeFirstSync(Buffer.from(commands[0][1] as string, 'hex'));
  assert.equal(payload.pl, 70);
  assert.equal(payload.du, 20);
});

test('a replacement with no alarm on its night rings at full strength for 30 s with a double pulse', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  schedules.data.left.monday = { ...structuredClone(night), alarm: { ...alarm, enabled: false }, alarms: [] };
  await schedules.write();
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '05:00', expiresAt: '2026-09-29T09:00:00Z',
  };
  await settings.write();
  scheduleAlarmOverride(settings.data, 'left');
  now = Date.parse('2026-09-29T05:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-05:00'].invoke();
  const { default: cbor } = await import('cbor');
  const payload = cbor.decodeFirstSync(Buffer.from(commands[0][1] as string, 'hex'));
  assert.deepEqual([payload.pl, payload.du, payload.pi], [100, 30, 'double']);
});

test('overlapping alarms retain dismissal until the latest alarm finishes', async t => {
  const timers: (() => Promise<void>)[] = [];
  t.mock.method(globalThis, 'setTimeout', (callback: () => Promise<void>) => {
    timers.push(callback);
    return { unref() {} } as NodeJS.Timeout;
  });
  await executeAlarm({ side: 'left', ...alarm, duration: 300 }, 'first');
  await executeAlarm({ side: 'left', ...alarm, duration: 300, force: true });
  await timers[0]();
  await memory.read();
  assert.equal(memory.data.left.isAlarmVibrating, true, 'an older alarm timer must not hide the later alarm');
  await timers[1]();
  await memory.read();
  assert.equal(memory.data.left.isAlarmVibrating, false);
});

test('a previous full-day override expires at the next night start', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  settings.data.left.scheduleOverrides.alarm = {
    disabled: true, timeOverride: '', expiresAt: '2026-09-28T09:00:00Z',
  };
  await settings.write();
  scheduleAlarm(settings.data, 'left', 'monday', { ...night, power: { ...night.power, on: '09:00', off: '09:00' } });
  now = Date.parse('2026-09-29T07:00:00Z');
  await schedule.scheduledJobs['left-monday-07:00-0-alarm'].invoke();
  assert.equal(commands.length, 1);
});


test('a full-day replacement rebuilt after ringing cannot fire at the next night start', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  schedules.data.left.monday.power = { ...night.power, on: '21:00', off: '21:00' };
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '21:00', expiresAt: '2026-09-29T21:00:00Z',
  };
  scheduleAlarmOverride(settings.data, 'left');
  now = Date.parse('2026-09-28T21:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-21:00'].invoke();
  assert.equal(commands.length, 1);
  schedule.cancelJob('left-alarm-override-21:00');
  now = Date.parse('2026-09-28T21:01:00Z');
  scheduleAlarmOverride(settings.data, 'left');
  assert.equal(schedule.scheduledJobs['left-alarm-override-21:00'], undefined);
});


test('a full-day override set after its night began still rings when the night ends', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  now = Date.parse('2026-09-29T15:00:00Z');
  schedules.data.left.monday.power = { ...night.power, on: '21:00', off: '21:00' };
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '21:00', expiresAt: '2026-09-29T21:00:00Z',
  };
  scheduleAlarmOverride(settings.data, 'left');
  assert.ok(schedule.scheduledJobs['left-alarm-override-21:00'], 'the override was never scheduled');
  now = Date.parse('2026-09-29T21:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-21:00'].invoke();
  assert.equal(commands.length, 1);
});


test('toggling an earlier alarm cannot replay a later alarm after a rebuild', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  const later = { ...alarm, time: '07:15' };
  scheduleAlarm(settings.data, 'left', 'monday', { ...night, alarms: [alarm, later] });
  now = Date.parse('2026-09-29T07:15:00Z');
  await schedule.scheduledJobs['left-monday-07:15-1-alarm'].invoke();
  scheduleAlarm(settings.data, 'left', 'monday', { ...night, alarms: [{ ...alarm, enabled: false }, later] });
  await schedule.scheduledJobs['left-monday-07:15-0-alarm'].invoke();
  assert.equal(commands.length, 1);
});

test('concurrent callbacks for one occurrence issue only one device command', async t => {
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  await Promise.all([
    executeAlarm({ side: 'left', ...alarm }, 'same-occurrence'),
    executeAlarm({ side: 'left', ...alarm }, 'same-occurrence'),
  ]);
  assert.equal(commands.length, 1);
});


test('an override at exactly the turn-off minute rings once', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' }, alarms: [{ ...alarm, time: '06:30' }] };
  schedules.data.left.monday = structuredClone(wakeNight);
  await schedules.write();
  now = Date.parse('2026-09-28T22:00:00Z');
  settings.data.left.scheduleOverrides.alarm = {
    disabled: false, timeOverride: '07:00', expiresAt: '2026-09-29T07:00:00Z',
  };
  await settings.write();
  scheduleAlarmOverride(settings.data, 'left');
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  assert.ok(schedule.scheduledJobs['left-alarm-override-07:00'], 'the override at the turn-off minute was not scheduled');
  now = Date.parse('2026-09-29T06:30:00Z');
  await schedule.scheduledJobs['left-monday-06:30-0-alarm'].invoke();
  assert.equal(commands.length, 0, 'the replaced alarm must stay silent');
  now = Date.parse('2026-09-29T07:00:00Z');
  await schedule.scheduledJobs['left-alarm-override-07:00'].invoke();
  assert.equal(commands.length, 1);
});

// Runs a job as node-schedule does, passing the time it was due.
const invokeAt = (name: string, fireDate: Date) =>
  (schedule.scheduledJobs[name] as unknown as { invoke(date: Date): Promise<void> }).invoke(fireDate);
const nextRun = (name: string) => new Date(schedule.scheduledJobs[name].nextInvocation()?.getTime() ?? 0);

test('an alarm at the power-off minute rings before the side turns off', async t => {
  const timers: { callback: () => void; ms: number }[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    timers.push({ callback, ms });
    return { unref() {} } as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' } };
  schedules.data.left.monday = structuredClone(wakeNight);
  await schedules.write();
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  const fireDate = nextRun('left-monday-07:00-0-alarm');
  now = Date.parse('2026-09-29T07:00:00Z');
  // node-schedule runs the power-off first because it was registered first.
  const powerOff = invokeAt('left-monday-07:00-power-off', fireDate);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, [], 'the side turned off before the alarm could ring');
  await invokeAt('left-monday-07:00-0-alarm', fireDate);
  assert.equal(commands.length, 1, 'the alarm did not reach the device');
  for (let turn = 0; turn < 5 && updates.length === 0; turn++) {
    await new Promise(resolve => setImmediate(resolve));
    timers.filter(timer => timer.ms === alarm.duration * 1_000).forEach(timer => timer.callback());
  }
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

test('a power-off with no alarm in its minute turns the side off at once', async () => {
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' }, alarms: [{ ...alarm, time: '06:30' }] };
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  await invokeAt('left-monday-07:00-power-off', nextRun('left-monday-07:00-power-off'));
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

test('a power-off that runs after its minute\'s alarm waits for the alarm to end', async t => {
  const timers: { callback: () => void; ms: number }[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    timers.push({ callback, ms });
    return { unref() {} } as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' } };
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  const fireDate = nextRun('left-monday-07:00-0-alarm');
  now = Date.parse('2026-09-29T07:00:00Z');
  await invokeAt('left-monday-07:00-0-alarm', fireDate);
  // As node-schedule does once a run starts, move the alarm to next week.
  schedule.scheduledJobs['left-monday-07:00-0-alarm'].cancelNext(true);
  const powerOff = invokeAt('left-monday-07:00-power-off', fireDate);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 1);
  assert.deepEqual(updates, [], 'the side turned off while the alarm was ringing');
  timers.filter(timer => timer.ms === alarm.duration * 1_000).forEach(timer => timer.callback());
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});


// Monday's night runs from 07:00 to 07:00, so Tuesday 07:00 both ends it and
// starts Tuesday's night with an alarm.
const backToBack = { ...night, power: { ...night.power, on: '07:00', off: '07:00' }, alarms: [alarm] };
function scheduleBackToBack() {
  schedules.data.left.tuesday = structuredClone(backToBack);
  schedulePowerOn(settings.data, 'left', 'tuesday', backToBack.power);
  schedulePowerOff(settings.data, 'left', 'monday', backToBack.power);
  scheduleAlarm(settings.data, 'left', 'tuesday', backToBack);
  return nextRun('left-tuesday-07:00-power-on');
}

test('the power-off ending one night does not wait for the alarm of the night starting with it', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  const fireDate = scheduleBackToBack();
  now = fireDate.getTime();
  await invokeAt('left-monday-07:00-power-off', fireDate);
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
  await invokeAt('left-tuesday-07:00-power-on', fireDate);
  await invokeAt('left-tuesday-07:00-0-alarm', fireDate);
  assert.equal(leftOn, true, 'the new session ended up off');
  assert.equal(commands.length, 1, 'the new night\'s alarm did not ring');
});

test('a power-off that runs after the next session started leaves it on', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  const fireDate = scheduleBackToBack();
  now = fireDate.getTime();
  await invokeAt('left-tuesday-07:00-power-on', fireDate);
  await invokeAt('left-monday-07:00-power-off', fireDate);
  assert.equal(leftOn, true);
  assert.ok(updates.every(update => (update as { left: { isOn: boolean } }).left.isOn), JSON.stringify(updates));
});

test('a power-off that waited for its alarm still leaves a session that started meanwhile on', async t => {
  const timers: { callback: () => void; ms: number }[] = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    timers.push({ callback, ms });
    return { unref() {} } as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' } };
  const tuesday = { ...night.power, on: '07:00', off: '21:00' };
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  schedulePowerOn(settings.data, 'left', 'tuesday', tuesday);
  const fireDate = nextRun('left-monday-07:00-0-alarm');
  now = fireDate.getTime();
  const powerOff = invokeAt('left-monday-07:00-power-off', fireDate);
  await new Promise(resolve => setImmediate(resolve));
  await invokeAt('left-monday-07:00-0-alarm', fireDate);
  await invokeAt('left-tuesday-07:00-power-on', fireDate);
  for (let turn = 0; turn < 5; turn++) {
    await new Promise(resolve => setImmediate(resolve));
    timers.filter(timer => timer.ms === alarm.duration * 1_000).forEach(timer => timer.callback());
  }
  await powerOff;
  assert.equal(commands.length, 1);
  assert.equal(leftOn, true);
  assert.ok(updates.every(update => (update as { left: { isOn: boolean } }).left.isOn), JSON.stringify(updates));
});

test('shutdown ends a power-off\'s wait for a ringing alarm so the side turns off at once', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' } };
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  const fireDate = nextRun('left-monday-07:00-0-alarm');
  now = fireDate.getTime();
  const powerOff = invokeAt('left-monday-07:00-power-off', fireDate);
  await invokeAt('left-monday-07:00-0-alarm', fireDate);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, [], 'the side turned off while the alarm was ringing');
  abortAlarmWaits();
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

test('shutdown ends a power-off\'s wait for an alarm that has not started', async t => {
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const wakeNight = { ...night, power: { ...night.power, off: '07:00' } };
  schedulePowerOff(settings.data, 'left', 'monday', wakeNight.power);
  scheduleAlarm(settings.data, 'left', 'monday', wakeNight);
  const powerOff = invokeAt('left-monday-07:00-power-off', nextRun('left-monday-07:00-0-alarm'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, []);
  abortAlarmWaits();
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

test('a scheduled alarm counts its lateness from when it was due', async t => {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as NodeJS.Timeout);
  scheduleAlarm(settings.data, 'left', 'monday', night);
  const due = Date.parse('2026-09-29T07:00:00Z');
  now = due + 4 * 60_000;
  await invokeAt('left-monday-07:00-0-alarm', new Date(due));
  assert.equal(commands.length, 0, 'an alarm four minutes past its time rang');
  now = due + 2 * 60_000;
  await invokeAt('left-monday-07:00-0-alarm', new Date(due));
  assert.equal(commands.length, 1);
  assert.equal((commands[0][2] as { notAfter: number }).notAfter, due + 3 * 60_000);
});

for (const side of ['left', 'right'] as const) {
  test(`weekly power jobs log the side and schedule day for ${side}`, async t => {
    const info = t.mock.method(logger, 'info', () => logger);
    schedulePowerOn(settings.data, side, 'monday', night.power);
    await invokeAt(`${side}-monday-21:00-power-on`, new Date('2026-09-28T21:00:00Z'));
    schedulePowerOff(settings.data, side, 'monday', night.power);
    await invokeAt(`${side}-monday-09:00-power-off`, new Date('2026-09-29T09:00:00Z'));
    const messages = info.mock.calls.map(call => call.arguments[0]);
    assert.deepEqual(messages, [
      `Executing weekly power-on for ${side} (monday)`,
      `Executing weekly power-off for ${side} (monday)`,
    ]);
  });
}

test('paused weekly jobs do not log power execution', async t => {
  const info = t.mock.method(logger, 'info', () => logger);
  settings.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-29T10:00:00Z' };
  await settings.write();
  schedulePowerOn(settings.data, 'left', 'monday', night.power);
  schedulePowerOff(settings.data, 'left', 'monday', night.power);
  await invokeAt('left-monday-21:00-power-on', new Date('2026-09-28T21:00:00Z'));
  await invokeAt('left-monday-09:00-power-off', new Date('2026-09-29T09:00:00Z'));
  assert.ok(info.mock.calls.every(call => !String(call.arguments[0]).startsWith('Executing weekly power-')));
  assert.deepEqual(updates, []);
});
