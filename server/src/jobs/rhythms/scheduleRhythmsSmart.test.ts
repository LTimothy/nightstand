import assert from 'node:assert/strict';
import { describe, it, before, after, mock } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';
import schedule from 'node-schedule';
import type { DayOfWeek } from '../../db/schedulesSchema.js';
import type { RhythmsDB } from '../../db/rhythmsSchema.js';

// config.ts reads DATA_FOLDER at import time, so set it before importing.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-smart-jobs-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
// An existing settings file, so Rhythms starts off as on an updated Pod.
writeFileSync(path.join(dataFolder, 'lowdb', 'settingsDB.json'), '{}');
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

const updates: unknown[] = [];
mock.module(new URL('../../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: { updateDeviceStatus: async (update: unknown) => { updates.push(update); } },
});

let settingsDB: typeof import('../../db/settings.js')['default'];
let schedulesDB: typeof import('../../db/schedules.js')['default'];
let rhythmsSchema: typeof import('../../db/rhythmsSchema.js');
let createRhythms: typeof import('../../db/rhythms.js')['createRhythms'];
let legacyFingerprint: typeof import('./fingerprint.js')['legacyFingerprint'];
let resolveSleeps: typeof import('./resolve.js')['resolveSleeps'];
let scheduleRhythms: typeof import('./scheduleRhythms.js')['scheduleRhythms'];
let controllerModule: typeof import('./curveController.js');

before(async () => {
  ({ default: settingsDB } = await import('../../db/settings.js'));
  ({ default: schedulesDB } = await import('../../db/schedules.js'));
  rhythmsSchema = await import('../../db/rhythmsSchema.js');
  ({ createRhythms } = await import('../../db/rhythms.js'));
  ({ legacyFingerprint } = await import('./fingerprint.js'));
  ({ resolveSleeps } = await import('./resolve.js'));
  ({ scheduleRhythms } = await import('./scheduleRhythms.js'));
  controllerModule = await import('./curveController.js');
});

after(() => {
  for (const name of Object.keys(schedule.scheduledJobs)) schedule.cancelJob(name);
});

const TZ = 'America/Los_Angeles';
// Tomorrow keeps every job inside the 48 hour horizon and in the future.
const DATE = moment.tz(TZ).add(1, 'day').format('YYYY-MM-DD');
const WEEKDAY = moment.tz(DATE, 'YYYY-MM-DD', TZ).format('dddd').toLowerCase() as DayOfWeek;
const at = (hhmm: string) => moment.tz(`${DATE} ${hhmm}`, 'YYYY-MM-DD HH:mm', TZ).toDate();
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe('Smart Schedule temperature jobs', () => {
  it('skip while a manual change holds the curve, then run again', async () => {
    await settingsDB.read();
    settingsDB.data.timeZone = TZ;
    settingsDB.data.features.rhythms = true;
    await settingsDB.write();
    await schedulesDB.read();

    const { DEFAULT_SMART, RHYTHMS_FILE_VERSION } = rhythmsSchema;
    const noWeek = { sunday: null, monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null };
    const alarm = {
      time: '06:30', enabled: true, alarmTemperature: 82, vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 60,
    };
    const db: RhythmsDB = {
      version: RHYTHMS_FILE_VERSION,
      legacyFingerprint: legacyFingerprint(schedulesDB.data),
      left: {
        rhythms: {
          workday: {
            id: 'workday',
            name: 'Workday',
            night: { temperatures: {}, alarm, alarms: [], power: { on: '22:45', off: '07:30', onTemperature: 80, enabled: true } },
            wake: '06:30',
            temperatureMode: 'smart' as const,
            smart: { ...DEFAULT_SMART },
          },
        },
        week: { ...noWeek, [WEEKDAY]: 'workday' },
        changes: [],
      },
      right: { rhythms: {}, week: noWeek, changes: [] },
    };
    await createRhythms(db);
    scheduleRhythms(settingsDB.data, db, new Date());

    const job = (hhmm: string) => {
      const name = Object.keys(schedule.scheduledJobs).find(item => item.startsWith(`rhythm-left-${DATE}-temperature-${hhmm}-`));
      assert.ok(name, `a temperature job at ${hhmm}`);
      return schedule.scheduledJobs[name];
    };
    const run = async (hhmm: string) => {
      await Promise.resolve(job(hhmm).invoke() as unknown);
      await settle();
    };

    const { startCurveController, stopCurveController, smartCoolStartFor } = controllerModule;
    const controller = startCurveController({
      now: () => at('23:00'),
      presence: () => ({ left: { present: false }, right: { present: false } }),
      awayMode: () => ({ left: false, right: false }),
      isPaused: () => false,
      sleeps: (side, from, to) => resolveSleeps({ db, side, timeZone: TZ, from, to, coolStartFor: smartCoolStartFor }),
      applyLevel: async () => {},
      retime: () => {},
      recordHistory: async () => {},
    });
    try {
      assert.equal(controller.noteManualChange('left', at('23:00')), 'held');
      await run('2310');
      assert.equal(updates.length, 0);
      await run('2355');
      assert.equal(updates.length, 1);
      assert.match(JSON.stringify(updates[0]), /"targetTemperatureF":77/);
    } finally {
      stopCurveController();
    }
  });
});
