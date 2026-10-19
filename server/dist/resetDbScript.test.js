import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Runs scripts/reset_db.sh (fs-reset-db) against a throwaway data folder and
// a real SQLite file, with systemctl and su replaced by stubs that record
// their arguments.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function makeDatabase(file) {
    execFileSync('python3', ['-c', `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE vitals (id INTEGER PRIMARY KEY, value TEXT)')
db.executemany('INSERT INTO vitals (value) VALUES (?)', [('x' * 200,)] * 2000)
db.commit()
db.close()
`, file]);
}
// Damages a table page but keeps the header, so SQLite opens the file and the
// copy fails its integrity_check.
function damage(file) {
    const bytes = readFileSync(file);
    bytes.fill(0xff, 4096 * 3, 4096 * 3 + 2048);
    writeFileSync(file, bytes);
}
function run(answer, { database = 'good', services = '{"biometrics":{"enabled":false}}', migrateFails = false, wal = false, backupsBlocked = false, safetyFails = false, walLink = false, walRace = false, } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-reset-db-'));
    const persistent = path.join(dir, 'persistent');
    const data = path.join(persistent, 'free-sleep-data');
    const backups = path.join(persistent, 'free-sleep-database-backups');
    const scripts = path.join(dir, 'scripts');
    const bin = path.join(dir, 'bin');
    mkdirSync(path.join(data, 'lowdb'), { recursive: true });
    mkdirSync(scripts);
    mkdirSync(bin);
    writeFileSync(path.join(data, 'lowdb', 'servicesDB.json'), services);
    const db = path.join(data, 'free-sleep.db');
    if (database !== 'none') {
        if (database === 'garbage')
            writeFileSync(db, 'this is not a database'.repeat(400));
        else
            makeDatabase(db);
        if (database === 'damaged')
            damage(db);
    }
    if (wal)
        writeFileSync(`${db}-wal`, 'wal bytes');
    if (walLink) {
        writeFileSync(path.join(dir, 'secret'), 'root only');
        symlinkSync(path.join(dir, 'secret'), `${db}-wal`);
    }
    if (backupsBlocked)
        writeFileSync(backups, 'a file where the folder goes');
    const original = existsSync(db) ? readFileSync(db) : null;
    const calls = path.join(dir, 'calls');
    const stub = (name, body) => {
        writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
    };
    stub('systemctl', 'exit 0');
    stub('su', `exit ${migrateFails ? 1 : 0}`);
    for (const helper of ['sqlite-safety.py', 'prune_db_snapshots.sh']) {
        copyFileSync(path.join(repoRoot, 'scripts', helper), path.join(scripts, helper));
    }
    if (walRace) {
        // The WAL appears as a plain file, passes the check, then becomes a link.
        writeFileSync(path.join(dir, 'secret'), 'root only');
        stub('cp', `for a in "$@"; do
  [ "$a" != '${db}' ] || echo 'wal bytes' > '${db}-wal'
  [ "$a" != '${db}-wal' ] || { /bin/rm -f "$a"; /bin/ln -s '${path.join(dir, 'secret')}' "$a"; }
done
exec /bin/cp "$@"`);
    }
    if (safetyFails)
        writeFileSync(path.join(scripts, 'sqlite-safety.py'), 'raise SystemExit(1)\n');
    const script = path.join(scripts, 'reset_db.sh');
    writeFileSync(script, readFileSync(path.join(repoRoot, 'scripts/reset_db.sh'), 'utf8').replaceAll('/persistent', persistent));
    const result = spawnSync('bash', [script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, input: `${answer}\n`, encoding: 'utf8', timeout: 60_000,
    });
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    const saved = existsSync(backups) && !backupsBlocked ? readdirSync(backups) : [];
    const read = (name) => {
        const file = path.join(backups, name);
        return lstatSync(file).isSymbolicLink() ? Buffer.from('') : readFileSync(file);
    };
    const out = { ...result, log, saved, read, original, dbLeft: existsSync(db), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    return out;
}
const integrity = (bytes) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-check-'));
    const file = path.join(dir, 'copy.db');
    writeFileSync(file, bytes);
    const check = 'import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute("PRAGMA integrity_check").fetchone()[0])';
    const answer = execFileSync('python3', ['-c', check, file], { encoding: 'utf8' }).trim();
    rmSync(dir, { recursive: true, force: true });
    return answer;
};
describe('reset_db.sh', () => {
    it('copies nothing through a link swapped in after its check', () => {
        const result = run('y', { walRace: true, database: 'garbage' });
        try {
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(result.saved.some(name => name.endsWith('-reset-raw.db-wal')), `${result.saved.join(' ')} ${result.log.join(' ')}`);
            for (const name of result.saved)
                assert.doesNotMatch(result.read(name).toString(), /root only/, name);
        }
        finally {
            result.cleanup();
        }
    });
    it('copies nothing through a link at the database files', () => {
        const result = run('y', { walLink: true });
        try {
            assert.equal(result.status, 0, result.stdout + result.stderr);
            for (const name of result.saved)
                assert.doesNotMatch(result.read(name).toString(), /root only/, name);
        }
        finally {
            result.cleanup();
        }
    });
    it('parses', () => {
        assert.equal(spawnSync('bash', ['-n', path.join(repoRoot, 'scripts/reset_db.sh')]).status, 0);
    });
    it('does nothing without a yes', () => {
        const result = run('n');
        assert.equal(result.status, 0);
        assert.deepEqual(result.log, []);
        assert.equal(result.dbLeft, true);
        result.cleanup();
    });
    it('saves a checked copy, recreates the database and starts the server', () => {
        const result = run('y');
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const copy = result.saved.find((name) => /^\d{8}T\d{6}Z-\d+-reset\.db$/.test(name));
        assert.ok(copy, result.saved.join(', '));
        assert.equal(integrity(result.read(copy)), 'ok');
        assert.match(result.stdout, /Database backup saved to/);
        assert.equal(result.dbLeft, false);
        assert.ok(result.log.some((line) => line.startsWith('su ') && line.includes('prisma migrate deploy')));
        assert.ok(result.log.includes('systemctl start free-sleep'), result.log.join('\n'));
        result.cleanup();
    });
    for (const database of ['damaged', 'garbage']) {
        it(`still resets a ${database} database, keeping the file as it was`, () => {
            const result = run('y', { database });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const raw = result.saved.find((name) => /^\d{8}T\d{6}Z-\d+-reset-raw\.db$/.test(name));
            assert.ok(raw, result.saved.join(', '));
            assert.ok(result.original && result.read(raw).equals(result.original), 'the copy is the file byte for byte');
            assert.ok(!result.saved.some((name) => /-reset\.db$/.test(name)), 'no checked copy is claimed');
            assert.match(result.stdout, /could not be copied cleanly/);
            assert.match(result.stdout, /copied as it was to \S+-reset-raw\.db/);
            assert.equal(result.dbLeft, false);
            assert.ok(result.log.some((line) => line.startsWith('su ') && line.includes('prisma migrate deploy')));
            assert.ok(result.log.includes('systemctl start free-sleep'));
            result.cleanup();
        });
    }
    it('keeps the WAL with the copy, since committed rows can still be in it', () => {
        const result = run('y', { wal: true, safetyFails: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const raw = result.saved.find((name) => name.endsWith('-reset-raw.db-wal'));
        assert.ok(raw, result.saved.join(', '));
        assert.equal(result.read(raw).toString(), 'wal bytes');
        assert.ok(result.original && result.read(raw.replace(/-wal$/, '')).equals(result.original));
        result.cleanup();
    });
    it('deletes nothing when the file cannot be copied aside', () => {
        const result = run('y', { database: 'garbage', backupsBlocked: true });
        assert.notEqual(result.status, 0);
        assert.equal(result.dbLeft, true);
        assert.ok(!result.log.some((line) => line.startsWith('su ')), 'no new database');
        assert.ok(result.log.includes('systemctl start free-sleep'), result.log.join('\n'));
        result.cleanup();
    });
    it('starts the stream again only while Biometrics is on in the app', () => {
        const on = run('y', { services: '{"biometrics":{"enabled":true}}' });
        assert.equal(on.status, 0, on.stdout + on.stderr);
        assert.ok(on.log.includes('systemctl start free-sleep-stream'), on.log.join('\n'));
        on.cleanup();
        for (const services of ['{"biometrics":{"enabled":false}}', 'not json']) {
            const off = run('y', { services });
            assert.equal(off.status, 0, off.stdout + off.stderr);
            assert.ok(off.log.includes('systemctl stop free-sleep free-sleep-stream'));
            assert.ok(off.log.includes('systemctl start free-sleep'));
            assert.ok(!off.log.some((line) => /start [^\n]*free-sleep-stream/.test(line)), off.log.join('\n'));
            off.cleanup();
        }
    });
    it('starts the server, and not a switched-off stream, when the reset fails', () => {
        const result = run('y', { migrateFails: true });
        assert.notEqual(result.status, 0);
        assert.ok(result.log.includes('systemctl start free-sleep'), result.log.join('\n'));
        assert.ok(!result.log.some((line) => /start [^\n]*free-sleep-stream/.test(line)), result.log.join('\n'));
        result.cleanup();
    });
});
//# sourceMappingURL=resetDbScript.test.js.map