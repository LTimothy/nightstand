import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUnappliedMigrations, listLocalMigrations } from './unappliedMigrations.js';

// An update that fails to migrate can leave the server running against a
// database missing tables it needs. Nothing about that is visible until a
// request touches one of them, so the Status page has to be able to say it.

describe('findUnappliedMigrations', () => {
  const done = (name: string) => ({ migration_name: name, finished_at: '2026-09-24T00:00:00Z', rolled_back_at: null });

  it('reports migrations in this tree that the database never applied', () => {
    assert.deepEqual(
      findUnappliedMigrations(['001_init', '002_calibration', '003_payload'], [done('001_init')]),
      ['002_calibration', '003_payload'],
    );
  });

  it('reports nothing when every migration here was applied', () => {
    assert.deepEqual(findUnappliedMigrations(['001_init'], [done('001_init')]), []);
  });

  it('ignores migrations the database has and this tree does not', () => {
    // That is a downgrade: newer tables are harmless to older code, since
    // migrations only ever add.
    assert.deepEqual(findUnappliedMigrations(['001_init'], [done('001_init'), done('002_calibration')]), []);
  });

  it('does not count a migration that started but never finished', () => {
    assert.deepEqual(
      findUnappliedMigrations(['001_init'], [{ migration_name: '001_init', finished_at: null, rolled_back_at: null }]),
      ['001_init'],
    );
  });

  it('does not count a migration that was rolled back', () => {
    assert.deepEqual(
      findUnappliedMigrations(['001_init'], [{ ...done('001_init'), rolled_back_at: '2026-09-24T00:01:00Z' }]),
      ['001_init'],
    );
  });

  it('reads the epoch-millisecond integers SQLite actually stores', () => {
    assert.deepEqual(
      findUnappliedMigrations(['001_init', '002_calibration'], [
        { migration_name: '001_init', finished_at: 1790266485062, rolled_back_at: null },
      ]),
      ['002_calibration'],
    );
  });

  it('counts a migration applied on a later attempt after an earlier one failed', () => {
    assert.deepEqual(
      findUnappliedMigrations(['001_init'], [
        { migration_name: '001_init', finished_at: null, rolled_back_at: null },
        done('001_init'),
      ]),
      [],
    );
  });
});

describe('listLocalMigrations', () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
    for (const name of ['20250217173340_init', '20260803054442_calibration']) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'migration.sql'), '-- sql');
    }
    fs.writeFileSync(path.join(dir, 'migration_lock.toml'), 'provider = "sqlite"');
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists migration folders in order and skips the lock file', () => {
    assert.deepEqual(listLocalMigrations(dir), ['20250217173340_init', '20260803054442_calibration']);
  });

  it('matches the migrations this repo actually ships', () => {
    const shipped = listLocalMigrations(path.resolve(import.meta.dirname, '../../prisma/migrations'));
    assert.ok(shipped.length >= 4, `expected the shipped migrations, got ${shipped.join(', ')}`);
    assert.ok(shipped.every(name => /^\d{14}_\w+$/.test(name)), shipped.join(', '));
  });
});
