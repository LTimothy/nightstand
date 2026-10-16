import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
it('offers Reinstall for a real v3.0.0 database with only the original migrations', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'database-readiness-'));
    const server = path.resolve(import.meta.dirname, '../..');
    const migrationNames = ['20250217173340_init', '20250523222022_movement'];
    process.env.DATA_FOLDER = `${folder}/`;
    process.env.ENV = 'local';
    process.env.DATABASE_URL = `file:${folder}/old.db`;
    fs.mkdirSync(path.join(folder, 'lowdb'));
    fs.copyFileSync(path.join(server, 'prisma/schema.prisma'), path.join(folder, 'schema.prisma'));
    fs.mkdirSync(path.join(folder, 'migrations'));
    fs.copyFileSync(path.join(server, 'prisma/migrations/migration_lock.toml'), path.join(folder, 'migrations/migration_lock.toml'));
    for (const name of migrationNames) {
        fs.cpSync(path.join(server, 'prisma/migrations', name), path.join(folder, 'migrations', name), { recursive: true });
    }
    let disconnect;
    try {
        const command = [path.join(server, 'node_modules/prisma/build/index.js'),
            'migrate', 'deploy', '--schema', path.join(folder, 'schema.prisma')];
        execFileSync(process.execPath, command, {
            env: { ...process.env, RUST_BACKTRACE: '1', RUST_LOG: 'info' }, stdio: 'pipe', timeout: 60_000,
        });
        const { prisma } = await import('./prisma.js');
        disconnect = () => prisma.$disconnect();
        const { default: serverStatus } = await import('../serverStatus.js');
        await serverStatus.updateDB();
        assert.equal(serverStatus.status.database.status, 'failed');
        assert.deepEqual(serverStatus.status.database.unappliedMigrations, [
            '20260803054442_calibration',
            '20260825052500_calibration_run_payload',
            '20260926170000_water_level_events',
            '20260930000000_analysis_runs',
            '20261002014753_vitals_v2',
            '20261007120000_vitals_summaries',
            '20261015120000_drop_duplicate_indexes',
        ]);
        assert.match(serverStatus.status.database.message ?? '', /Reinstall/);
        // The health check reports only. It must not migrate a live database.
        const rows = await prisma.$queryRawUnsafe('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name');
        assert.deepEqual(rows.map(row => row.migration_name), migrationNames);
    }
    finally {
        await disconnect?.();
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
//# sourceMappingURL=databaseReadiness.test.js.map