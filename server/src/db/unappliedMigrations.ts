import fs from 'node:fs';

// SQLite stores the timestamps as epoch-millisecond integers, and only whether
// they are set matters here.
export type MigrationRow = {
  migration_name: string;
  finished_at: unknown;
  rolled_back_at: unknown;
};

const isSet = (value: unknown) => value !== null && value !== undefined;

// Migrations shipped in this tree that the database has not applied. A
// migration the database has and this tree lacks is a downgrade, and is left
// alone: migrations only ever add, so older code runs fine on a newer schema.
export function findUnappliedMigrations(local: string[], rows: MigrationRow[]): string[] {
  const applied = new Set(
    rows.filter(row => isSet(row.finished_at) && !isSet(row.rolled_back_at)).map(row => row.migration_name),
  );
  return local.filter(name => !applied.has(name));
}

export function listLocalMigrations(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}
