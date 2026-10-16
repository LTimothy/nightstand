import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it, mock, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-schedule-rhythms-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

const updates: unknown[] = [];
const commands: unknown[][] = [];
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: { updateDeviceStatus: async (value: unknown) => { updates.push(value); } },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
  namedExports: { executeFunction: async (...args: unknown[]) => { commands.push(args); } },
});
// What the Pod reports; every side is on unless a test says otherwise.
const pod = { left: { isOn: true }, right: { isOn: true } };
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
  namedExports: {
    connectFrankenWithin: async () => ({ getDeviceStatus: async () => pod }),
    isFrankenConnected: () => true,
    getDeviceStatusCoalesced: async () => pod,
  },
});
const analyses: string[][] = [];
mock.module(new URL('../analyzeSleep.js', import.meta.url).href, {
  namedExports: { executeAnalyzeSleep: (...args: string[]) => { analyses.push(args); } },
});

const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { default: servicesDB } = await import('../../db/services.js');
const { default: memoryDB } = await import('../../db/memoryDB.js');
const { default: logger } = await import('../../logger.js');
const { everyNight, testNight, testRhythmsDB } = await import('./testSupport.js');
const { scheduleRhythms } = await import('./scheduleRhythms.js');
const { abortAlarmWaits, resetAlarmActivity } = await import('../alarmActivity.js');
const { resetPowerOnTimes } = await import('../powerScheduler.js');
const { resetOffTimes } = await import('./runEvent.js');
const { setEngineActivation } = await import('../scheduleQueries.js');
const { DEFAULT_SMART } = await import('../../db/rhythmsSchema.js');
const { resolveSleeps } = await import('./resolve.js');
const { smartResolveHooks, startCurveController, stopCurveController } = await import('./curveController.js');

const NIGHT = testNight('22:00', '06:00', { temperatures: { '02:00': 72 }, alarms: ['05:45'] });
const at = (iso: string) => new Date(iso);
const setNow = (iso: string) => mock.timers.setTime(Date.parse(iso));
const rhythmNames = () => Object.keys(schedule.scheduledJobs).filter(name => name.startsWith('rhythm')).sort();
const fireTime = (name: string) => {
  const job = schedule.scheduledJobs[name];
  const next = job?.nextInvocation();
  assert.ok(next, `missing job ${name}`);
  return new Date(next.getTime()).toISOString();
};
const sleepJobs = (date: string) => [
  'alarm-0545-0', 'analysis-0615-0', 'analysis-0800-1', 'power-off-0600-0', 'power-on-2200-0', 'temperature-0200-0',
].map(suffix => `rhythm-left-${date}-${suffix}`);

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  updates.length = 0;
  commands.length = 0;
  analyses.length = 0;
  pod.left.isOn = true;
  pod.right.isOn = true;
  servicesDB.data.biometrics.enabled = true;
  await servicesDB.write();
  memoryDB.data.left = { isAlarmVibrating: false, analyzeSleep: {} };
  memoryDB.data.right = { isAlarmVibrating: false, analyzeSleep: {} };
  await memoryDB.write();
  settingsDB.data.timeZone = 'UTC';
  for (const side of ['left', 'right'] as const) {
    settingsDB.data[side].awayMode = false;
    settingsDB.data[side].alarmsEnabled = true;
    settingsDB.data[side].scheduleOverrides = {
      temperatureSchedules: { disabled: false, expiresAt: '' },
      alarm: { disabled: false, timeOverride: '', expiresAt: '' },
      pause: { active: false, expiresAt: '' },
    };
  }
  await settingsDB.write();
});

afterEach(() => {
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  resetAlarmActivity();
  resetPowerOnTimes();
  resetOffTimes();
  setEngineActivation({ active: false, reason: 'flag-off' });
  mock.timers.reset();
});
after(() => rmSync(folder, { recursive: true, force: true }));

it('plans each sleep in the 48 hour horizon once', () => {
  const plan = scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  assert.deepEqual(plan, { jobCount: 12, failedSides: [] });
  assert.deepEqual(rhythmNames(), [...sleepJobs('2026-09-28'), ...sleepJobs('2026-09-29'), 'rhythms-horizon']);
  assert.equal(fireTime('rhythm-left-2026-09-28-power-on-2200-0'), '2026-09-28T22:00:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-09-28-temperature-0200-0'), '2026-09-29T02:00:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-09-28-analysis-0615-0'), '2026-09-29T06:15:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-09-28-analysis-0800-1'), '2026-09-29T08:00:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-09-29-power-off-0600-0'), '2026-09-30T06:00:00.000Z');
});

it('extends the horizon every hour without duplicating jobs', async () => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(NIGHT));
  scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z'));
  assert.equal(scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z')).jobCount, 0);
  setNow('2026-09-29T12:00:00Z');
  await schedule.scheduledJobs['rhythms-horizon'].invoke();
  assert.ok(rhythmNames().includes('rhythm-left-2026-09-30-power-on-2200-0'));
  assert.equal(rhythmNames().filter(name => name.includes('2026-09-28')).length, 6);
});

it('plans only what is still ahead for a sleep in progress, and arms its off time once after a restart', () => {
  setNow('2026-09-29T01:00:00Z');
  const { jobCount } = scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-29T01:00:00Z'));
  assert.equal(jobCount, 18);
  assert.deepEqual(rhythmNames().filter(name => name.includes('2026-09-28')), [
    ...sleepJobs('2026-09-28').filter(name => !name.includes('power-on')), 'rhythm-left-2026-09-28-rearm',
  ].sort());
});

const replan = (db: ReturnType<typeof testRhythmsDB>, iso: string) => {
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  setNow(iso);
  setEngineActivation({ active: true, db });
  return scheduleRhythms(settingsDB.data, db, at(iso));
};
const LATE = testNight('22:00', '09:00', { alarms: ['08:45'] });
const tonightUses = (night: typeof LATE | null) => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(NIGHT));
  if (night) Object.assign(db.left.rhythms, everyNight(night, 'tonight').rhythms);
  db.left.changes = [{ date: '2026-09-28', rhythmId: night ? 'tonight' : null }];
  return db;
};
const powerOnTonight = async () => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  setNow('2026-09-28T22:00:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-power-on-2200-0'].invoke();
  assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
  updates.length = 0;
};

it('moves the off time of a sleep in progress whose end moves later, so its later alarm still rings', async () => {
  await powerOnTonight();
  replan(tonightUses(LATE), '2026-09-28T23:00:00Z');
  assert.ok(rhythmNames().includes('rhythm-left-2026-09-28-alarm-0845-0'));
  await schedule.scheduledJobs['rhythm-left-2026-09-28-rearm'].invoke();
  assert.deepEqual(updates, [{ left: { secondsRemaining: 10 * 3600 + 300 } }]);
  updates.length = 0;
  replan(tonightUses(LATE), '2026-09-28T23:30:00Z');
  assert.equal(schedule.scheduledJobs['rhythm-left-2026-09-28-rearm'], undefined, 'an unchanged end was sent again');
});

it('turns a sleep in progress off at its new end when the end moves earlier', async () => {
  await powerOnTonight();
  replan(tonightUses(testNight('22:00', '04:00')), '2026-09-28T23:00:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-rearm'].invoke();
  assert.deepEqual(updates, [{ left: { secondsRemaining: 5 * 3600 + 300 } }]);
  setNow('2026-09-29T04:00:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-power-off-0400-0'].invoke();
  assert.deepEqual(updates.at(-1), { left: { isOn: false } });
});

it("leaves the off time already sent when tonight's sleep is removed while it runs", async () => {
  await powerOnTonight();
  replan(tonightUses(null), '2026-09-28T23:00:00Z');
  assert.deepEqual(rhythmNames().filter(name => name.includes('2026-09-28')), []);
  assert.deepEqual(updates, []);
});

it('keeps both end-of-sleep analyses for a sleep that just ended', () => {
  setNow('2026-09-29T06:05:00Z');
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-29T06:05:00Z'));
  assert.deepEqual(rhythmNames().filter(name => name.includes('2026-09-28')), [
    'rhythm-left-2026-09-28-analysis-0615-0',
    'rhythm-left-2026-09-28-analysis-0800-1',
  ]);
});

it('keeps only the two hour re-analysis once the first one has run', () => {
  setNow('2026-09-29T06:20:00Z');
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-29T06:20:00Z'));
  assert.deepEqual(rhythmNames().filter(name => name.includes('2026-09-28')), ['rhythm-left-2026-09-28-analysis-0800-1']);
});

it('re-analyses over the 25 hours before end plus two hours, in the same queue as the first run', async () => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  setNow('2026-09-29T06:15:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-analysis-0615-0'].invoke();
  setNow('2026-09-29T08:00:00Z');
  await memoryDB.read();
  // The queue itself skips an overlapping call; this only clears the 10 minute repeat guard.
  memoryDB.data.left.analyzeSleep = {};
  await memoryDB.write();
  await schedule.scheduledJobs['rhythm-left-2026-09-28-analysis-0800-1'].invoke();
  assert.deepEqual(analyses, [
    ['left', '2026-09-28T21:00:00.000Z', '2026-09-29T07:00:00.000Z'],
    ['left', '2026-09-28T07:00:00.000Z', '2026-09-29T08:00:00.000Z'],
  ]);
});

it("lets the present side drive and ignores an away side's rhythm", () => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(NIGHT), everyNight(testNight('08:00', '16:00')));
  settingsDB.data.right.awayMode = true;
  scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z'));
  assert.equal(rhythmNames().some(name => name.startsWith('rhythm-right')), false);
  assert.equal(rhythmNames().filter(name => name.startsWith('rhythm-left')).length, 12);
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  settingsDB.data.right.awayMode = false;
  settingsDB.data.left.awayMode = true;
  scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z'));
  assert.equal(rhythmNames().some(name => name.startsWith('rhythm-left')), false);
  assert.ok(rhythmNames().some(name => name.startsWith('rhythm-right')));
});

it('leaves out alarms when the side has alarms off', () => {
  settingsDB.data.left.alarmsEnabled = false;
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  assert.equal(rhythmNames().some(name => name.includes('-alarm-')), false);
});

it('still fires a temperature stored after the power off, as the weekly engine does', () => {
  setNow('2026-09-29T08:00:00Z');
  const late = testNight('22:00', '06:00', { temperatures: { '10:00': 70 } });
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(late)), at('2026-09-29T08:00:00Z'));
  assert.equal(fireTime('rhythm-left-2026-09-28-temperature-1000-0'), '2026-09-29T10:00:00.000Z');
});

it('fires at the right instants and sets the firmware across the fall back night', async () => {
  settingsDB.data.timeZone = 'America/Los_Angeles';
  await settingsDB.write();
  setNow('2026-10-31T19:00:00Z');
  const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('22:00', '06:00', { temperatures: { '01:30': 70 } })));
  scheduleRhythms(settingsDB.data, db, at('2026-10-31T19:00:00Z'));
  assert.equal(fireTime('rhythm-left-2026-10-31-power-on-2200-0'), '2026-11-01T05:00:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-10-31-temperature-0130-0'), '2026-11-01T08:30:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-10-31-power-off-0600-0'), '2026-11-01T14:00:00.000Z');
  setNow('2026-11-01T05:00:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-10-31-power-on-2200-0'].invoke();
  assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
});

it('moves a missing time forward and sets the firmware across the spring forward night', async () => {
  settingsDB.data.timeZone = 'America/Los_Angeles';
  await settingsDB.write();
  setNow('2026-03-07T20:00:00Z');
  const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('22:00', '06:00', { temperatures: { '02:30': 70 } })));
  scheduleRhythms(settingsDB.data, db, at('2026-03-07T20:00:00Z'));
  assert.equal(fireTime('rhythm-left-2026-03-07-power-on-2200-0'), '2026-03-08T06:00:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-03-07-temperature-0330-0'), '2026-03-08T10:30:00.000Z');
  assert.equal(fireTime('rhythm-left-2026-03-07-power-off-0600-0'), '2026-03-08T13:00:00.000Z');
  setNow('2026-03-08T06:00:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-03-07-power-on-2200-0'].invoke();
  assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 80 } }]);
});

const captureErrors = (t: TestContext) => {
  const errors: string[] = [];
  t.mock.method(logger, 'error', (message: string) => { errors.push(message); return logger; });
  return errors;
};

it('logs a job that fails instead of rejecting, which would stop the server', async t => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  const errors = captureErrors(t);
  t.mock.method(settingsDB, 'read', async () => { throw new Error('read failed'); });
  for (const suffix of ['power-on-2200-0', 'alarm-0545-0', 'analysis-0615-0']) {
    await assert.doesNotReject(async () => { await schedule.scheduledJobs[`rhythm-left-2026-09-28-${suffix}`].invoke(); });
  }
  assert.equal(errors.filter(message => message.includes('read failed')).length, 3);
});

it('logs a horizon run that fails instead of throwing', t => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(NIGHT));
  scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z'));
  const errors = captureErrors(t);
  db.left.changes = null as unknown as typeof db.left.changes;
  assert.doesNotThrow(() => schedule.scheduledJobs['rhythms-horizon'].invoke());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /left/);
});

it('plans the other side and the horizon when one side cannot be resolved', t => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(NIGHT), everyNight(testNight('23:00', '07:00')));
  db.left.changes = null as unknown as typeof db.left.changes;
  const errors = captureErrors(t);
  let plan = { jobCount: 0, failedSides: [] as string[] };
  assert.doesNotThrow(() => { plan = scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z')); });
  assert.equal(rhythmNames().some(name => name.startsWith('rhythm-left')), false);
  assert.equal(rhythmNames().filter(name => name.startsWith('rhythm-right')).length, 8);
  assert.deepEqual(plan, { jobCount: 8, failedSides: ['left'] });
  assert.ok(schedule.scheduledJobs['rhythms-horizon']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /left/);
});

it('extends from the data of the latest plan, not the first', async () => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  const later = testRhythmsDB(schedulesDB.data, everyNight(testNight('21:30', '06:00')));
  scheduleRhythms(settingsDB.data, later, at('2026-09-28T12:00:00Z'));
  setNow('2026-09-29T12:00:00Z');
  await schedule.scheduledJobs['rhythms-horizon'].invoke();
  assert.ok(rhythmNames().includes('rhythm-left-2026-09-30-power-on-2130-0'));
  assert.equal(rhythmNames().includes('rhythm-left-2026-09-30-power-on-2200-0'), false);
});

it('extends at minute 0 of every hour in the Pod time zone', () => {
  settingsDB.data.timeZone = 'Asia/Kolkata';
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), at('2026-09-28T12:00:00Z'));
  // 12:00 UTC is 17:30 in Kolkata, so the next hour there starts at 12:30 UTC.
  assert.equal(fireTime('rhythms-horizon'), '2026-09-28T12:30:00.000Z');
});

it('plans a sleep starting just past the horizon before it starts', async () => {
  const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('12:30', '20:00')));
  scheduleRhythms(settingsDB.data, db, at('2026-09-28T12:00:00Z'));
  const edge = 'rhythm-left-2026-09-30-power-on-1230-0';
  assert.equal(rhythmNames().includes(edge), false);
  const tick = fireTime('rhythms-horizon');
  assert.equal(tick, '2026-09-28T13:00:00.000Z');
  setNow(tick);
  await schedule.scheduledJobs['rhythms-horizon'].invoke();
  assert.equal(fireTime(edge), '2026-09-30T12:30:00.000Z');
});

const onlyOn = (days: string[]) => {
  const side = everyNight(NIGHT);
  for (const day of Object.keys(side.week) as (keyof typeof side.week)[]) side.week[day] = days.includes(day) ? side.week[day] : null;
  return side;
};

it('keeps the noon analysis for a side with no sleep in the day before, and skips a day that has one', async () => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, onlyOn(['tuesday'])), at('2026-09-28T12:00:00Z'));
  assert.ok(schedule.scheduledJobs['daily-analyze-sleep-left'], 'a side with no sleep before noon lost its noon analysis');
  setNow('2026-09-29T12:00:00Z');
  await schedule.scheduledJobs['daily-analyze-sleep-left'].invoke();
  assert.equal(analyses.length, 1);
  setNow('2026-09-30T12:00:00Z');
  memoryDB.data.left.analyzeSleep = {};
  await memoryDB.write();
  await schedule.scheduledJobs['daily-analyze-sleep-left'].invoke();
  assert.equal(analyses.length, 1, 'the noon run repeated the analysis of the sleep that ended that morning');
});

it('adds the noon analysis on the hourly run before a day with no sleep', async () => {
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, onlyOn(['sunday', 'monday', 'wednesday'])), at('2026-09-28T12:00:00Z'));
  assert.equal(schedule.scheduledJobs['daily-analyze-sleep-left'], undefined);
  assert.ok(schedule.scheduledJobs['daily-analyze-sleep-right'], 'a side with no rhythms lost its noon analysis');
  setNow('2026-09-29T13:00:00Z');
  await schedule.scheduledJobs['rhythms-horizon'].invoke();
  assert.equal(fireTime('daily-analyze-sleep-left'), '2026-09-30T12:00:00.000Z');
});

// Captures timers so a test can end an alarm's ring on cue.
function captureTimers(t: TestContext) {
  const timers: { callback: () => void; ms: number }[] = [];
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    timers.push({ callback, ms });
    return { unref() {} } as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  return timers;
}
const WAKE_AT_OFF = testNight('22:00', '06:00', { alarms: ['06:00'] });
const settle = () => new Promise(resolve => setImmediate(resolve));

it('lets an alarm due with the power-off ring before the side turns off', async t => {
  const timers = captureTimers(t);
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(WAKE_AT_OFF)), at('2026-09-28T12:00:00Z'));
  setNow('2026-09-29T06:00:00Z');
  // node-schedule may start the power-off first.
  const powerOff = schedule.scheduledJobs['rhythm-left-2026-09-28-power-off-0600-0'].invoke() as unknown as Promise<number>;
  await settle();
  assert.deepEqual(updates, [], 'the side turned off before the alarm could ring');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-alarm-0600-0'].invoke();
  assert.equal(commands.filter(([command]) => command === 'ALARM_LEFT').length, 1);
  for (let turn = 0; turn < 5 && updates.length === 0; turn++) {
    await settle();
    timers.filter(timer => timer.ms === 20_000).forEach(timer => timer.callback());
  }
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

it('ends the wait for a ringing alarm at shutdown so the side turns off at once', async t => {
  captureTimers(t);
  scheduleRhythms(settingsDB.data, testRhythmsDB(schedulesDB.data, everyNight(WAKE_AT_OFF)), at('2026-09-28T12:00:00Z'));
  setNow('2026-09-29T06:00:00Z');
  const powerOff = schedule.scheduledJobs['rhythm-left-2026-09-28-power-off-0600-0'].invoke() as unknown as Promise<number>;
  await schedule.scheduledJobs['rhythm-left-2026-09-28-alarm-0600-0'].invoke();
  await settle();
  assert.deepEqual(updates, []);
  abortAlarmWaits();
  await powerOff;
  assert.deepEqual(updates, [{ left: { isOn: false } }]);
});

// NIGHT's bedtime is 22:00, so as a Smart Schedule sleep it turns on at 21:30.
const smartNight = () => {
  const left = everyNight(NIGHT);
  left.rhythms['every-night'].temperatureMode = 'smart';
  return testRhythmsDB(schedulesDB.data, left);
};
const LATE_ON = 'rhythm-left-2026-09-28-power-on-late';

it('turns on a Smart Schedule sleep first planned after its turn-on time, so its alarm still rings', async t => {
  captureTimers(t);
  pod.left.isOn = false;
  replan(smartNight(), '2026-09-28T21:40:00Z');
  assert.equal(fireTime(LATE_ON), '2026-09-28T21:40:01.000Z');
  await schedule.scheduledJobs[LATE_ON].invoke();
  assert.deepEqual(updates, [{ left: { isOn: true, targetTemperatureF: 88 } }]);
  pod.left.isOn = true;
  setNow('2026-09-29T05:45:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-alarm-0545-0'].invoke();
  assert.equal(commands.filter(([command]) => command === 'ALARM_LEFT').length, 1);
});

it('leaves the side off and skips the alarm without that late turn-on', async t => {
  captureTimers(t);
  pod.left.isOn = false;
  replan(smartNight(), '2026-09-28T21:40:00Z');
  schedule.cancelJob(LATE_ON);
  setNow('2026-09-29T05:45:00Z');
  await schedule.scheduledJobs['rhythm-left-2026-09-28-alarm-0545-0'].invoke();
  assert.equal(commands.filter(([command]) => command === 'ALARM_LEFT').length, 0);
});

it('turns a sleep on late only once, only before its bedtime and only for Smart Schedule', async () => {
  replan(smartNight(), '2026-09-28T21:40:00Z');
  await schedule.scheduledJobs[LATE_ON].invoke();
  replan(smartNight(), '2026-09-28T21:50:00Z');
  assert.equal(schedule.scheduledJobs[LATE_ON], undefined, 'turned on twice');
  resetPowerOnTimes();
  replan(smartNight(), '2026-09-28T22:00:00Z');
  assert.equal(schedule.scheduledJobs[LATE_ON], undefined, 'turned on after bedtime');
  replan(testRhythmsDB(schedulesDB.data, everyNight(NIGHT)), '2026-09-28T21:40:00Z');
  assert.equal(schedule.scheduledJobs[LATE_ON], undefined, 'a manual sleep starts on its own clock');
});

it('keeps the late turn-on behind the pause gate', async () => {
  settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  await settingsDB.write();
  replan(smartNight(), '2026-09-28T21:40:00Z');
  await schedule.scheduledJobs[LATE_ON].invoke();
  assert.deepEqual(updates, []);
  replan(smartNight(), '2026-09-28T21:45:00Z');
  assert.equal(schedule.scheduledJobs[LATE_ON], undefined, 'a paused turn-on is not tried again');
});

it('does not turn a sleep on late again once it turned on', async () => {
  replan(smartNight(), '2026-09-28T21:40:00Z');
  await schedule.scheduledJobs[LATE_ON].invoke();
  await schedule.scheduledJobs[LATE_ON].invoke();
  assert.equal(updates.length, 1);
});

it('plans the analyses after the actual off and leaves the timer of a sleep kept on to its steps', () => {
  const side = everyNight(NIGHT);
  side.rhythms['every-night'].temperatureMode = 'smart';
  side.rhythms['every-night'].smart = { ...DEFAULT_SMART, offWhenUp: true };
  const db = testRhythmsDB(schedulesDB.data, side);
  const stamp = () => new Date().toISOString();
  const controller = startCurveController({
    now: () => new Date(),
    presence: () => ({ left: { present: true, lastUpdatedAt: stamp(), stateChangedAt: stamp() }, right: { present: false } }),
    awayMode: () => ({ left: false, right: false }),
    isPaused: () => false,
    sleeps: (sleepSide, from, to) => resolveSleeps({ db, side: sleepSide, timeZone: 'UTC', from, to, ...smartResolveHooks }),
    applyLevel: async () => {},
    retime: () => {},
    recordHistory: async () => {},
    smartOff: {
      sideIsOn: async () => true,
      powerOff: async () => true,
      armTimer: async () => true,
      alarmPending: () => false,
      nextRestart: () => null,
    },
  });
  try {
    setNow('2026-09-29T06:00:00Z');
    const [sleep] = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: at('2026-09-29T05:00:00Z'), to: at('2026-09-29T05:59:00Z') });
    assert.equal(controller.decideOff('left', sleep, new Date()), 'keep');
    setNow('2026-09-29T06:01:00Z');
    scheduleRhythms(settingsDB.data, db, new Date());
    const tonight = rhythmNames().filter(name => name.startsWith('rhythm-left-2026-09-28-') && /power-off|analysis|rearm/.test(name));
    assert.deepEqual(tonight, [
      'rhythm-left-2026-09-28-analysis-0915-0', 'rhythm-left-2026-09-28-analysis-1100-1', 'rhythm-left-2026-09-28-power-off-0900-0',
    ]);
  } finally {
    stopCurveController();
  }
});

// A "When I get up" day sleep on Tuesday only, from 08:00 with an 11:00 wake,
// so the noon analysis has no other sleep to step aside for.
const tuesdayDaySleep = (off: string) => {
  const side = everyNight(testNight('08:00', off));
  const rhythm = side.rhythms['every-night'];
  rhythm.wake = '11:00';
  rhythm.temperatureMode = 'smart';
  rhythm.smart = { ...DEFAULT_SMART, offWhenUp: true };
  for (const day of Object.keys(side.week) as (keyof typeof side.week)[]) if (day !== 'tuesday') side.week[day] = null;
  return testRhythmsDB(schedulesDB.data, side);
};
const smartOffController = (db: ReturnType<typeof testRhythmsDB>, present: boolean, since: string) => startCurveController({
  now: () => new Date(),
  presence: () => ({ left: { present, lastUpdatedAt: new Date().toISOString(), stateChangedAt: since }, right: { present: false } }),
  awayMode: () => ({ left: false, right: false }),
  isPaused: () => false,
  sleeps: (sleepSide, from, to) => resolveSleeps({ db, side: sleepSide, timeZone: 'UTC', from, to, ...smartResolveHooks }),
  applyLevel: async () => {},
  retime: () => {},
  recordHistory: async () => {},
  smartOff: {
    sideIsOn: async () => true,
    powerOff: async () => true,
    armTimer: async () => true,
    alarmPending: () => false,
    nextRestart: () => null,
  },
});
// The rebuild that follows an early off or a keep.
const rebuildAt = (db: ReturnType<typeof testRhythmsDB>, iso: string) => {
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  setNow(iso);
  scheduleRhythms(settingsDB.data, db, new Date());
  return rhythmNames().filter(name => name.startsWith('rhythm-left-2026-09-29-') && /power-off-|analysis-/.test(name));
};

it('moves the analyses to an early off and does not repeat them at noon', async () => {
  const db = tuesdayDaySleep('13:00');
  setNow('2026-09-28T11:00:00Z');
  scheduleRhythms(settingsDB.data, db, new Date());
  const noon = schedule.scheduledJobs['daily-analyze-sleep-left'];
  assert.ok(noon, 'the day before the sleep keeps its noon analysis');
  const controller = smartOffController(db, false, '2026-09-29T11:15:00Z');
  try {
    setNow('2026-09-29T11:30:00Z');
    await controller.tick();
    assert.equal(controller.powerOffFor('left', '2026-09-29')?.toISOString(), '2026-09-29T11:30:00.000Z');
    setNow('2026-09-29T12:00:00Z');
    await noon.invoke();
    assert.deepEqual(analyses, [], 'the noon run repeated the analysis of the sleep that ended early');
    assert.deepEqual(rebuildAt(db, '2026-09-29T11:31:00Z'), [
      'rhythm-left-2026-09-29-analysis-1145-0', 'rhythm-left-2026-09-29-analysis-1330-1',
    ]);
    assert.equal(schedule.scheduledJobs['daily-analyze-sleep-left'], undefined);
  } finally {
    stopCurveController();
  }
});

it('keeps the noon analysis out for a sleep kept on past noon', async () => {
  const db = tuesdayDaySleep('11:30');
  setNow('2026-09-28T11:00:00Z');
  scheduleRhythms(settingsDB.data, db, new Date());
  const noon = schedule.scheduledJobs['daily-analyze-sleep-left'];
  assert.ok(noon, 'the day before the sleep keeps its noon analysis');
  const controller = smartOffController(db, true, '2026-09-29T08:30:00Z');
  try {
    setNow('2026-09-29T11:30:00Z');
    const [sleep] = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: at('2026-09-29T11:00:00Z'), to: at('2026-09-29T11:29:00Z') });
    assert.equal(controller.decideOff('left', sleep, new Date()), 'keep');
    setNow('2026-09-29T12:00:00Z');
    await noon.invoke();
    assert.deepEqual(analyses, [], 'the noon run analysed a sleep still kept on');
    assert.deepEqual(rebuildAt(db, '2026-09-29T11:31:00Z'), [
      'rhythm-left-2026-09-29-analysis-1445-0', 'rhythm-left-2026-09-29-analysis-1630-1', 'rhythm-left-2026-09-29-power-off-1430-0',
    ]);
    assert.equal(schedule.scheduledJobs['daily-analyze-sleep-left'], undefined);
  } finally {
    stopCurveController();
  }
});
