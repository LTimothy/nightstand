import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL, MB, fakeDiskEnv, writeFakeDiskTools } from './testing/fakeDisk.js';
// The free-space checks that run before an update, a revert, a deploy and a
// fork switch. They are sized from what each one writes, so they run here
// against a fake df and du on PATH that report a given partition and install.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');
const HELPER_FILES = [
    'scripts/update.sh',
    'scripts/switch-to-upstream.sh',
    'scripts/migrate/pod-installer.sh',
    'scripts/migrate/switch-to-this-fork.sh',
    'ops/deploy.sh',
];
function between(src, from, to) {
    const start = src.indexOf(from);
    assert.ok(start >= 0, `missing boundary: ${from}`);
    const end = src.indexOf(to, start + from.length);
    assert.ok(end > start, `missing boundary: ${to}`);
    return src.slice(start, end);
}
function helpers(src) {
    const start = src.indexOf('# Free-space helpers');
    assert.ok(start >= 0, 'missing the free-space helpers');
    return src.slice(start, src.indexOf('\n}\n', src.indexOf('node_fetch_mb() {', start)) + 3);
}
// The check on the test amounts, which runs before anything else changes.
function knobCheck(src) {
    return `${between(src, '# Tests can ask for more room', '\ndone\n')}\ndone\n`;
}
const DB_HINT = /old snapshots in \/persistent\/free-sleep-database-backups\/ can be removed/;
let root;
let live;
let stage;
let volta;
function pinNode(tree, version) {
    mkdirSync(path.join(tree, 'server'), { recursive: true });
    writeFileSync(path.join(tree, 'server/package.json'), JSON.stringify({ volta: { node: version } }));
}
function run(script, disk, extraEnv = {}) {
    const result = spawnSync('bash', ['-c', script.replaceAll('/home/dac/.volta', volta)], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { ...fakeDiskEnv(path.join(root, 'bin'), disk), NIGHTSTAND_TEST_EXTRA_ROOT_MB: undefined,
            NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB: undefined, ...extraEnv },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
}
const PRELUDE = `set -uo pipefail
say() { echo "$*"; }
fail() { echo "FATAL: $*"; exit 1; }
`;
// Each check, as the script runs it, ending in a line that says it passed.
const CHECKS = {
    'update.sh': (handoff = false) => {
        const src = read('scripts/update.sh');
        return `${PRELUDE}LIVE='${live}'; PRUNE_SNAPSHOTS='${live}/prune_db_snapshots.sh'; HANDOFF=${handoff ? 1 : "''"}
${helpers(src)}${knobCheck(src)}${between(src, '# --- preflight', 'if [ "$HANDOFF" = 1 ]; then')}
echo "PASSED / $ROOT_NEED /persistent $PERS_NEED"`;
    },
    'switch-to-upstream.sh': () => {
        const src = read('scripts/switch-to-upstream.sh');
        return `${PRELUDE}LIVE='${live}'; PRUNE_SNAPSHOTS='${live}/prune_db_snapshots.sh'
${helpers(src)}${knobCheck(src)}${between(src, '# --- preflight', '# --- download + stage')}
echo "PASSED / $ROOT_NEED /persistent $PERS_NEED"`;
    },
    'pod-installer.sh': () => {
        const src = read('scripts/migrate/pod-installer.sh');
        return `${PRELUDE}LIVE='${live}'
${helpers(src)}${between(src, '# Room for what this installer writes', 'say "Downloading v')}
echo "PASSED / $ROOT_NEED /persistent $PERS_NEED"`;
    },
    'deploy.sh': () => {
        const src = read('ops/deploy.sh');
        const remote = between(src, "<<'PREFLIGHT'", '\nPREFLIGHT\n').split('\n').slice(1).join('\n');
        return `set -- '${live}' 24.11.0
${remote}
echo "PASSED"`;
    },
    'switch-to-this-fork.sh': () => {
        const src = read('scripts/migrate/switch-to-this-fork.sh');
        return `${PRELUDE.replace('FATAL', 'ABORTED')}SSH_PORT=8822
ssh_cmd() { shift; bash -c "$*"; }
${between(src, '# Disk space, both sides.', 'LAPTOP_FREE_KB=').replaceAll('/home/dac/free-sleep', live)}
echo "PASSED / $REMOTE_ROOT_NEED /persistent $REMOTE_PERS_NEED"`;
    },
};
// The checks that run once the release is staged, before its dependencies.
function stagedCheck(file, lockChanged, handoff = false) {
    const src = read(file);
    const section = file.endsWith('pod-installer.sh')
        ? between(src, '# What / still takes now that the release is staged', 'say "Ensuring Node/Volta')
        : between(src, '# --- dependencies (old server still running)', file.endsWith('update.sh') ? 'if [ "$HANDOFF" != 1 ]; then\n  if [ "$LOCK_SAME"' : 'if [ "$LOCK_SAME" = no ]; then\n  say');
    writeFileSync(path.join(live, 'server/package-lock.json'), 'live');
    writeFileSync(path.join(stage, 'server/package-lock.json'), lockChanged ? 'staged' : 'live');
    return `${PRELUDE}LIVE='${live}'; STAGE='${stage}'; HANDOFF=${handoff ? 1 : "''"}
MODULES_MB=330; DB_MB=40
${helpers(src)}${section}
echo "PASSED / $DEPS_NEED"`;
}
describe('free-space checks before an update, revert, deploy or switch', () => {
    before(() => {
        root = mkdtempSync(path.join(tmpdir(), 'nightstand-space-'));
        live = path.join(root, 'free-sleep');
        stage = path.join(root, 'free-sleep-staging');
        volta = path.join(root, 'volta');
        mkdirSync(path.join(live, 'server/src'), { recursive: true });
        writeFileSync(path.join(live, 'server/src/serverInfo.json'), '{"version":"3.5.1"}');
        pinNode(live, '24.11.0');
        pinNode(stage, '24.11.0');
        mkdirSync(path.join(volta, 'tools/image/node/24.11.0'), { recursive: true });
        writeFakeDiskTools(path.join(root, 'bin'));
    });
    after(() => rmSync(root, { recursive: true, force: true }));
    it('every script carries the same helpers', () => {
        const reference = helpers(read(HELPER_FILES[0]));
        assert.match(reference, /SPACE_MARGIN_MB=64/);
        assert.match(reference, /node_fetch_mb\(\) \{/);
        for (const file of HELPER_FILES.slice(1)) {
            assert.equal(helpers(read(file)), reference, file);
        }
    });
    it('no script keeps a fixed 2000 or 1500 MB gate', () => {
        for (const file of HELPER_FILES) {
            assert.doesNotMatch(read(file), /FREE\S*"?\s+-gt (?:2000|1500)\b/, file);
        }
    });
    it('free_mb matches what the filesystem reports, and size_mb what a file takes', () => {
        const dir = path.join(root, 'real');
        mkdirSync(dir);
        writeFileSync(path.join(dir, 'blob'), Buffer.alloc(3 * MB * 1024, 1));
        const result = spawnSync('bash', ['-c', `${helpers(read('scripts/update.sh'))}
echo "$(free_mb '${dir}') $(size_mb '${dir}') $(size_mb '${dir}/missing')"`], { encoding: 'utf8' });
        const fs = statfsSync(dir);
        const expected = Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
        assert.equal(result.status, 0, result.stderr);
        const [free, size, missing] = result.stdout.trim().split(' ').map(Number);
        assert.ok(Math.abs(free - expected) <= 1, `free_mb ${free}, statfs ${expected}`);
        assert.ok(size >= 3 && size <= 5, result.stdout);
        assert.equal(missing, 0);
    });
    it('the fake df and du refuse flags the scripts do not use', () => {
        const env = { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}` };
        assert.equal(spawnSync('df', ['-mP', '/'], { env }).status, 2);
        assert.equal(spawnSync('du', ['-sm', '/'], { env }).status, 2);
    });
    // About 1 GB of /persistent, held near a quarter free by the RAW archive.
    const pod3 = { rootFreeMb: 1200, persFreeMb: 250 };
    for (const name of ['update.sh', 'switch-to-upstream.sh', 'pod-installer.sh', 'deploy.sh']) {
        it(`${name} passes on a 1 GB /persistent that has the room`, () => {
            const result = run(CHECKS[name](), pod3);
            assert.equal(result.status, 0, result.out);
            assert.match(result.out, /PASSED/);
        });
        it(`${name} refuses a nearly full /persistent, says how much it needs and what can go`, () => {
            const result = run(CHECKS[name](), { rootFreeMb: 1200, persFreeMb: 50 });
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, /(?:low disk on \/persistent|LOW_DISK_PERSISTENT:) \(?50M free, \d+M needed/);
            assert.match(result.out, DB_HINT);
            assert.doesNotMatch(result.out, /PASSED/);
        });
        it(`${name} refuses a nearly full / and says how much it needs`, () => {
            const result = run(CHECKS[name](), { rootFreeMb: 100, persFreeMb: 4000 });
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, /(?:low disk on \/|LOW_DISK_ROOT:) \(?100M free, \d+M needed/);
        });
        it(`${name} counts the database's write-ahead log`, () => {
            const result = run(CHECKS[name](), { ...pod3, install: { ...INSTALL, wal: 200 * MB } });
            assert.equal(result.status, 1, result.out);
        });
        it(`${name} refuses when df cannot be read`, () => {
            const result = run(CHECKS[name](), { rootFreeMb: 6000, persFreeMb: 12000, silentDf: true });
            assert.equal(result.status, 1, result.out);
        });
        it(`${name} passes on a large partition, as before`, () => {
            const result = run(CHECKS[name](), { rootFreeMb: 6000, persFreeMb: 12000 });
            assert.equal(result.status, 0, result.out);
        });
        it(`${name} refuses a large partition that the database would fill`, () => {
            // More than the old flat 2000 MB, still short of a 3 GB database's copy.
            const install = { ...INSTALL, db: 3000 * MB };
            const result = run(CHECKS[name](), { rootFreeMb: 6000, persFreeMb: 2500, install });
            assert.equal(result.status, 1, result.out);
        });
    }
    // A test can ask for more room than the script needs, never less.
    for (const name of ['update.sh', 'switch-to-upstream.sh']) {
        it(`${name} refuses on /persistent when a test asks for more room than is free`, () => {
            const result = run(CHECKS[name](), pod3, { NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB: '100000' });
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, /low disk on \/persistent \(\d+M free, \d+M needed/);
        });
        it(`${name} refuses on / when a test asks for more room there`, () => {
            const result = run(CHECKS[name](), pod3, { NIGHTSTAND_TEST_EXTRA_ROOT_MB: '100000' });
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, /low disk on \/ \(/);
        });
        it(`${name} adds the extra amounts to what it needs`, () => {
            const base = run(CHECKS[name](), pod3).out.match(/PASSED \/ (\d+) \/persistent (\d+)/);
            const result = run(CHECKS[name](), { rootFreeMb: 9000, persFreeMb: 9000 }, { NIGHTSTAND_TEST_EXTRA_ROOT_MB: '0100', NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB: '7' });
            assert.match(result.out, new RegExp(`PASSED / ${Number(base[1]) + 100} /persistent ${Number(base[2]) + 7}`));
        });
        it(`${name} treats an empty extra amount as unset`, () => {
            const unset = run(CHECKS[name](), pod3).out;
            const env = { NIGHTSTAND_TEST_EXTRA_ROOT_MB: '', NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB: '' };
            const result = run(CHECKS[name](), pod3, env);
            assert.equal(result.status, 0, result.out);
            assert.equal(result.out, unset);
        });
        it(`${name} accepts the longest amount it counts`, () => {
            const result = run(CHECKS[name](), pod3, { NIGHTSTAND_TEST_EXTRA_ROOT_MB: '999999999' });
            assert.match(result.out, /low disk on \/ \(\d+M free, 1000000\d{3}M needed/);
        });
        it(`${name} leaves snapshots and a queued target request alone when an amount is invalid`, () => {
            const dir = mkdtempSync(path.join(root, 'untouched-'));
            const snapshot = path.join(dir, 'old-snapshot.db');
            const target = path.join(dir, 'update-target.json');
            const prune = path.join(dir, 'prune.sh');
            writeFileSync(snapshot, 'snapshot');
            writeFileSync(target, '{"version":"3.5.0"}');
            writeFileSync(prune, `rm -f '${snapshot}'\n`);
            const src = read(`scripts/${name}`);
            const stop = name === 'update.sh' ? 'if [ "$HANDOFF" = 1 ]; then' : '# --- download + stage';
            const script = `${PRELUDE}LIVE='${live}'; PRUNE_SNAPSHOTS='${prune}'; DATABASE_BACKUPS='${dir}'
TARGET_FILE='${target}'; HANDOFF=''; SWAP_MARKER='${dir}/swap-marker'
${helpers(src)}${between(src, "trap 'exit 143' TERM\n", stop)}
echo PASSED`;
            const bad = run(script, pod3, { NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB: '1e9' });
            assert.equal(bad.status, 1, bad.out);
            assert.match(bad.out, /must be a whole number of MB/);
            assert.equal(readFileSync(snapshot, 'utf8'), 'snapshot');
            assert.equal(readFileSync(target, 'utf8'), '{"version":"3.5.0"}');
            // The same script does prune and consume the request when the amount is fine.
            const good = run(script, pod3);
            assert.equal(good.status, 0, good.out);
            assert.equal(existsSync(snapshot), false);
            if (name === 'update.sh')
                assert.equal(existsSync(target), false);
        });
        for (const [label, value] of [['not a number', '1e9'], ['negative', '-5'], ['fractional', '2.5'],
            ['spaced', ' 5'], ['too long to count safely', '1000000000']]) {
            for (const key of ['NIGHTSTAND_TEST_EXTRA_ROOT_MB', 'NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB']) {
                it(`${name} stops on ${key} when it is ${label}`, () => {
                    const result = run(CHECKS[name](), pod3, { [key]: value });
                    assert.equal(result.status, 1, result.out);
                    assert.match(result.out, /must be a whole number of MB/);
                    assert.doesNotMatch(result.out, /PASSED/);
                });
            }
        }
    }
    it('only the two scripts read the test amounts; the server and the app never set them', () => {
        const grep = spawnSync('grep', ['-rlE', 'NIGHTSTAND_TEST_EXTRA_(ROOT|PERSISTENT)_MB', 'server/src', 'app/src', 'scripts', 'ops'], { cwd: repoRoot, encoding: 'utf8' });
        const files = grep.stdout.split('\n').filter(Boolean).filter((f) => !f.endsWith('spaceGateScripts.test.ts')).sort();
        assert.deepEqual(files, ['scripts/switch-to-upstream.sh', 'scripts/update.sh']);
    });
    it('update.sh sizes the 1 GB case from the install: code, database and a half, settings, margin', () => {
        const result = run(CHECKS['update.sh'](), pod3);
        // / 48*2 + 330 + 110 + 64; /persistent 48 + 40 + 20 + 1 + 64
        assert.match(result.out, /PASSED \/ 600 \/persistent 173/);
    });
    it('update.sh needs only the margin on / once the new version has taken over', () => {
        assert.equal(run(CHECKS['update.sh'](false), { rootFreeMb: 150, persFreeMb: 4000 }).status, 1);
        const handedOff = run(CHECKS['update.sh'](true), { rootFreeMb: 150, persFreeMb: 4000 });
        assert.equal(handedOff.status, 0, handedOff.out);
        assert.match(handedOff.out, /PASSED \/ 64 /);
    });
    it('pod-installer.sh never counts the release below what this fork ships', () => {
        const tiny = { tree: 5 * MB, modules: 20 * MB, db: 0 };
        const result = run(CHECKS['pod-installer.sh'](), { rootFreeMb: 6000, persFreeMb: 4000, install: tiny });
        // 64*2 + 400 + 133 + 0 + 64
        assert.match(result.out, /PASSED \/ 725 \/persistent 64/);
    });
    it('deploy.sh counts a Node that Volta would have to fetch', () => {
        const src = CHECKS['deploy.sh']();
        const cached = run(src, { rootFreeMb: 900, persFreeMb: 4000 });
        assert.equal(cached.status, 0, cached.out);
        // / 48*2 + 330 + 110 + 280 + 64 = 880
        const fetched = run(src.replace(`'${live}' 24.11.0`, `'${live}' 26.1.0`), { rootFreeMb: 870, persFreeMb: 4000 });
        assert.match(fetched.out, /LOW_DISK_ROOT: 870M free, 880M needed/);
    });
    for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
        it(`${file} checks / again once staged, for its dependencies and a new Node`, () => {
            try {
                assert.match(run(stagedCheck(file, false), { rootFreeMb: 100, persFreeMb: 0 }).out, /PASSED \/ 64$/m);
                // 330 + 110 + 64
                const deps = run(stagedCheck(file, true), { rootFreeMb: 400, persFreeMb: 0 });
                assert.equal(deps.status, 1, deps.out);
                assert.match(deps.out, /low disk on \/ \(400M free, 504M needed for (?:the new|upstream's) dependencies\); live install untouched/);
                pinNode(stage, '26.1.0');
                // 280 + 64; a pinned version Volta already has costs nothing.
                assert.match(run(stagedCheck(file, false), { rootFreeMb: 400, persFreeMb: 0 }).out, /PASSED \/ 344$/m);
                mkdirSync(path.join(volta, 'tools/image/node/26.1.0'));
                assert.match(run(stagedCheck(file, false), { rootFreeMb: 400, persFreeMb: 0 }).out, /PASSED \/ 64$/m);
            }
            finally {
                pinNode(stage, '24.11.0');
                rmSync(path.join(volta, 'tools/image/node/26.1.0'), { recursive: true, force: true });
            }
        });
    }
    it('update.sh after a handoff counts only a Node still to fetch, not the installed dependencies', () => {
        assert.match(run(stagedCheck('scripts/update.sh', true, true), { rootFreeMb: 100, persFreeMb: 0 }).out, /PASSED \/ 64$/m);
    });
    it('pod-installer.sh checks / again once staged, counting any Node Volta lacks', () => {
        const file = 'scripts/migrate/pod-installer.sh';
        // 280 is not added: Volta has 24.11.0. 330 + 110 + 40 + 20 + 64
        assert.match(run(stagedCheck(file, true), { rootFreeMb: 600, persFreeMb: 0 }).out, /PASSED \/ 564$/m);
        try {
            rmSync(path.join(volta, 'tools/image/node/24.11.0'), { recursive: true });
            const result = run(stagedCheck(file, true), { rootFreeMb: 600, persFreeMb: 0 });
            assert.match(result.out, /low disk on \/ \(600M free, 844M needed for the new dependencies\); their server was never touched/);
        }
        finally {
            mkdirSync(path.join(volta, 'tools/image/node/24.11.0'), { recursive: true });
        }
    });
    it('switch-to-this-fork.sh passes on a 1 GB /persistent with room for its full backup', () => {
        const result = run(CHECKS['switch-to-this-fork.sh'](), { rootFreeMb: 1200, persFreeMb: 700 });
        assert.equal(result.status, 0, result.out);
        // / installer 64*2 + 400 + 133 + 40 + 20, plus 64; /persistent backup
        // 48 + 330 + 40 + 1, its database copy 40, the installer's 40 + 20, plus 64.
        assert.match(result.out, /PASSED \/ 785 \/persistent 583/);
    });
    it('switch-to-this-fork.sh refuses before consent when the pod is nearly full', () => {
        const full = run(CHECKS['switch-to-this-fork.sh'](), { rootFreeMb: 1200, persFreeMb: 50 });
        assert.equal(full.status, 1, full.out);
        assert.match(full.out, /ABORTED: low disk on the pod's \/persistent \(50M free, 583M needed\)/);
        assert.match(full.out, DB_HINT);
        const rootFull = run(CHECKS['switch-to-this-fork.sh'](), { rootFreeMb: 100, persFreeMb: 4000 });
        assert.match(rootFull.out, /ABORTED: low disk on the pod's \/ \(100M free, 785M needed\)/);
        const large = run(CHECKS['switch-to-this-fork.sh'](), { rootFreeMb: 6000, persFreeMb: 12000 });
        assert.equal(large.status, 0, large.out);
    });
    it('switch-to-this-fork.sh reads an unreadable df on the pod as nothing free', () => {
        const result = run(CHECKS['switch-to-this-fork.sh'](), { rootFreeMb: 6000, persFreeMb: 12000, silentDf: true });
        assert.equal(result.status, 1, result.out);
        assert.match(result.out, /ABORTED: low disk on the pod's \/ \(0M free, 785M needed\)/);
    });
    for (const [label, reply] of [
        ['nothing', ''],
        ['a value missing, so the rest shift', ' 752 700 583'],
        ['a value that is not a number', '9000 752 x 583'],
        ['an extra value', '9000 752 9000 583 1'],
    ]) {
        it(`switch-to-this-fork.sh refuses when the pod answers with ${label}`, () => {
            const src = read('scripts/migrate/switch-to-this-fork.sh');
            const script = `${PRELUDE.replace('FATAL', 'ABORTED')}SSH_PORT=8822
ssh_cmd() { cat >/dev/null; printf '%s\\n' '${reply}'; }
${between(src, '# Disk space, both sides.', 'LAPTOP_FREE_KB=')}
echo PASSED`;
            const result = run(script, { rootFreeMb: 6000, persFreeMb: 12000 });
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, /ABORTED: could not measure free space on the pod/);
            assert.doesNotMatch(result.out, /PASSED/);
        });
    }
    it('every check still runs before anything on the install is changed', () => {
        const update = read('scripts/update.sh');
        assert.ok(update.indexOf('PERS_NEED') < update.indexOf('open_wan\n'));
        assert.ok(update.indexOf('DEPS_NEED') < update.indexOf('npm install'));
        assert.ok(update.indexOf('DEPS_NEED') < update.indexOf('# --- backup'));
        const revert = read('scripts/switch-to-upstream.sh');
        assert.ok(revert.indexOf('PERS_NEED') < revert.indexOf('open_wan\n'));
        assert.ok(revert.indexOf('DEPS_NEED') < revert.indexOf('$NPM_INSTALL --no-audit'));
        const installer = read('scripts/migrate/pod-installer.sh');
        assert.ok(installer.indexOf('PERS_NEED') < installer.indexOf('curl -fL --max-time 300'));
        assert.ok(installer.indexOf('DEPS_NEED') < installer.indexOf('ensure-node.sh" dac'));
        const deploy = read('ops/deploy.sh');
        assert.ok(deploy.indexOf('PERS_NEED') < deploy.indexOf('# --- backup'));
        const sw = read('scripts/migrate/switch-to-this-fork.sh');
        assert.ok(sw.indexOf('REMOTE_PERS_NEED') < sw.indexOf('Stage 4: backing up'));
        assert.ok(sw.indexOf('REMOTE_PERS_NEED') < sw.indexOf('[ "$CONFIRM" = "switch" ]'));
    });
});
//# sourceMappingURL=spaceGateScripts.test.js.map