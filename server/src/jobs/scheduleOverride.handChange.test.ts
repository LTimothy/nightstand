import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-override-hand-change-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';

const calls: string[] = [];
const recorded: unknown[][] = [];
let smartAnswer: 'held' | 'smart-ahead' | 'not-smart' = 'not-smart';
mock.module(new URL('./rhythms/handChanges.js', import.meta.url).href, {
  namedExports: { recordHandChange: (...args: unknown[]) => { calls.push('record'); recorded.push(args); } },
});
mock.module(new URL('./rhythms/curveController.js', import.meta.url).href, {
  namedExports: {
    smartManualChange: () => { calls.push('smart'); return smartAnswer; },
    smartResolveHooks: { coolStartFor: () => undefined, powerOffFor: () => undefined },
  },
});

const { default: settingsDB } = await import('../db/settings.js');
const { default: schedulesDB } = await import('../db/schedules.js');
const { markManualTempChange } = await import('./scheduleOverride.js');

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const change = { targetF: 79, fromF: 82, on: true, setsOn: false, source: 'api' as const };

beforeEach(async () => {
  calls.length = 0;
  recorded.length = 0;
  smartAnswer = 'not-smart';
  await settingsDB.read();
  settingsDB.data.timeZone = 'UTC';
  settingsDB.data.left.scheduleOverrides.temperatureSchedules = { disabled: false, expiresAt: '' };
  await settingsDB.write();
  // One weekly step an hour from now, inside the 3 hour override window.
  await schedulesDB.read();
  const target = moment.tz('UTC').add(1, 'hour');
  for (const day of DAYS) schedulesDB.data.left[day].power.enabled = false;
  schedulesDB.data.left[DAYS[target.day()]].power = {
    on: target.format('HH:mm'), off: target.clone().add(6, 'hours').format('HH:mm'), enabled: true, onTemperature: 75,
  };
  schedulesDB.data.left[DAYS[target.day()]].temperatures = { [target.format('HH:mm')]: 75 };
  await schedulesDB.write();
});
after(() => rmSync(folder, { recursive: true, force: true }));

describe('markManualTempChange with a change', () => {
  it('records before the Smart Schedule hold, which then returns early', async () => {
    smartAnswer = 'held';
    await markManualTempChange('left', change);
    assert.deepEqual(calls, ['record', 'smart']);
    assert.deepEqual(recorded, [['left', change]]);
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, false);
  });

  it('still sets the 12 hour override on a hand-set night', async () => {
    await markManualTempChange('left', change);
    assert.deepEqual(calls, ['record', 'smart']);
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
  });

  it('records nothing without a change, as before', async () => {
    await markManualTempChange('left');
    assert.deepEqual(calls, ['smart']);
    await settingsDB.read();
    assert.equal(settingsDB.data.left.scheduleOverrides.temperatureSchedules.disabled, true);
  });
});
