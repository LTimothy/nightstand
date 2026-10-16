import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
let finishMigrations;
let checkingMigrations;
mock.module(new URL('./db/services.js', import.meta.url).href, {
    defaultExport: { read: async () => { } },
    namedExports: { updateServices: async () => { } },
});
mock.module(new URL('./db/settings.js', import.meta.url).href, {
    defaultExport: { read: async () => { }, data: { features: {
                firmwareTargetReadout: false, firmwareHealth: false, tapDiagnostics: false, coolingWarning: false,
            } } },
});
mock.module(new URL('./db/unappliedMigrations.js', import.meta.url).href, {
    namedExports: {
        listLocalMigrations: () => ['needed'],
        findUnappliedMigrations: (_local, rows) => rows.length ? [] : ['needed'],
    },
});
mock.module(new URL('./db/prisma.js', import.meta.url).href, {
    namedExports: { prisma: {
            $queryRaw: async (query) => {
                if (query[0].includes('SELECT 1'))
                    return [{ value: 1 }];
                return new Promise(resolve => { finishMigrations = resolve; checkingMigrations?.(); });
            },
            $queryRawUnsafe: async () => [{ quick_check: 'ok' }],
        } },
});
const { default: serverStatus } = await import('./serverStatus.js');
it('publishes database health only after the migration check finishes', async () => {
    serverStatus.status.database = {
        name: 'Database', description: '', status: 'failed', message: 'Missing migration', unappliedMigrations: ['needed'],
    };
    const previous = serverStatus.status.database;
    const checking = new Promise(resolve => { checkingMigrations = resolve; });
    const update = serverStatus.updateDB();
    await checking;
    try {
        assert.equal(serverStatus.status.database, previous);
        assert.deepEqual(serverStatus.status.database.unappliedMigrations, ['needed']);
    }
    finally {
        finishMigrations?.([{}]);
        await update;
    }
    assert.notEqual(serverStatus.status.database, previous);
    assert.equal(serverStatus.status.database.status, 'healthy');
    assert.equal(serverStatus.status.database.unappliedMigrations, undefined);
});
//# sourceMappingURL=serverStatus.test.js.map