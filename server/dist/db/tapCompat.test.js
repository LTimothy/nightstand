import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import _ from 'lodash';
import ts from 'typescript';
import { SettingsSchema } from './settingsSchema.js';
import { responseSchema } from './responseSchema.js';
// The 3.6.1 settings schema and time zones, kept verbatim as text and transpiled here, so they never build into dist.
// Its schedulesSchema is the same file as 3.5.0's.
const FIXTURES = new URL('../../../fixtures/compat/', import.meta.url);
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-v361-settings-'));
let SettingsSchemaV361;
before(async () => {
    const zod = import.meta.resolve('zod');
    for (const [name, release] of [['settingsSchema', 'v3.6.1'], ['timeZones', 'v3.6.1'], ['schedulesSchema', 'v3.5.0']]) {
        const source = readFileSync(new URL(`${release}/${name}.ts.txt`, FIXTURES), 'utf8')
            .replaceAll("from 'zod'", `from '${zod}'`)
            .replaceAll(/from '\.\/(\w+)\.js'/g, "from './$1.mjs'");
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        });
        writeFileSync(path.join(folder, `${name}.mjs`), outputText);
    }
    ({ SettingsSchema: SettingsSchemaV361 } = await import(pathToFileURL(path.join(folder, 'settingsSchema.mjs')).href));
});
after(() => rmSync(folder, { recursive: true, force: true }));
const SET = { type: 'set_temperature', temperatureF: 76 };
const side = () => ({
    name: 'Alex', awayMode: false, alarmsEnabled: true,
    scheduleOverrides: {
        temperatureSchedules: { disabled: false, expiresAt: '' },
        alarm: { disabled: false, timeOverride: '', expiresAt: '' },
        pause: { active: false, expiresAt: '' },
    },
    oneOffAlarm: { enabled: false, fireAt: '', vibrationIntensity: 100, vibrationPattern: 'rise', duration: 30 },
    taps: {
        doubleTap: { type: 'temperature', change: 'decrement', amount: 2 },
        tripleTap: { type: 'temperature', change: 'increment', amount: 2 },
        quadTap: SET,
    },
    buttons: { invertButtons: false, stepF: 1, favoriteTemperatureF: 80 },
});
describe('a tap that sets a temperature', () => {
    it('is a valid side setting in this release', () => {
        assert.equal(SettingsSchema.shape.left.safeParse(side()).success, true);
    });
    it('is a type 3.6.1 does not know', () => {
        assert.equal(SettingsSchemaV361.shape.left.shape.taps.shape.quadTap.safeParse(SET).success, false);
    });
    it('reads in the 3.6.1 app as a side without taps, with the rest of the side intact', () => {
        // What 3.6.1's app/src/api/responseValidation.ts does with taps: soft(taps.optional(), undefined).
        const left = SettingsSchemaV361.shape.left;
        const sideV361 = responseSchema(left).extend({
            taps: responseSchema(left.shape.taps.optional()).catch(undefined),
        });
        const parsed = sideV361.safeParse(side());
        assert.ok(parsed.success, '3.6.1 would refuse the whole settings read');
        assert.equal(parsed.data.taps, undefined);
        assert.equal(parsed.data.name, 'Alex');
    });
    it('stays stored through a 3.6.1 save of another setting', () => {
        const stored = { left: side() };
        const update = SettingsSchemaV361.deepPartial().safeParse({ left: { name: 'Sam' } });
        assert.ok(update.success);
        _.merge(stored, update.data);
        assert.deepEqual(stored.left.taps.quadTap, SET);
    });
    it('is refused by 3.6.1 when a client sends it, so nothing half-valid is stored', () => {
        assert.equal(SettingsSchemaV361.deepPartial().safeParse({ left: { taps: { quadTap: SET } } }).success, false);
    });
});
//# sourceMappingURL=tapCompat.test.js.map