import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import schedule from 'node-schedule';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-rhythms-lifecycle-'));
const lowdb = path.join(folder, 'lowdb');
mkdirSync(lowdb);
// An existing settings file, so Rhythms starts off as on an updated Pod.
writeFileSync(path.join(lowdb, 'settingsDB.json'), '{}');
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T12:00:00Z') });
const updates: unknown[] = [];
const commands: unknown[][] = [];
const deviceStatus = { left: { isOn: true }, right: { isOn: true } };
mock.module('chokidar', { defaultExport: { watch: () => ({ on: () => undefined }) } });
mock.module(new URL('../isSystemDateValid.js', import.meta.url).href, { namedExports: { isSystemDateValid: () => true } });
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: { updateDeviceStatus: async (value: unknown) => { updates.push(value); } },
});
mock.module(new URL('../../8sleep/deviceApi.js', import.meta.url).href, {
  namedExports: { executeFunction: async (...args: unknown[]) => { commands.push(args); } },
});
mock.module(new URL('../../8sleep/frankenServer.js', import.meta.url).href, {
  namedExports: {
    connectFrankenWithin: async () => ({ getDeviceStatus: async () => deviceStatus }),
    isFrankenConnected: () => true,
    getDeviceStatusCoalesced: async () => deviceStatus,
  },
});
mock.module(new URL('../analyzeSleep.js', import.meta.url).href, { namedExports: { executeAnalyzeSleep: () => {} } });

const { default: settingsDB } = await import('../../db/settings.js');
const { default: schedulesDB } = await import('../../db/schedules.js');
const { updateRhythms } = await import('../../db/rhythms.js');
const { SCHEDULE_DAYS } = await import('../../db/scheduleKeys.js');
const { everyNight, testNight } = await import('./testSupport.js');
const { ENABLE_ERRORS, enableRhythms } = await import('./enable.js');
const { disableRhythms } = await import('./handoff.js');
const { keepSleepAlarms } = await import('./scheduleRhythms.js');
const { resolveSleeps } = await import('./resolve.js');
const { engineActivation } = await import('../scheduleQueries.js');

const file = (name: string) => path.join(lowdb, name);
const setNow = (iso: string) => mock.timers.setTime(Date.parse(iso));
const rhythmJobsLeft = () => Object.keys(schedule.scheduledJobs).some(name => name.startsWith('rhythm'));
let setupJobs!: typeof import('../jobScheduler.js')['setupJobs'];
let schedulesBefore = '';

async function readSettings() {
  await settingsDB.read();
  return settingsDB.data;
}

before(async () => {
  settingsDB.data.timeZone = 'UTC';
  settingsDB.data.features.rhythms = false;
  await settingsDB.write();
  for (const day of SCHEDULE_DAYS) {
    schedulesDB.data.left[day] = testNight('23:00', '07:30', { alarms: ['07:15'] });
    schedulesDB.data.right[day] = testNight('23:00', '07:30', { enabled: false });
  }
  await schedulesDB.write();
  ({ setupJobs } = await import('../jobScheduler.js'));
  await setupJobs();
  schedulesBefore = readFileSync(file('schedulesDB.json'), 'utf8');
});

after(async () => {
  Object.keys(schedule.scheduledJobs).forEach(name => schedule.cancelJob(name));
  await schedule.gracefulShutdown();
  mock.timers.reset();
  rmSync(folder, { recursive: true, force: true });
});

describe('turning Rhythms on and off', () => {
  it('turns on from the weekly schedule without touching it', async () => {
    assert.deepEqual(await enableRhythms(setupJobs), { converted: true });
    assert.equal((await readSettings()).features.rhythms, true);
    assert.ok(existsSync(file('rhythmsDB.json')));
    assert.equal(readFileSync(file('schedulesDB.json'), 'utf8'), schedulesBefore);
    assert.ok(schedule.scheduledJobs['rhythm-left-2026-09-28-power-on-2300-0'], 'the converted rhythm was not scheduled');
    assert.equal(schedule.scheduledJobs['left-monday-23:00-power-on'], undefined);
  });

  it('hands a sleep back to the weekly night after its rhythm alarm rang', async () => {
    await updateRhythms(draft => {
      draft.left = everyNight(testNight('22:00', '06:30', { alarms: ['06:00'] }));
      draft.right = everyNight(testNight('08:00', '16:00'));
    });
    await setupJobs();
    const rhythmsBefore = readFileSync(file('rhythmsDB.json'), 'utf8');

    setNow('2026-09-29T06:00:00Z');
    const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as unknown as NodeJS.Timeout);
    try {
      await schedule.scheduledJobs['rhythm-left-2026-09-28-alarm-0600-0'].invoke();
    } finally {
      timer.mock.restore();
    }
    assert.equal(commands.filter(([name]) => name === 'ALARM_LEFT').length, 1);

    setNow('2026-09-29T06:10:00Z');
    updates.length = 0;
    const report = await disableRhythms({ powerOffNow: false }, setupJobs);
    assert.deepEqual(report, { sides: [
      { side: 'left', action: 'legacy-takes-over', until: '2026-09-29T07:30:00.000Z', alarmOverrideSet: true },
      { side: 'right', action: 'none', alarmOverrideSet: false },
    ] });
    assert.deepEqual(updates, [{ left: { secondsRemaining: 80 * 60 + 300 } }]);
    const settings = await readSettings();
    assert.equal(settings.features.rhythms, false);
    assert.deepEqual(settings.left.scheduleOverrides.alarm, { disabled: true, timeOverride: '', expiresAt: '2026-09-29T07:30:00Z' });
    assert.equal(rhythmJobsLeft(), false);
    assert.ok(schedule.scheduledJobs['left-monday-07:15-0-alarm']);
    assert.equal(readFileSync(file('schedulesDB.json'), 'utf8'), schedulesBefore);
    assert.equal(readFileSync(file('rhythmsDB.json'), 'utf8'), rhythmsBefore);

    setNow('2026-09-29T07:15:00Z');
    commands.length = 0;
    await schedule.scheduledJobs['left-monday-07:15-0-alarm'].invoke();
    assert.deepEqual(commands, [], 'the weekly alarm rang after the rhythm alarm');
  });

  it('keeps a day sleep on until its end when the weekly schedule has none', async () => {
    setNow('2026-09-29T10:00:00Z');
    assert.deepEqual(await enableRhythms(setupJobs), { converted: false });
    updates.length = 0;
    const report = await disableRhythms({ powerOffNow: false }, setupJobs);
    assert.deepEqual(report.sides, [
      { side: 'left', action: 'none', alarmOverrideSet: false },
      { side: 'right', action: 'kept-on-until', until: '2026-09-29T16:00:00.000Z', alarmOverrideSet: false },
    ]);
    assert.deepEqual(updates, []);
  });

  it('rings the alarm of a sleep it keeps on, and forgets it once Rhythms takes over again', async () => {
    await updateRhythms(draft => { draft.right = everyNight(testNight('08:00', '16:00', { alarms: ['15:30'] })); });
    setNow('2026-09-29T10:00:00Z');
    await enableRhythms(setupJobs);
    const report = await disableRhythms({ powerOffNow: false }, setupJobs);
    assert.equal(report.sides[1].action, 'kept-on-until');
    const name = 'rhythm-right-2026-09-29-alarm-1530-0';
    const rhythmJobs = () => Object.keys(schedule.scheduledJobs).filter(item => item.startsWith('rhythm'));
    assert.deepEqual(rhythmJobs(), [name], 'the kept alarm was not scheduled');

    await setupJobs();
    assert.deepEqual(rhythmJobs(), [name], 'a rebuild during the sleep dropped the kept alarm');

    setNow('2026-09-29T15:30:00Z');
    commands.length = 0;
    const timer = mock.method(globalThis, 'setTimeout', () => ({ unref() {} }) as unknown as NodeJS.Timeout);
    try {
      await schedule.scheduledJobs[name].invoke();
    } finally {
      timer.mock.restore();
    }
    assert.equal(commands.filter(([command]) => command === 'ALARM_RIGHT').length, 1);

    setNow('2026-09-29T10:00:00Z');
    await enableRhythms(setupJobs);
    await disableRhythms({ powerOffNow: true }, setupJobs);
    assert.deepEqual(rhythmJobs(), [], 'the kept alarm came back after Rhythms took over and was turned off again');
  });

  it('keeps no alarm when the side is powered off now or the weekly night takes over', async () => {
    await updateRhythms(draft => { draft.right = everyNight(testNight('08:00', '16:00', { alarms: ['15:30'] })); });
    setNow('2026-09-29T10:00:00Z');
    await enableRhythms(setupJobs);
    await disableRhythms({ powerOffNow: true }, setupJobs);
    assert.equal(rhythmJobsLeft(), false, 'a powered-off side kept an alarm');
  });

  it('powers a side off now when asked', async () => {
    await enableRhythms(setupJobs);
    updates.length = 0;
    const report = await disableRhythms({ powerOffNow: true }, setupJobs);
    assert.deepEqual(report.sides[1], { side: 'right', action: 'powered-off', alarmOverrideSet: false });
    assert.deepEqual(updates, [{ right: { isOn: false } }]);
    assert.equal(rhythmJobsLeft(), false);
  });

  it('goes back to Rhythms after the weekly schedule changed in another version', async () => {
    await enableRhythms(setupJobs);
    // Another version edits the weekly schedule while the flag stays on.
    schedulesDB.data.left.monday.power.on = '23:10';
    await schedulesDB.write();
    await setupJobs();
    assert.equal(rhythmJobsLeft(), false, 'Rhythms ran over a changed weekly schedule');
    assert.equal((await readSettings()).features.rhythms, true);
    assert.deepEqual(await enableRhythms(setupJobs), { converted: false });
    assert.ok(rhythmJobsLeft(), 'going back did not run the saved rhythms');
    assert.equal(JSON.parse(readFileSync(file('schedulesDB.json'), 'utf8')).left.monday.power.on, '23:10');
    await disableRhythms({ powerOffNow: false }, setupJobs);
  });

  it('keeps the alarm when a rebuild that saw Rhythms on ends after the turn off', async () => {
    await updateRhythms(draft => { draft.right = everyNight(testNight('08:00', '16:00', { alarms: ['15:30'] })); });
    setNow('2026-09-29T10:00:00Z');
    await enableRhythms(setupJobs);
    const engine = engineActivation();
    assert.ok(engine.active);
    const now = new Date();
    const [sleep] = resolveSleeps({ db: engine.db, side: 'right', timeZone: 'UTC', from: now, to: now });
    const readSchedules = schedulesDB.read.bind(schedulesDB);
    const read = mock.method(schedulesDB, 'read', readSchedules);
    // The turn off lands after this rebuild read the flag, before it ends.
    read.mock.mockImplementationOnce(async () => {
      await readSchedules();
      await settingsDB.adapter.write({ ...settingsDB.data, features: { ...settingsDB.data.features, rhythms: false } });
      keepSleepAlarms('right', sleep, now, 'UTC');
      void setupJobs();
    });
    try {
      await setupJobs();
    } finally {
      read.mock.restore();
    }
    const rhythmJobs = Object.keys(schedule.scheduledJobs).filter(name => name.startsWith('rhythm'));
    assert.deepEqual(rhythmJobs, ['rhythm-right-2026-09-29-alarm-1530-0']);
    assert.equal((await readSettings()).features.rhythms, false);
  });

  it('refuses to turn on over data from a newer version and leaves the file alone', async () => {
    const newer = JSON.stringify({ version: 99, somethingNew: true });
    writeFileSync(file('rhythmsDB.json'), newer);
    assert.deepEqual(await enableRhythms(setupJobs), { error: ENABLE_ERRORS.unsupported });
    assert.equal(readFileSync(file('rhythmsDB.json'), 'utf8'), newer);
    assert.equal((await readSettings()).features.rhythms, false);
  });

  it('refuses to turn on when a weekly night cannot become a rhythm, and writes nothing', async () => {
    rmSync(file('rhythmsDB.json'));
    const eleven = Array.from({ length: 11 }, (_, index) => `05:${String(index * 5).padStart(2, '0')}`);
    schedulesDB.data.left.tuesday = testNight('23:00', '07:30', { alarms: eleven });
    await schedulesDB.write();
    assert.deepEqual(await enableRhythms(setupJobs), { error: ENABLE_ERRORS.unconvertible });
    assert.equal(existsSync(file('rhythmsDB.json')), false);
    assert.equal((await readSettings()).features.rhythms, false);
  });
});
