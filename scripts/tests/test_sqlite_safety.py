"""Real SQLite regressions; all databases live in temporary directories."""
import hashlib
import importlib.util
import json
import re
import signal
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/sqlite-safety.py'

def dropped_index_problems(migrations):
    """Dropped *_idx indexes must duplicate a unique index created earlier."""
    plain, unique, problems = {}, set(), []
    cols = lambda text: tuple(re.findall(r'"([^"]+)"', text))
    for sql_file in sorted(Path(migrations).glob('*/migration.sql')):
        for stmt in sql_file.read_text().split(';'):
            m = re.search(r'CREATE\s+(UNIQUE\s+)?INDEX\s+"(\w+)"\s+ON\s+"(\w+)"\s*\(([^)]*)\)', stmt, re.I)
            if m:
                key = (m[3], cols(m[4]))
                if m[1]:
                    unique.add(key)
                else:
                    plain[m[2]] = key
            d = re.search(r'DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"(\w+)"', stmt, re.I)
            if d and d[1].endswith('_idx') and plain.get(d[1]) not in unique:
                problems.append(f'{sql_file.parent.name}: {d[1]} does not duplicate a unique index')
    return problems


class DatabaseSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.database = self.folder / 'live.db'
        self.conn = sqlite3.connect(self.database, isolation_level=None)
        self.addCleanup(self.conn.close)
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.conn.execute('PRAGMA wal_autocheckpoint=0')
        self.conn.execute('CREATE TABLE records (value TEXT)')
        self.conn.execute("INSERT INTO records VALUES ('old')")
        self.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.conn.executemany('INSERT INTO records VALUES (?)', [('recent',)] * 200)

    def run_helper(self, *args):
        return subprocess.run([sys.executable, str(HELPER), *map(str, args)], capture_output=True, text=True)

    def test_backup_keeps_wal_rows(self):
        copied = self.folder / 'plain-copy.db'
        shutil.copyfile(self.database, copied)
        with sqlite3.connect(copied) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM records').fetchone()[0], 1)
        backup = self.folder / 'safe.db'
        result = self.run_helper('backup', self.database, backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        with sqlite3.connect(backup) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM records').fetchone()[0], 201)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertNotEqual(self.run_helper('backup', self.database, backup).returncode, 0)

    def test_checkpoint_preserves_all_rows_in_main_file(self):
        result = self.run_helper('checkpoint', self.database)
        self.assertEqual(result.returncode, 0, result.stderr)
        copied = self.folder / 'checkpointed.db'
        shutil.copyfile(self.database, copied)
        with sqlite3.connect(copied) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM records').fetchone()[0], 201)

    def test_checkpoint_busy_fails_closed(self):
        reader = sqlite3.connect(self.database)
        try:
            reader.execute('BEGIN')
            reader.execute('SELECT * FROM records').fetchall()
            self.conn.execute("INSERT INTO records VALUES ('blocked')")
            self.assertNotEqual(self.run_helper('checkpoint', self.database).returncode, 0)
        finally:
            reader.close()

    def test_missing_database_is_not_created(self):
        missing = self.folder / 'missing.db'
        self.assertNotEqual(self.run_helper('backup', missing, self.folder / 'out.db').returncode, 0)
        self.assertFalse(missing.exists())

    def test_failed_migration_requires_matching_atomic_sql(self):
        migrations = self.folder / 'migrations'
        migration = migrations / '20990101000000_new'
        migration.mkdir(parents=True)
        sql = b'BEGIN;\nCREATE TABLE extra (value TEXT);\nCOMMIT;\n'
        (migration / 'migration.sql').write_bytes(sql)
        self.conn.execute('CREATE TABLE _prisma_migrations (migration_name TEXT, checksum TEXT, finished_at TEXT, rolled_back_at TEXT)')
        self.conn.execute('INSERT INTO _prisma_migrations VALUES (?, ?, NULL, NULL)', (migration.name, hashlib.sha256(sql).hexdigest()))
        result = self.run_helper('recoverable-migrations', self.database, migrations)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), migration.name)
        (migration / 'migration.sql').write_bytes(sql + b'-- changed')
        self.assertNotEqual(self.run_helper('recoverable-migrations', self.database, migrations).returncode, 0)
        unsafe = b'CREATE TABLE partial (value TEXT);'
        (migration / 'migration.sql').write_bytes(unsafe)
        self.conn.execute('UPDATE _prisma_migrations SET checksum=?', (hashlib.sha256(unsafe).hexdigest(),))
        result = self.run_helper('recoverable-migrations', self.database, migrations)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_sigterm_runs_database_cleanup(self):
        stream = (ROOT / 'biometrics/stream/stream.py').read_text()
        self.assertIn('    install_shutdown_handlers()', stream)
        # Import the actual DB module with only its scientific/logger imports
        # stubbed. The connection, checkpoint and atexit hook are real.
        program = r"""
import sys, types, pathlib, time
sys.path.insert(0, sys.argv[1] + '/biometrics')
for name in ['numpy', 'pandas', 'data_types']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['data_types'].SleepRecord = dict
sys.modules['pandas'].DataFrame = object
logger = types.ModuleType('get_logger')
logger.get_logger = lambda: types.SimpleNamespace(folder_path=sys.argv[2] + '/')
sys.modules['get_logger'] = logger
import db
from shutdown import install_shutdown_handlers
install_shutdown_handlers()
db.conn.execute('CREATE TABLE signal_rows (value TEXT)')
db.conn.execute('INSERT INTO signal_rows VALUES ("kept")')
print('ready', flush=True)
while True:
    time.sleep(1)
"""
        child = subprocess.Popen([sys.executable, '-c', program, str(ROOT), str(self.folder)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            ready = child.stdout.readline().strip()
            if ready != 'ready':
                self.fail(child.communicate(timeout=10)[1])
            child.send_signal(signal.SIGTERM)
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr)
            database = self.folder / 'free-sleep.db'
            wal = Path(str(database) + '-wal')
            self.assertTrue(not wal.exists() or wal.stat().st_size == 0)
            with sqlite3.connect(database) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM signal_rows').fetchone()[0], 1)
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate()

    def test_migration_history_and_new_sql_policy(self):
        spec = importlib.util.spec_from_file_location('sqlite_safety', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        migrations = ROOT / 'server/prisma/migrations'
        pinned = json.loads((ROOT / 'server/prisma/shipped-migrations.json').read_text())
        for name, checksum in pinned.items():
            self.assertEqual(hashlib.sha256((migrations / name / 'migration.sql').read_bytes()).hexdigest(), checksum, name)
        for migration in migrations.glob('*/migration.sql'):
            if migration.parent.name not in pinned:
                module.atomic_additive(migration.read_text())
        for unsafe in [
            'DROP TABLE vitals;',
            'ALTER TABLE vitals RENAME TO other;',
            'ALTER TABLE vitals ADD COLUMN required TEXT NOT NULL;',
            'ALTER TABLE vitals ADD COLUMN required TEXT NOT NULL DEFAULT NULL;',
            'ALTER TABLE vitals ADD COLUMN "DEFAULT" TEXT NOT NULL;',
            'CREATE TABLE new_vitals (value TEXT);',
            'INSERT INTO vitals SELECT * FROM other;',
            'COMMIT; BEGIN;',
            'DROP INDEX "vitals_side_timestamp_key";',
        ]:
            with self.assertRaises(ValueError, msg=unsafe):
                module.atomic_additive('BEGIN; ' + unsafe + ' COMMIT;')
        module.atomic_additive('BEGIN; ALTER TABLE vitals ADD COLUMN source TEXT NOT NULL DEFAULT "pod"; COMMIT;')
        module.atomic_additive('BEGIN; CREATE TABLE future (value TEXT NOT NULL); COMMIT;')
        module.atomic_additive('BEGIN; DROP INDEX IF EXISTS "vitals_side_timestamp_idx"; COMMIT;')

    def test_dropped_indexes_duplicate_a_unique_one(self):
        migrations = ROOT / 'server/prisma/migrations'
        self.assertEqual(dropped_index_problems(migrations), [])
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch) / 'migrations'
            shutil.copytree(migrations, copy)
            (copy / '20990101000000_bad').mkdir()
            (copy / '20990101000000_bad/migration.sql').write_text(
                'BEGIN;\nDROP INDEX IF EXISTS "calibration_runs_side_started_at_idx";\nCOMMIT;\n')
            self.assertEqual(len(dropped_index_problems(copy)), 1)

    def test_no_gate_compares_the_prisma_schema_with_migrations(self):
        # movement.total_movement is Float in schema.prisma over the INTEGER
        # column its migration created. A gate that diffs the two would ask
        # for a table rebuild, which the policy above rejects.
        checked = [*ROOT.glob('.github/workflows/*.y*ml'), *ROOT.glob('scripts/**/*.sh'), *ROOT.glob('ops/**/*.sh')]
        self.assertTrue(checked)
        for path in checked:
            text = path.read_text()
            for command in ('migrate diff', 'migrate dev', 'db push'):
                self.assertNotIn(command, text, f'{path.relative_to(ROOT)} runs prisma {command}')
        scripts = json.loads((ROOT / 'server/package.json').read_text())['scripts']
        for name, command in scripts.items():
            if name != 'migrate:local':
                self.assertNotRegex(command, r'migrate (diff|dev)|db push', name)

    def test_install_and_reset_use_consistent_backups(self):
        install = (ROOT / 'scripts/install.sh').read_text()
        self.assertNotIn('rm -f /persistent/free-sleep-data/free-sleep.db-shm', install)
        self.assertIn('sqlite-safety.py', install)
        self.assertLess(install.index('systemctl stop "$service"'), install.index('move_tree "$REPO_DIR" "$PREV_DIR"'))
        reset = (ROOT / 'scripts/reset_db.sh').read_text()
        self.assertIn('set -euo pipefail', reset)
        self.assertLess(reset.index('sqlite-safety.py'), reset.index('rm -f'))

if __name__ == '__main__':
    unittest.main()
