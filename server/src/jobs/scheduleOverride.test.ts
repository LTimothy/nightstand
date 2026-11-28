import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';

// Same isolated-temp-DATA_FOLDER pattern as db/services.test.ts: config.ts
// reads DATA_FOLDER at import time, so this must be set before the dynamic
// imports below, and a fresh dir keeps this test off any real DB on disk.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-schedule-override-test-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

let settingsDB: typeof import('../db/settings.js')['default'];
let schedulesDB: typeof import('../db/schedules.js')['default'];
let markManualTempChange: typeof import('./scheduleOverride.js')['markManualTempChange'];
let isTempScheduleOverridden: typeof import('./scheduleOverride.js')['isTempScheduleOverridden'];
let OVERRIDE_DURATION_HOURS: typeof import('./scheduleOverride.js')['OVERRIDE_DURATION_HOURS'];

before(async () => {
  ({ default: settingsDB } = await import('../db/settings.js'));
  ({ default: schedulesDB } = await import('../db/schedules.js'));
  ({ markManualTempChange, isTempScheduleOverridden, OVERRIDE_DURATION_HOURS } = await import('./scheduleOverride.js'));
});

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

// Seeds a single temperature entry on the left side at `hoursFromNow`,
// wherever that lands relative to the real clock (today or tomorrow), so
// the weekly next-change walk in nextScheduledChange has exactly one
// candidate to find.
async function setNextScheduledChange(hoursFromNow: number) {
  await schedulesDB.read();
  const target = moment.tz('UTC').add(hoursFromNow, 'hours');
  const dayName = DAY_NAMES[target.day()];
  // Keep both power-on and its adjustment at the intended candidate time.
  schedulesDB.data.left[dayName].power = {
    on: target.format('HH:mm'), off: target.clone().add(6, 'hours').format('HH:mm'), enabled: true, onTemperature: 75,
  };
  schedulesDB.data.left[dayName].temperatures = { [target.format('HH:mm')]: 75 };
  await schedulesDB.write();
}

beforeEach(async () => {
  await settingsDB.read();
  settingsDB.data.timeZone = 'UTC';
  settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
  await settingsDB.write();

  await schedulesDB.read();
  for (const day of DAY_NAMES) {
    schedulesDB.data.left[day].temperatures = {};
    schedulesDB.data.left[day].power.enabled = false;
  }
  await schedulesDB.write();
});

describe('markManualTempChange', () => {
  it('pauses the schedule when the next change is within the override window', async () => {
    await setNextScheduledChange(1); // 1h away, inside the 3h window
    await markManualTempChange('left');

    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
    assert.equal(isTempScheduleOverridden('left'), true);
  });

  it('does not pause for turning on at the temperature the schedule has now', async () => {
    await setNextScheduledChange(1);
    await markManualTempChange('left', { targetF: 75, fromF: null, on: true, setsOn: true, source: 'api' });
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
  });

  it('still pauses for turning on at a different temperature', async () => {
    await setNextScheduledChange(1);
    await markManualTempChange('left', { targetF: 70, fromF: null, on: true, setsOn: true, source: 'api' });
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
  });

  it('does not pause the schedule when the next change is outside the window', async () => {
    await setNextScheduledChange(5); // 5h away, outside the 3h window
    await markManualTempChange('left');

    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
  });

  it('does nothing when there is no upcoming scheduled change', async () => {
    await markManualTempChange('left');

    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
  });

  it('sets an expiresAt roughly OVERRIDE_DURATION_HOURS in the future', async () => {
    await setNextScheduledChange(1);
    await markManualTempChange('left');

    await settingsDB.read();
    const expiresAt = moment(settingsDB.data.left.scheduleOverrides.temperatureSchedules.expiresAt);
    const expectedExpiry = moment().add(OVERRIDE_DURATION_HOURS, 'hours');
    assert.ok(Math.abs(expiresAt.diff(expectedExpiry, 'minutes')) < 2);
  });

  it('only affects the requested side', async () => {
    await setNextScheduledChange(1);
    await markManualTempChange('left');

    await settingsDB.read();
    assert.equal(settingsDB.data.right.scheduleOverrides.temperatureSchedules.disabled, false);
  });
});

describe('isTempScheduleOverridden', () => {
  it('returns false when disabled is false', () => {
    assert.equal(isTempScheduleOverridden('left'), false);
  });

  it('returns false when expiresAt is in the past', async () => {
    await settingsDB.read();
    settingsDB.data.left.scheduleOverrides.temperatureSchedules = {
      disabled: true,
      expiresAt: moment().subtract(1, 'hour').format(),
    };
    await settingsDB.write();

    assert.equal(isTempScheduleOverridden('left'), false);
  });

  it('returns true when disabled and expiresAt is in the future', async () => {
    await settingsDB.read();
    settingsDB.data.left.scheduleOverrides.temperatureSchedules = {
      disabled: true,
      expiresAt: moment().add(1, 'hour').format(),
    };
    await settingsDB.write();

    assert.equal(isTempScheduleOverridden('left'), true);
  });
});


describe('power-on temperature override', () => {
  it('protects a manual choice before power-on even without adjustment entries', async (t) => {
    t.mock.method(moment, 'now', () => Date.parse('2026-09-28T20:30:00Z'));
    for (const day of Object.values(schedulesDB.data.left)) day.power.enabled = false;
    schedulesDB.data.left.monday.power = { enabled: true, on: '21:00', off: '09:00', onTemperature: 75 };
    schedulesDB.data.left.monday.temperatures = {};
    await schedulesDB.write();
    await markManualTempChange('left');
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.expiresAt, '2026-09-29T08:30:00Z');
  });
});

describe('markManualTempChange on a Smart Schedule night', () => {
  it('holds the curve instead of pausing the schedule for 12 hours', async () => {
    const { startCurveController, stopCurveController, smartCurveStatus } = await import('./rhythms/curveController.js');
    const { applySmartCurve } = await import('./rhythms/smartSleep.js');
    await setNextScheduledChange(1);
    const minute = 60_000;
    const bedtime = new Date(Math.floor(Date.now() / minute) * minute - 60 * minute);
    const end = new Date(bedtime.getTime() + 9 * 60 * minute);
    const alarm = {
      time: '06:30', enabled: true, alarmTemperature: 82, vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 60,
    };
    const sleep = applySmartCurve({
      side: 'left',
      date: '2026-09-29',
      rhythmId: 'workday',
      start: bedtime,
      end,
      wake: new Date(end.getTime() - 60 * minute),
      night: { temperatures: {}, alarm, alarms: [], power: { on: '22:45', off: '07:45', onTemperature: 80, enabled: true } },
      mode: 'smart',
      smart: { baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false },
      events: [
        { kind: 'power-on', at: bedtime, temperatureF: 80 },
        { kind: 'alarm', at: new Date(end.getTime() - 60 * minute), alarm, index: 0 },
        { kind: 'power-off', at: end },
      ],
    }, 'UTC');
    startCurveController({
      now: () => new Date(),
      presence: () => ({ left: { present: false }, right: { present: false } }),
      awayMode: () => ({ left: false, right: false }),
      isPaused: () => false,
      sleeps: side => (side === 'left' ? [sleep] : []),
      applyLevel: async () => {},
      retime: () => {},
      recordHistory: async () => {},
    });
    try {
      await markManualTempChange('left');
      await settingsDB.read();
      assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
      assert.notEqual(smartCurveStatus('left')?.holdUntil ?? null, null);
    } finally {
      stopCurveController();
    }

    await markManualTempChange('left');
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
  });
});
