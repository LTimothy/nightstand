#!/usr/bin/env python3
"""Consistent SQLite snapshots and conservative failed-migration checks.

Requires Python's standard sqlite3 module. Never falls back to copying a live
main file: committed data can still be in its WAL.
"""
from contextlib import closing
import hashlib
from pathlib import Path
import os
import re
import sqlite3
import sys
import tempfile
import time


def connect(database):
    return sqlite3.connect(Path(database).resolve().as_uri() + '?mode=rw', uri=True, timeout=5)


def checkpoint(database):
    with closing(connect(database)) as source:
        busy, _, _ = source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        if busy:
            raise RuntimeError('Database checkpoint is busy; keep the database and WAL together and retry after stopping writers.')


def backup(database, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.sqlite-backup-', dir=destination.parent)
    os.close(descriptor)
    source = target = None
    try:
        source = connect(database)
        target = sqlite3.connect(temporary)
        deadline = time.monotonic() + 30

        def progress(_status, _remaining, _total):
            if time.monotonic() > deadline:
                raise RuntimeError('Database backup timed out; no snapshot was published.')

        source.backup(target, pages=256, progress=progress, sleep=0.1)
        if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('Database backup failed integrity_check')
        target.close()
        target = None
        with open(temporary, 'rb') as snapshot:
            os.fsync(snapshot.fileno())
        # A hard link publishes the complete file atomically without replacing
        # an existing recovery copy, even if two callers choose the same name.
        os.link(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if target is not None:
            target.close()
        if source is not None:
            source.close()
        os.unlink(temporary)


def statements(sql):
    # Strip comments but preserve quoted values and identifiers. Restrict the
    # accepted grammar below rather than attempting to rewrite arbitrary SQL.
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^\]]*\]|--[^\n]*|/\*[\s\S]*?\*/|[^'\"`\[/-]+|.", sql)
    clean = ''.join(token if not token.startswith(('--', '/*')) else ' ' for token in tokens)
    result, current = [], ''
    for character in clean:
        current += character
        if character == ';' and sqlite3.complete_statement(current):
            result.append(current.strip())
            current = ''
    if current.strip():
        raise ValueError('Every migration statement must end with a semicolon')
    return result


def atomic_additive(sql):
    commands = statements(sql)
    if len(commands) < 3 or not re.fullmatch(r'BEGIN(?:\s+TRANSACTION)?\s*;', commands[0], re.I) or not re.fullmatch(r'COMMIT\s*;', commands[-1], re.I):
        raise ValueError('New migrations must have one BEGIN; ... COMMIT; transaction')
    for command in commands[1:-1]:
        if re.match(r'CREATE\s+TABLE\s+', command, re.I):
            # NOT NULL is safe in a genuinely new table. SQLite itself rejects
            # an existing table name, so CREATE cannot silently rebuild one.
            if re.match(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS|["`\[]?new_)', command, re.I):
                raise ValueError('Table rebuilds and conditional table creation are not allowed')
            continue
        if re.match(r'CREATE\s+INDEX\s+', command, re.I):
            continue
        if re.match(r'ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+ADD\s+(?:COLUMN\s+)?', command, re.I):
            keywords = re.sub(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^\]]*\]", '?', command)
            if re.search(r'\bNOT\s+NULL\b', keywords, re.I):
                if not re.search(r'\bDEFAULT\b', keywords, re.I) or re.search(r'\bDEFAULT\s*\(*\s*NULL\b', keywords, re.I):
                    raise ValueError('Required columns on existing tables need a non-null DEFAULT')
            if re.search(r'\b(?:UNIQUE|PRIMARY|REFERENCES|CHECK)\b', command, re.I):
                raise ValueError('New constraints on existing tables need compatibility review')
            continue
        if re.fullmatch(r'DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?\w+_idx"?\s*;', command, re.I):
            # A non-unique index only: older code reads the same rows through the unique one.
            continue
        raise ValueError('Only new tables, non-unique indexes, and additive columns are allowed')


def recoverable_migrations(database, directory):
    with closing(connect(database)) as source:
        rows = source.execute('SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL').fetchall()
    if not rows:
        raise ValueError('No failed migrations found')
    names = []
    for name, checksum in rows:
        if not re.fullmatch(r'\d{14}_\w+', name):
            raise ValueError('Invalid failed migration name')
        content = (Path(directory) / name / 'migration.sql').read_bytes()
        if hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError(f'{name}: migration checksum differs; manual recovery required')
        atomic_additive(content.decode())
        names.append(name)
    # Validate the whole set before allowing the caller to resolve any rows.
    return sorted(set(names))


def main():
    operation, *arguments = sys.argv[1:]
    if operation == 'backup' and len(arguments) == 2:
        backup(*arguments)
    elif operation == 'checkpoint' and len(arguments) == 1:
        checkpoint(*arguments)
    elif operation == 'recoverable-migrations' and len(arguments) == 2:
        print('\n'.join(recoverable_migrations(*arguments)))
    else:
        raise ValueError('Usage: sqlite-safety.py backup DB DEST | checkpoint DB | recoverable-migrations DB MIGRATIONS_DIR')


if __name__ == '__main__':
    try:
        main()
    except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
        print(f'Database safety check failed: {error}', file=sys.stderr)
        sys.exit(1)
