import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-schedule-queries-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

const { default: settingsDB } = await import('../db/settings.js');
const { default: schedulesDB } = await import('../db/schedules.js');
const { SCHEDULE_DAYS } = await import('../db/scheduleKeys.js');
const queries = await import('./scheduleQueries.js');
const { markManualTempChange } = await import('./scheduleOverride.js');
const { everyNight, testNight, testRhythmsDB } = await import('./rhythms/testSupport.js');

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  settingsDB.data.timeZone = 'UTC';
  settingsDB.data.left.awayMode = false;
  settingsDB.data.right.awayMode = false;
  settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
  for (const day of SCHEDULE_DAYS) {
    schedulesDB.data.left[day] = testNight('21:00', '07:00', { temperatures: { '23:00': 70 } });
    schedulesDB.data.right[day] = testNight('21:00', '07:00', { enabled: false });
  }
  queries.setEngineActivation({ active: false, reason: 'flag-off' });
});

describe('effectiveSides', () => {
  it('drives only its own side when nobody is away', () => {
    assert.deepEqual(queries.effectiveSides(settingsDB.data, 'left'), ['left']);
    assert.equal(queries.drivingSide(settingsDB.data, 'left'), 'left');
  });

  it('lets the present side drive the whole bed and ignores the away side', () => {
    settingsDB.data.right.awayMode = true;
    assert.deepEqual(queries.effectiveSides(settingsDB.data, 'left'), ['left', 'right']);
    assert.deepEqual(queries.effectiveSides(settingsDB.data, 'right'), []);
    assert.equal(queries.drivingSide(settingsDB.data, 'right'), 'left');
  });

  it('drives nothing when both sides are away', () => {
    settingsDB.data.left.awayMode = true;
    settingsDB.data.right.awayMode = true;
    assert.deepEqual(queries.effectiveSides(settingsDB.data, 'left'), []);
    assert.equal(queries.drivingSide(settingsDB.data, 'left'), null);
  });
});

describe('weekly engine answers', () => {
  it('keeps the power window semantics', () => {
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-28T22:00:00Z')), true);
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-29T06:59:00Z')), true);
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-29T07:00:00Z')), false);
    assert.equal(queries.isInScheduledSleep('right', at('2026-09-28T22:00:00Z')), false);
  });

  it('finds the next power-on or temperature row', () => {
    assert.equal(queries.nextScheduledChange('left', at('2026-09-28T22:00:00Z'))?.toISOString(), '2026-09-28T23:00:00.000Z');
    assert.equal(queries.nextScheduledChange('left', at('2026-09-28T23:30:00Z'))?.toISOString(), '2026-09-29T21:00:00.000Z');
  });

  it('reports the scheduled temperature now and before the next sleep', () => {
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-28T23:30:00Z')), 70);
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-28T22:00:00Z')), 80);
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-29T12:00:00Z')), 80);
    assert.equal(queries.currentSleep('left', at('2026-09-28T22:00:00Z'))?.rhythmId, null);
  });
});

describe('Rhythms engine answers', () => {
  beforeEach(() => {
    const db = testRhythmsDB(schedulesDB.data, everyNight(testNight('08:00', '16:00', { temperatures: { '12:00': 75 } })));
    queries.setEngineActivation({ active: true, db });
  });

  it('answers from the rhythm instead of the weekly schedule', () => {
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-28T10:00:00Z')), true);
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-28T22:00:00Z')), false);
    assert.equal(queries.currentSleep('left', at('2026-09-28T10:00:00Z'))?.date, '2026-09-28');
    assert.equal(queries.nextScheduledChange('left', at('2026-09-28T10:00:00Z'))?.toISOString(), '2026-09-28T12:00:00.000Z');
    assert.equal(queries.nextScheduledChange('left', at('2026-09-28T13:00:00Z'))?.toISOString(), '2026-09-29T08:00:00.000Z');
  });

  it('reports the rhythm temperature now and the next power-on temperature', () => {
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-28T13:00:00Z')), 75);
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-28T07:00:00Z')), 80);
    assert.equal(queries.scheduledTemperatureNow('left', at('2026-09-28T17:00:00Z')), 80);
    assert.equal(queries.scheduledTemperatureNow('right', at('2026-09-28T13:00:00Z')), null);
  });

  it('follows the present side while the other side is away', () => {
    settingsDB.data.right.awayMode = true;
    assert.equal(queries.currentSleep('right', at('2026-09-28T10:00:00Z'))?.side, 'left');
    assert.equal(queries.isInScheduledSleep('right', at('2026-09-28T10:00:00Z')), true);
    settingsDB.data.left.awayMode = true;
    assert.equal(queries.currentSleep('right', at('2026-09-28T10:00:00Z')), null);
  });

  it('holds a manual change made within three hours of the next rhythm change', async () => {
    await settingsDB.write();
    await schedulesDB.write();
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-28T10:30:00Z') });
    try {
      await markManualTempChange('left');
    } finally {
      mock.timers.reset();
    }
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
  });
});

describe('isInScheduledSleep with the weekly engine', () => {
  for (const [on, off, time, expected] of [
    ['21:00', '07:00', '2026-09-28T20:59:00Z', false], ['21:00', '07:00', '2026-09-28T21:00:00Z', true],
    ['21:00', '07:00', '2026-09-29T06:59:00Z', true], ['21:00', '07:00', '2026-09-29T07:00:00Z', false],
    ['13:00', '15:00', '2026-09-28T14:00:00Z', true], ['13:00', '15:00', '2026-09-28T15:00:00Z', false],
    ['07:00', '07:00', '2026-09-29T06:59:00Z', true],
  ] as const) {
    it(`${on} to ${off} at ${time.slice(11, 16)} is ${expected ? 'inside' : 'outside'}`, () => {
      for (const day of SCHEDULE_DAYS) schedulesDB.data.left[day] = testNight(on, off);
      assert.equal(queries.isInScheduledSleep('left', at(time)), expected);
    });
  }
  it('is outside on a day whose power is off', () => {
    for (const day of SCHEDULE_DAYS) schedulesDB.data.left[day] = testNight('21:00', '07:00', { enabled: false });
    assert.equal(queries.isInScheduledSleep('left', at('2026-09-28T23:00:00Z')), false);
  });
});
