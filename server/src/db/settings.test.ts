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

describe('settingsDB contributor button settings migration', () => {
  it('removes obsolete side buttons and validates a full settings round trip', async () => {
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
    const migrated = await import(new URL('./settings.js?contributor-buttons', import.meta.url).href) as typeof import('./settings.js');
    const { SettingsSchema } = await import('./settingsSchema.js');
    const expected = {
      ...settingsDB.data,
      left: { ...settingsDB.data.left, name: 'Sleeper' },
      features: { ...settingsDB.data.features, coverButtons: true },
    };
    assert.deepEqual(migrated.default.data, expected);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), expected);
    assert.equal(SettingsSchema.deepPartial().safeParse(migrated.default.data).success, true);
  });
});

after(() => { rmSync(dataFolder, { recursive: true, force: true }); });
