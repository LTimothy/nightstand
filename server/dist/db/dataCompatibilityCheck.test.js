import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
it('reports preserved unknown keys and checks incompatible services without writing', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'compat-check-'));
    try {
        const source = readFileSync(new URL('../../../scripts/migrate/data-compat-check.mjs', import.meta.url), 'utf8');
        const script = source.replaceAll('../../server/dist/db/', new URL('./', import.meta.url).href).replaceAll('Schema.js', 'Schema.ts');
        const checker = path.join(folder, 'check.mjs');
        writeFileSync(checker, script);
        const files = ['settingsDB', 'schedulesDB', 'servicesDB'];
        for (const name of files) {
            const fixture = new URL(`../../../fixtures/compat/future/${name}.json`, import.meta.url);
            writeFileSync(path.join(folder, `${name}.json`), readFileSync(fixture));
        }
        const run = () => spawnSync(process.execPath, ['--no-warnings', '--loader', 'ts-node/esm', checker], {
            encoding: 'utf8', env: { ...process.env, FS_MIGRATE_LOWDB_DIR: folder },
        });
        const before = files.map(name => readFileSync(path.join(folder, `${name}.json`), 'utf8'));
        const result = run();
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /kept/);
        assert.match(result.stdout, /services/);
        assert.doesNotMatch(result.stdout, /will be dropped|dropped silently/);
        assert.deepEqual(files.map(name => readFileSync(path.join(folder, `${name}.json`), 'utf8')), before);
        const alarms = Array.from({ length: 11 }, () => ({
            time: '07:00', enabled: true, duration: 30, vibrationIntensity: 100, vibrationPattern: 'rise', alarmTemperature: 82,
        }));
        writeFileSync(path.join(folder, 'schedulesDB.json'), JSON.stringify({ left: { monday: { alarms } } }));
        const grandfathered = run();
        assert.equal(grandfathered.status, 0, grandfathered.stderr + grandfathered.stdout);
        writeFileSync(path.join(folder, 'servicesDB.json'), '{"biometrics":{"enabled":"yes"}}');
        const invalid = run();
        assert.equal(invalid.status, 1, invalid.stderr + invalid.stdout);
        assert.match(invalid.stdout, /biometrics.enabled/);
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
it('refuses single schedules before they can become disabled weekly defaults', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'compat-single-'));
    try {
        const source = readFileSync(new URL('../../../scripts/migrate/data-compat-check.mjs', import.meta.url), 'utf8');
        const script = source.replaceAll('../../server/dist/db/', new URL('./', import.meta.url).href).replaceAll('Schema.js', 'Schema.ts');
        const checker = path.join(folder, 'check.mjs');
        writeFileSync(checker, script);
        const fixture = readFileSync(new URL('../../../fixtures/compat/single-schedule/schedulesDB.json', import.meta.url), 'utf8');
        const schedules = path.join(folder, 'schedulesDB.json');
        for (const data of [fixture, JSON.stringify({ left: JSON.parse(fixture).left, right: { monday: {} } })]) {
            writeFileSync(schedules, data);
            const result = spawnSync(process.execPath, ['--no-warnings', '--loader', 'ts-node/esm', checker], {
                encoding: 'utf8', env: { ...process.env, FS_MIGRATE_LOWDB_DIR: folder },
            });
            assert.equal(result.status, 1, result.stderr + result.stdout);
            assert.match(result.stdout, /left.*single schedule/i);
            assert.match(result.stdout, /alarms and power schedules would be disabled/i);
            assert.match(result.stdout, /Aborting before touching your data/);
            assert.equal(readFileSync(schedules, 'utf8'), data);
        }
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
it('refuses dated away settings without changing active or scheduled away data', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'compat-away-'));
    try {
        const source = readFileSync(new URL('../../../scripts/migrate/data-compat-check.mjs', import.meta.url), 'utf8');
        const script = source.replaceAll('../../server/dist/db/', new URL('./', import.meta.url).href).replaceAll('Schema.js', 'Schema.ts');
        const checker = path.join(folder, 'check.mjs');
        writeFileSync(checker, script);
        const settings = path.join(folder, 'settingsDB.json');
        const fixture = readFileSync(new URL('../../../fixtures/compat/dated-away/settingsDB.json', import.meta.url), 'utf8');
        const run = () => spawnSync(process.execPath, ['--no-warnings', '--loader', 'ts-node/esm', checker], {
            encoding: 'utf8', env: { ...process.env, FS_MIGRATE_LOWDB_DIR: folder },
        });
        for (const data of [fixture, '{"left":{"awayMode":true,"awayReturn":"2020-01-01T00:00:00Z"}}',
            '{"right":{"awayMode":false,"awayStart":"2030-01-01T00:00:00Z"}}']) {
            writeFileSync(settings, data);
            const result = run();
            assert.equal(result.status, 1, result.stderr + result.stdout);
            assert.match(result.stdout, /dated away|away dates/i);
            assert.match(result.stdout, /alarms/i);
            assert.match(result.stdout, /before switching/i);
            assert.equal(readFileSync(settings, 'utf8'), data);
        }
        writeFileSync(settings, '{"left":{"awayMode":true,"awayStart":null,"awayReturn":""}}');
        const emptyDates = run();
        assert.equal(emptyDates.status, 0, emptyDates.stderr + emptyDates.stdout);
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
//# sourceMappingURL=dataCompatibilityCheck.test.js.map