import fs from 'node:fs';
const isSet = (value) => value !== null && value !== undefined;
// Migrations shipped in this tree that the database has not applied. A
// migration the database has and this tree lacks is a downgrade, and is left
// alone: migrations only ever add, so older code runs fine on a newer schema.
export function findUnappliedMigrations(local, rows) {
    const applied = new Set(rows.filter(row => isSet(row.finished_at) && !isSet(row.rolled_back_at)).map(row => row.migration_name));
    return local.filter(name => !applied.has(name));
}
export function listLocalMigrations(dir) {
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
}
//# sourceMappingURL=unappliedMigrations.js.map