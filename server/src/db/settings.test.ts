import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import _ from 'lodash';

// config.ts throws if these aren't set, and reading it is what sets
// lowDbFolder for the db module under test. Must run before the dynamic
// import below. A fresh temp dir keeps this test isolated from any real
// settingsDB.json on the machine running it.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-settings-test-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
// Simulate an old on-disk doc from before the `features` field existed:
// empty object, nothing for the module-load merge to backfill from.
writeFileSync(path.join(dataFolder, 'lowdb', 'settingsDB.json'), '{}');
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

let settingsDB: typeof import('./settings.js')['default'];
let defaultFeatures: typeof import('./settingsSchema.js')['defaultFeatures'];

before(async () => {
  ({ default: settingsDB } = await import('./settings.js'));
  ({ defaultFeatures } = await import('./settingsSchema.js'));
});

describe('settingsDB defaultData merge', () => {
  it('backfills the features object on an old doc that predates it, keeping the weekly schedule', () => {
    assert.deepEqual(settingsDB.data.features, { ...defaultFeatures, rhythms: false });
  });

  it('pins the feature defaults', () => {
    const on = ['sleepScore', 'levelTemps', 'oneOffAlarms', 'presenceAutoOff', 'nightstandTheme', 'rhythms',
      'firmwareHealth', 'metricsLowDiskProtection', 'rhythmSuggestions'];
    for (const [key, value] of Object.entries(defaultFeatures)) assert.equal(value, on.includes(key), key);
  });

  it('backfills an inactive schedule pause for both sides', () => {
    for (const side of ['left', 'right'] as const) {
      assert.deepEqual(settingsDB.data[side].scheduleOverrides.pause, { active: false, expiresAt: '' });
    }
  });
});

describe('settingsDB cover button settings', () => {
  it('backfills the default buttons for both sides', () => {
    for (const side of ['left', 'right'] as const) {
      assert.deepEqual(settingsDB.data[side].buttons, { invertButtons: false, stepF: 1, favoriteTemperatureF: 80 });
    }
  });

  it('keeps buttons saved by the contributor build and validates a full round trip', async () => {
    const contributorSettings = {
      ...settingsDB.data,
      left: {
        ...settingsDB.data.left,
        name: 'Sleeper',
        buttons: { invertButtons: false, stepF: 1, favoriteTemperatureF: 80 },
      },
      right: {
        ...settingsDB.data.right,
        buttons: { invertButtons: true, stepF: 2, favoriteTemperatureF: 90 },
      },
      features: { ...settingsDB.data.features, coverButtons: true },
    };
    const settingsFile = path.join(dataFolder, 'lowdb', 'settingsDB.json');
    writeFileSync(settingsFile, JSON.stringify(contributorSettings));
    const loaded = await import(new URL('./settings.js?contributor-buttons', import.meta.url).href) as typeof import('./settings.js');
    const { SettingsSchema } = await import('./settingsSchema.js');
    assert.deepEqual(loaded.default.data, contributorSettings);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), contributorSettings);
    assert.equal(SettingsSchema.safeParse(loaded.default.data).success, true);
  });

  it('keeps a stored tap gesture whole on load', async () => {
    const stored = {
      ...settingsDB.data,
      left: { ...settingsDB.data.left, taps: { ...settingsDB.data.left.taps, quadTap: { type: 'set_temperature', temperatureF: 76 } } },
    };
    writeFileSync(path.join(dataFolder, 'lowdb', 'settingsDB.json'), JSON.stringify(stored));
    const loaded = await import(new URL('./settings.js?whole-taps', import.meta.url).href) as typeof import('./settings.js');
    assert.deepEqual(loaded.default.data.left.taps.quadTap, { type: 'set_temperature', temperatureF: 76 });
  });

  it('bounds the button settings as the contributor did', async () => {
    const { SettingsSchema } = await import('./settingsSchema.js');
    const accepts = (buttons: unknown) => SettingsSchema.deepPartial().safeParse({ left: { buttons } }).success;
    assert.equal(accepts({ stepF: 0 }), true);
    assert.equal(accepts({ stepF: 2.5, invertButtons: true, favoriteTemperatureF: 55 }), true);
    assert.equal(accepts({ favoriteTemperatureF: 110 }), true);
    for (const bad of [{ stepF: -1 }, { stepF: 11 }, { favoriteTemperatureF: 54 }, { favoriteTemperatureF: 111 },
      { favoriteTemperatureF: 80.5 }, { invertButtons: 'yes' }, { logo: 'favorite' }]) {
      assert.equal(accepts(bad), false, JSON.stringify(bad));
    }
  });

  // Releases before 3.7.0 have no buttons in SideSettingsSchema. They never
  // validate the stored file; their app reads settings through responseSchema,
  // which strips unknown keys, and posts only the fields it edits.
  it('stays readable by a settings schema without buttons', async () => {
    const { SettingsSchema } = await import('./settingsSchema.js');
    const { responseSchema } = await import('./responseSchema.js');
    const olderSide = SettingsSchema.shape.left.omit({ buttons: true });
    const older = SettingsSchema.extend({ left: olderSide, right: olderSide });
    const stored = {
      ...settingsDB.data,
      right: { ...settingsDB.data.right, buttons: { invertButtons: true, stepF: 2, favoriteTemperatureF: 90 } },
    };
    assert.equal(older.safeParse(stored).success, false, 'the older request schema is strict');
    const read = responseSchema(older).safeParse(stored);
    assert.ok(read.success);
    assert.equal('buttons' in read.data.right, false);
    assert.equal(older.deepPartial().safeParse({ right: { name: read.data.right.name } }).success, true);
  });
});

describe('settingsDB Rhythms on first start', () => {
  const lowdb = () => path.join(dataFolder, 'lowdb');

  it('keeps Rhythms off when a stored file predates the rhythms key', async () => {
    const older = _.omit(defaultFeatures, 'rhythms');
    writeFileSync(path.join(lowdb(), 'settingsDB.json'), JSON.stringify({ ...settingsDB.data, features: older }));
    const loaded = await import(new URL('./settings.js?upgrade', import.meta.url).href) as typeof import('./settings.js');
    assert.equal(loaded.default.data.features.rhythms, false);
    assert.equal(existsSync(path.join(lowdb(), 'rhythmsDB.json')), false);
  });

  it('keeps a stored Rhythms switch as it is', async () => {
    writeFileSync(path.join(lowdb(), 'settingsDB.json'), JSON.stringify({ features: { rhythms: true } }));
    const loaded = await import(new URL('./settings.js?stored-on', import.meta.url).href) as typeof import('./settings.js');
    assert.equal(loaded.default.data.features.rhythms, true);
    assert.equal(existsSync(path.join(lowdb(), 'rhythmsDB.json')), false);
  });

  it('turns Rhythms on for a new install with the weekly schedule converted, as the switch does', async () => {
    rmSync(path.join(lowdb(), 'settingsDB.json'));
    const loaded = await import(new URL('./settings.js?fresh', import.meta.url).href) as typeof import('./settings.js');
    const { default: schedulesDB } = await import('./schedules.js');
    const { loadRhythms } = await import('./rhythms.js');
    const { activation } = await import('../jobs/rhythms/activation.js');
    assert.equal(loaded.default.data.features.rhythms, true);
    assert.equal(JSON.parse(readFileSync(path.join(lowdb(), 'settingsDB.json'), 'utf8')).features.rhythms, true);
    assert.equal(activation(loaded.default.data, await loadRhythms(), schedulesDB.data).active, true);
  });

  it('treats the update channel the installer writes before the first start as a new install', async () => {
    rmSync(path.join(lowdb(), 'rhythmsDB.json'), { force: true });
    writeFileSync(path.join(lowdb(), 'settingsDB.json'), JSON.stringify({ updateChannel: 'beta' }));
    const loaded = await import(new URL('./settings.js?installer', import.meta.url).href) as typeof import('./settings.js');
    const { default: schedulesDB } = await import('./schedules.js');
    const { loadRhythms } = await import('./rhythms.js');
    const { activation } = await import('../jobs/rhythms/activation.js');
    assert.equal(loaded.default.data.updateChannel, 'beta');
    assert.equal(loaded.default.data.features.rhythms, true);
    assert.equal(activation(loaded.default.data, await loadRhythms(), schedulesDB.data).active, true);
  });

  it('leaves Rhythms off on a new install whose weekly schedule does not convert, as the switch does', async () => {
    const { default: schedulesDB } = await import('./schedules.js');
    const { testNight } = await import('../jobs/rhythms/testSupport.js');
    const saved = schedulesDB.data.left.monday;
    const eleven = Array.from({ length: 11 }, (_unused, index) => `05:${String(index * 5).padStart(2, '0')}`);
    schedulesDB.data.left.monday = testNight('23:00', '07:30', { alarms: eleven });
    rmSync(path.join(lowdb(), 'rhythmsDB.json'), { force: true });
    rmSync(path.join(lowdb(), 'settingsDB.json'));
    try {
      const loaded = await import(new URL('./settings.js?unconvertible', import.meta.url).href) as typeof import('./settings.js');
      assert.equal(loaded.default.data.features.rhythms, false);
      assert.equal(JSON.parse(readFileSync(path.join(lowdb(), 'settingsDB.json'), 'utf8')).features.rhythms, false);
      assert.equal(existsSync(path.join(lowdb(), 'rhythmsDB.json')), false);
    } finally {
      schedulesDB.data.left.monday = saved;
    }
  });
});

after(() => { rmSync(dataFolder, { recursive: true, force: true }); });
