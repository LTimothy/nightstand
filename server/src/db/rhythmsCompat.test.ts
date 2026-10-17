import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { DEFAULT_SMART, RhythmsDBSchema, RhythmsUpdateSchema, SmartScheduleSchema } from './rhythmsSchema.js';
import type { responseSchema } from './responseSchema.js';
import { dbOf, rhythmOf, sideOf, WORKDAY } from '../jobs/rhythms/rhythmsTestData.js';

// The 3.5.0 schema files, kept verbatim as text and transpiled here, so they never build into dist.
const FIXTURES = new URL('../../../fixtures/compat/v3.5.0/', import.meta.url);
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-v350-schemas-'));
let RhythmsDBSchemaV350: typeof RhythmsDBSchema;
// What 3.5.0 runs on every read of rhythmsDB.json (db/rhythms.ts in that release).
let readV350: typeof RhythmsDBSchema;

before(async () => {
  const zod = import.meta.resolve('zod');
  for (const name of ['schedulesSchema', 'responseSchema', 'rhythmsSchema']) {
    const source = readFileSync(new URL(`${name}.ts.txt`, FIXTURES), 'utf8')
      .replaceAll("from 'zod'", `from '${zod}'`)
      .replaceAll("from './schedulesSchema.js'", "from './schedulesSchema.mjs'");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(path.join(folder, `${name}.mjs`), outputText);
  }
  const load = (name: string) => import(pathToFileURL(path.join(folder, `${name}.mjs`)).href);
  const rhythms = await load('rhythmsSchema') as { RhythmsDBSchema: typeof RhythmsDBSchema };
  const response = await load('responseSchema') as { responseSchema: typeof responseSchema };
  RhythmsDBSchemaV350 = rhythms.RhythmsDBSchema;
  readV350 = response.responseSchema(RhythmsDBSchemaV350);
});
after(() => rmSync(folder, { recursive: true, force: true }));

const plain = dbOf(sideOf([rhythmOf('workday', WORKDAY, { temperatureMode: 'smart', smart: { ...DEFAULT_SMART } })], { monday: 'workday' }));
const withUp = structuredClone(plain);
withUp.left.rhythms.workday.smart.offWhenUp = true;

describe('"When I get up" in rhythmsDB.json', () => {
  it('is one optional key on the Smart Schedule settings, in the same file version', () => {
    assert.equal(RhythmsDBSchema.safeParse(withUp).success, true);
    assert.equal(RhythmsUpdateSchema.safeParse({ left: withUp.left }).success, true);
    assert.equal(SmartScheduleSchema.safeParse({ ...DEFAULT_SMART, offWhenUp: 'yes' }).success, false);
    assert.equal(withUp.version, 1);
  });

  it('reads in 3.5.0 as the same rhythm without it, so the side turns off at the set time', () => {
    const parsed = readV350.safeParse(JSON.parse(JSON.stringify(withUp)));
    assert.ok(parsed.success, '3.5.0 would mark the file invalid');
    assert.deepEqual(parsed.data, plain);
    assert.equal(parsed.data.left.rhythms.workday.night.power.off, '07:00');
  });

  it('would be refused by a strict read, which is why the stripped read in 3.5.0 matters', () => {
    assert.equal(RhythmsDBSchemaV350.safeParse(withUp).success, false);
  });

  it('leaves a rhythm without it exactly as 3.5.0 reads it', () => {
    assert.equal(JSON.stringify(RhythmsDBSchema.parse(plain)), JSON.stringify(readV350.parse(plain)));
  });
});

describe('a rhythm with a suggestion added', () => {
  it('reads in 3.5.0 exactly as saved, since adding writes an ordinary rhythm', () => {
    const added = structuredClone(plain);
    added.left.rhythms.workday.night.temperatures['23:45'] = 79;
    added.left.rhythms.workday.night.power.onTemperature = 80;
    added.left.rhythms.workday.smart.baseLevel = -1;
    const parsed = readV350.safeParse(JSON.parse(JSON.stringify(added)));
    assert.ok(parsed.success, '3.5.0 would mark the file invalid');
    assert.deepEqual(parsed.data, added);
    assert.equal(RhythmsDBSchemaV350.safeParse(added).success, true);
  });
});
