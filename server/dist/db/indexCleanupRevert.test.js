import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { findUnappliedMigrations, listLocalMigrations } from './unappliedMigrations.js';
// Dropping an index is the one schema change that is not purely additive,
// so a release from before it must still migrate and read the cleaned database.
const server = path.resolve(import.meta.dirname, '../..');
const prismaCli = path.join(server, 'node_modules/prisma/build/index.js');
const CLEANUP = '20261015120000_drop_duplicate_indexes';
// The older tree reuses the current schema.prisma and client: Prisma Client carries no index
// metadata, and migrate status/deploy read only the migrations folder and the datasource.
function tree(folder, names) {
    fs.mkdirSync(path.join(folder, 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(server, 'prisma/schema.prisma'), path.join(folder, 'schema.prisma'));
    fs.copyFileSync(path.join(server, 'prisma/migrations/migration_lock.toml'), path.join(folder, 'migrations/migration_lock.toml'));
    for (const name of names)
        fs.cpSync(path.join(server, 'prisma/migrations', name), path.join(folder, 'migrations', name), { recursive: true });
}
const SQL_SCRIPT = 'import sqlite3, sys\nfor row in sqlite3.connect(sys.argv[1], isolation_level=None).execute(sys.argv[2]): print(*row)';
const sql = (database, query) => execFileSync('python3', ['-c', SQL_SCRIPT, database, query], { encoding: 'utf8' });
const migrate = (folder, database, command) => execFileSync(process.execPath, [prismaCli, 'migrate', command, '--schema', path.join(folder, 'schema.prisma')], { env: { ...process.env, DATABASE_URL: `file:${database}` }, stdio: 'pipe', timeout: 60_000, encoding: 'utf8' });
it('drops only the duplicate indexes, and an older tree still migrates the cleaned database', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-cleanup-'));
    const database = path.join(root, 'pod.db');
    const client = new PrismaClient({ datasourceUrl: `file:${database}` });
    try {
        const all = fs.readdirSync(path.join(server, 'prisma/migrations')).filter(name => /^\d/.test(name)).sort();
        assert.ok(all.includes(CLEANUP), 'the cleanup migration is missing');
        const older = path.join(root, 'older');
        tree(older, all.filter(name => name !== CLEANUP));
        migrate(older, database, 'deploy');
        sql(database, "INSERT INTO vitals (side, timestamp, heart_rate) VALUES ('left', 1700000000, 60)");
        tree(path.join(root, 'current'), all);
        migrate(path.join(root, 'current'), database, 'deploy');
        const indexes = sql(database, "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name");
        for (const gone of ['vitals_side_timestamp_idx', 'movement_side_timestamp_idx', 'sleep_records_side_entered_bed_at_idx']) {
            assert.doesNotMatch(indexes, new RegExp(`^${gone}$`, 'm'));
        }
        for (const kept of ['vitals_side_timestamp_key', 'movement_side_timestamp_key', 'sleep_records_side_entered_bed_at_key']) {
            assert.match(indexes, new RegExp(`^${kept}$`, 'm'));
        }
        // What an older release does after a downgrade: the updater runs migrate
        // deploy only when migrate status fails, then the server's startup check
        // looks for migrations the database has not applied.
        assert.match(migrate(older, database, 'status'), /Database schema is up to date/);
        migrate(older, database, 'deploy');
        const rows = await client.$queryRaw `
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
        assert.deepEqual(findUnappliedMigrations(listLocalMigrations(path.join(older, 'migrations')), rows), []);
        const read = await client.vitals.findMany({ where: { side: 'left', timestamp: { gte: 1700000000, lte: 1700086400 } } });
        assert.equal(read.length, 1);
        assert.match(sql(database, "EXPLAIN QUERY PLAN SELECT * FROM vitals WHERE side = 'left' AND timestamp BETWEEN 1 AND 2"), /USING INDEX vitals_side_timestamp_key/);
    }
    finally {
        await client.$disconnect();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
//# sourceMappingURL=indexCleanupRevert.test.js.map