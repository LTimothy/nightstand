import { readFileSync } from 'node:fs';
import path from 'node:path';
// A migration file's own BEGIN and COMMIT are dropped: a pooled client can run
// them on different connections, leaving one holding an open transaction.
export function migrationStatements(directory, name) {
    return readFileSync(path.join(directory, name, 'migration.sql'), 'utf8')
        .split(';')
        .map(part => part.trim())
        .filter(part => part && !/^(BEGIN|COMMIT)$/i.test(part));
}
export async function applyMigration(client, directory, name) {
    for (const statement of migrationStatements(directory, name))
        await client.$executeRawUnsafe(statement);
}
//# sourceMappingURL=migrations.js.map