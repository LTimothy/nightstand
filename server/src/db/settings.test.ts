import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  it('backfills the features object on an old doc that predates it', () => {
    assert.deepEqual(settingsDB.data.features, defaultFeatures);
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

after(() => { rmSync(dataFolder, { recursive: true, force: true }); });
