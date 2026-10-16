import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { it } from 'node:test';
import { migrationStatements } from './migrations.js';
it('drops a migration file\'s own BEGIN and COMMIT', () => {
    for (const name of readdirSync('prisma/migrations').filter(entry => /^\d/.test(entry))) {
        for (const statement of migrationStatements('prisma/migrations', name)) {
            assert.doesNotMatch(statement, /^(BEGIN|COMMIT)$/i, name);
        }
    }
    assert.ok(migrationStatements('prisma/migrations', '20261007120000_vitals_summaries')
        .some(statement => statement.startsWith('CREATE TABLE "vitals_summaries"')));
});
//# sourceMappingURL=migrations.test.js.map