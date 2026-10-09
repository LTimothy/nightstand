import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES_MANIFEST } from './featuresManifest.js';
import { defaultFeatures } from '../db/settingsSchema.js';

const REQUIRED_FIELDS = [
  'id', 'title', 'description', 'category', 'version', 'touchpoints',
  'depends_on', 'reversible', 'tests', 'upstream_offer', 'rationale',
] as const;

const isFeaturesSchemaKey = (flag: unknown): flag is keyof typeof defaultFeatures =>
  typeof flag === 'string' && flag in defaultFeatures;

// featuresManifest.ts is the catalog releases.json names features from, so a
// typo in either would otherwise only surface at install time.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const releasesManifest = JSON.parse(readFileSync(path.join(repoRoot, 'releases.json'), 'utf8'));

describe('FEATURES_MANIFEST', () => {
  it('has every required field, non-empty where it is a string', () => {
    for (const entry of FEATURES_MANIFEST) {
      for (const field of REQUIRED_FIELDS) {
        const value = entry[field];
        assert.notEqual(value, undefined, `${entry.id}.${field} is missing`);
        if (typeof value === 'string') {
          assert.notEqual(value.trim(), '', `${entry.id}.${field} is empty`);
        }
      }
    }
  });

  it('has unique ids', () => {
    const ids = FEATURES_MANIFEST.map((entry) => entry.id);
    assert.deepEqual(ids, [...new Set(ids)]);
  });

  it('has every depends_on reference a real entry in the same manifest', () => {
    const ids = new Set(FEATURES_MANIFEST.map((entry) => entry.id));
    for (const entry of FEATURES_MANIFEST) {
      for (const dep of entry.depends_on) {
        assert.ok(ids.has(dep), `${entry.id} depends_on unknown id "${dep}"`);
      }
    }
  });

  // biometrics and base-control document their own external mechanisms in
  // flag as prose (a separate lowdb store, hardware-file presence), not a
  // FeaturesSchema key, so they are exempt from the default-matches-live-
  // default check below by design, not by oversight.
  it('has a default matching the live schema default, for every entry whose flag is a real FeaturesSchema key', () => {
    for (const entry of FEATURES_MANIFEST) {
      if (!isFeaturesSchemaKey(entry.flag)) continue;
      assert.equal(
        entry.default,
        defaultFeatures[entry.flag],
        `${entry.id}'s manifest default does not match settingsSchema.ts's defaultFeatures.${entry.flag}`,
      );
    }
  });

  // The rule in CONTRIBUTING.md: an optional feature ships behind a Settings >
  // Features toggle and has a manifest entry. nightstandTheme is the one key
  // nothing reads; it stays in the schema only so stored settings validate.
  it('has an entry for every settings feature flag', () => {
    const flags = new Set(FEATURES_MANIFEST.map((entry) => entry.flag));
    for (const key of Object.keys(defaultFeatures)) {
      if (key === 'nightstandTheme') continue;
      assert.ok(flags.has(key), `settings.features.${key} has no featuresManifest entry`);
    }
  });

  it('lists schedule pause as always on', () => {
    const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === 'schedule-pause');
    assert.ok(entry, 'schedule-pause has no featuresManifest entry');
    assert.equal(entry.flag, null);
    assert.equal(entry.default, true);
    for (const file of [...entry.touchpoints, ...entry.tests]) {
      assert.ok(existsSync(path.join(repoRoot, file)), `${file} does not exist`);
    }
  });

  it('lists boot update recovery as always-on safety with files that exist', () => {
    const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === 'update-recovery');
    assert.ok(entry, 'update-recovery has no featuresManifest entry');
    assert.equal(entry.category, 'safety');
    assert.equal(entry.version, '3.6.0');
    assert.equal(entry.flag, null);
    assert.equal(entry.default, true);
    for (const file of [...entry.touchpoints, ...entry.tests]) {
      assert.ok(existsSync(path.join(repoRoot, file)), `${file} does not exist`);
    }
  });

  it('describes the interrupted update outcome shown after recovery', () => {
    const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === 'update-recovery');
    assert.ok(entry);
    assert.match(entry.description, /records the outcome/);
    assert.match(entry.description, /server or Biometrics restart failures/);
    assert.doesNotMatch(entry.description, /records no new result/);
  });

  it('points update, biometrics, alarm tap and cover button entries at files that exist', () => {
    for (const id of ['agent', 'biometrics', 'tap-alarm', 'cover-buttons']) {
      const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === id);
      assert.ok(entry, `${id} has no featuresManifest entry`);
      for (const file of [...entry.touchpoints, ...entry.tests]) {
        assert.ok(existsSync(path.join(repoRoot, file)), `${file} does not exist`);
      }
    }
  });

  it('lists rhythms as an optional feature whose files exist', () => {
    const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === 'rhythms');
    assert.ok(entry, 'rhythms has no featuresManifest entry');
    assert.equal(entry.flag, 'rhythms');
    assert.equal(entry.default, false);
    assert.equal(entry.reversible, true);
    assert.ok(entry.tests.includes('server/src/jobs/rhythms/equivalence.test.ts'), 'the equivalence gate is listed');
    assert.ok(entry.touchpoints.includes('app/src/pages/SchedulePage/ScheduleTab.tsx'), 'the app screens are listed');
    assert.ok(entry.tests.includes('app/src/pages/ControlTempPage/BedRhythms.test.tsx'), 'the app tests are listed');
    for (const file of [...entry.touchpoints, ...entry.tests]) {
      assert.ok(existsSync(path.join(repoRoot, file)), `${file} does not exist`);
    }
  });

  it('points biometrics-v2 at files that exist', () => {
    const entry = FEATURES_MANIFEST.find((candidate) => candidate.id === 'biometrics-v2');
    assert.ok(entry, 'biometrics-v2 has no featuresManifest entry');
    for (const file of [...entry.touchpoints, ...entry.tests]) {
      assert.ok(existsSync(path.join(repoRoot, file)), `${file} does not exist`);
    }
  });

  // No bundle releases exist yet, so this passes vacuously today. It is the
  // guard that arms the moment the first one lands.
  it('has every feature id named by a bundle release', () => {
    const ids = new Set(FEATURES_MANIFEST.map((entry) => entry.id));
    for (const release of releasesManifest.releases) {
      if (release.kind !== 'bundle') continue;
      for (const feature of release.features) {
        assert.ok(ids.has(feature), `releases.json bundle v${release.version} names unknown feature "${feature}"`);
      }
    }
  });
});
