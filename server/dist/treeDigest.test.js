import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_MANIFEST } from './agent/agentManifest.js';
import { fakeDiskEnv, writeFakeDiskTools } from './testing/fakeDisk.js';
// scripts/tree_digest.py is what a release's published checksum is computed
// with, on the Mac at release time and on the Pod before an install. Both
// must arrive at the same value for the same tree, whatever the archive did
// to timestamps and permissions.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (dir) => execFileSync('python3', [path.join(repoRoot, 'scripts/tree_digest.py'), dir], { encoding: 'utf8' }).trim();
function tree(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-tree-'));
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), content);
    }
    return dir;
}
describe('tree_digest.py', () => {
    it('ignores releases.json, timestamps and permissions', () => {
        const a = tree({ 'a.txt': 'one', 'server/b.js': 'two', 'releases.json': '{"x":1}' });
        const b = tree({ 'server/b.js': 'two', 'a.txt': 'one', 'releases.json': '{"x":2}' });
        chmodSync(path.join(b, 'a.txt'), 0o755);
        assert.equal(digest(a), digest(b));
        rmSync(a, { recursive: true });
        rmSync(b, { recursive: true });
    });
    it('leaves out only the top-level releases.json', () => {
        const a = tree({ 'a.txt': 'one', 'docs/releases.json': '1' });
        const b = tree({ 'a.txt': 'one', 'docs/releases.json': '2' });
        assert.notEqual(digest(a), digest(b));
        rmSync(a, { recursive: true });
        rmSync(b, { recursive: true });
    });
    it('changes when any file or name changes, and counts symlinks', () => {
        const base = tree({ 'a.txt': 'one' });
        const changed = tree({ 'a.txt': 'onf' });
        const renamed = tree({ 'b.txt': 'one' });
        const linked = tree({ 'a.txt': 'one' });
        symlinkSync('a.txt', path.join(linked, 'l'));
        const dirLinked = tree({ 'sub/a.txt': 'one' });
        const dirPlain = tree({ 'sub/a.txt': 'one' });
        symlinkSync('sub', path.join(dirLinked, 'alias'));
        assert.notEqual(digest(base), digest(changed));
        assert.notEqual(digest(base), digest(renamed));
        assert.notEqual(digest(base), digest(linked));
        assert.notEqual(digest(dirLinked), digest(dirPlain));
        for (const dir of [base, changed, renamed, linked, dirLinked, dirPlain])
            rmSync(dir, { recursive: true });
    });
    it('digests what git archive of HEAD produces, read directly or unpacked', () => {
        const out = mkdtempSync(path.join(tmpdir(), 'nightstand-archive-'));
        execFileSync('bash', ['-c', `git -C "${repoRoot}" archive HEAD | tar -x -C "${out}"`]);
        const fromTar = execFileSync('bash', ['-c',
            `git -C "${repoRoot}" archive HEAD | python3 "${repoRoot}/scripts/tree_digest.py" --tar -`], { encoding: 'utf8' }).trim();
        assert.match(fromTar, /^[0-9a-f]{64}$/);
        assert.equal(digest(out), fromTar);
        rmSync(out, { recursive: true });
    });
    it('ships in the overlay, so a stock install can check its first update', () => {
        const entry = AGENT_MANIFEST.find(item => item.path === 'scripts/tree_digest.py');
        assert.ok(entry, 'scripts/tree_digest.py is not in the agent manifest');
        assert.equal(entry.mode, 'add');
    });
});
const CHECKSUM_MISMATCH = (version) => `the download of v${version} does not match its published checksum; live install untouched`;
describe('update.sh checks the staged tree', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');
    it('verifies before installing dependencies or handing off', () => {
        const verify = src.indexOf('\nverify_tree "$STAGED_DIR"\n');
        assert.ok(verify > src.indexOf('STAGED_DIR=$(find'));
        assert.ok(verify < src.indexOf('system_scripts.py" publish "$STAGED_DIR"'));
        assert.ok(verify < src.indexOf('run_limited 900 sudo -u dac'));
        assert.ok(verify < src.indexOf('exec bash "$NEW_COPY/scripts/update.sh"'));
    });
    it('uses the installed copy of the digest script, not the downloaded one', () => {
        assert.match(src, /python3 "\$NIGHTSTAND_SCRIPTS\/tree_digest\.py" "\$tree"/);
        assert.doesNotMatch(src, /python3 "\$STAGE\/scripts\/tree_digest\.py"/);
    });
    it('reports a checksum mismatch without changing the live install', () => {
        assert.match(src, /does not match its published checksum; live install untouched/);
    });
});
// Runs a script from its start up to `marker` with the Pod's paths moved into
// a temp folder, the firewall, ownership and disk tools faked, and curl
// answering with a fixture manifest and a fixture archive.
function runStaging(script, marker, options) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-verify-'));
    const podHome = path.join(dir, 'home');
    const data = path.join(dir, 'persistent/free-sleep-data');
    mkdirSync(path.join(podHome, 'free-sleep/server/src'), { recursive: true });
    mkdirSync(path.join(podHome, 'free-sleep/scripts'), { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(podHome, 'free-sleep/server/src/serverInfo.json'), '{"version":"3.5.1"}');
    // The root-owned scripts the run starts from hold the installed digest script.
    const scriptDir = path.join(dir, 'scripts');
    mkdirSync(scriptDir);
    if (options.liveDigest === 'broken') {
        writeFileSync(path.join(scriptDir, 'tree_digest.py'), 'raise SystemExit(1)\n');
    }
    else if (options.liveDigest !== false) {
        copyFileSync(path.join(repoRoot, 'scripts/tree_digest.py'), path.join(scriptDir, 'tree_digest.py'));
    }
    if (options.target)
        writeFileSync(path.join(data, 'update-target.json'), JSON.stringify({ version: options.target }));
    const source = path.join(dir, 'source');
    for (const [name, content] of Object.entries(options.tree)) {
        mkdirSync(path.dirname(path.join(source, options.archiveTop, name)), { recursive: true });
        writeFileSync(path.join(source, options.archiveTop, name), content);
    }
    const zip = path.join(dir, 'fixture.zip');
    execFileSync('python3', ['-c', `import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for base, _, names in os.walk(sys.argv[2]):
        for name in names:
            full = os.path.join(base, name)
            archive.write(full, os.path.relpath(full, sys.argv[2]))`, zip, source]);
    const bin = path.join(dir, 'bin');
    writeFakeDiskTools(bin);
    for (const tool of ['iptables', 'ip6tables', 'chown'])
        writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
out=; url=
while [ $# -gt 0 ]; do
  case $1 in
    -o|--max-time) [ "$1" = -o ] && out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "$url" >> "$FAKE_CURL_LOG"
if [ -n "$out" ]; then cp "$FAKE_ZIP" "$out"; exit; fi
[ -f "$FAKE_MANIFEST" ] || exit 22
cat "$FAKE_MANIFEST"
`, { mode: 0o755 });
    const manifest = path.join(dir, 'manifest.json');
    if (options.manifest !== undefined) {
        writeFileSync(manifest, typeof options.manifest === 'string' ? options.manifest : JSON.stringify(options.manifest));
    }
    copyFileSync(path.join(repoRoot, 'scripts/write_result.py'), path.join(scriptDir, 'write_result.py'));
    copyFileSync(path.join(repoRoot, 'scripts/system_scripts.py'), path.join(scriptDir, 'system_scripts.py'));
    copyFileSync(path.join(repoRoot, 'scripts/restore_helpers.sh'), path.join(scriptDir, 'restore_helpers.sh'));
    const end = script.indexOf(marker);
    assert.ok(end > 0, `missing ${marker}`);
    const file = path.join(scriptDir, 'run.sh');
    writeFileSync(file, script.slice(0, end)
        .replaceAll('/persistent/free-sleep-data', data)
        .replaceAll('/usr/local/lib/nightstand', path.join(dir, 'system'))
        .replaceAll('/home/dac', podHome));
    const curlLog = path.join(dir, 'curl.log');
    const result = spawnSync('bash', [file], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
            ...fakeDiskEnv(bin, { rootFreeMb: 100_000, persFreeMb: 100_000 }),
            NIGHTSTAND_OPERATION_LOCK: path.join(dir, 'lock'), NIGHTSTAND_SYSTEM_DIR: path.join(dir, 'system'),
            FAKE_ZIP: zip, FAKE_MANIFEST: manifest, FAKE_CURL_LOG: curlLog,
        },
    });
    const resultFile = path.join(data, 'update-result.json');
    const output = {
        status: result.status,
        out: `${result.stdout}${result.stderr}`,
        record: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : {},
        urls: existsSync(curlLog) ? readFileSync(curlLog, 'utf8').trim().split('\n') : [],
        liveVersion: readFileSync(path.join(podHome, 'free-sleep/server/src/serverInfo.json'), 'utf8'),
        staged: existsSync(path.join(podHome, 'free-sleep-staging')) || existsSync(path.join(podHome, 'free-sleep-revert-staging')),
        digest: digest(path.join(source, options.archiveTop)),
    };
    rmSync(dir, { recursive: true, force: true });
    return output;
}
describe('update.sh with a published checksum', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');
    const release = {
        'server/src/serverInfo.json': '{"version":"3.6.0"}',
        'server/dist/server.js': 'server',
        'server/public/index.html': 'app',
        'scripts/update.sh': '#!/bin/bash\n',
        'releases.json': '{"from":"the download"}',
    };
    const expected = digest(tree(Object.fromEntries(Object.entries(release).filter(([name]) => name !== 'releases.json'))));
    const manifest = (treeSha256) => ({
        channels: ['stable', 'beta'],
        releases: [{ kind: 'bundle', version: '3.6.0', channel: 'stable', date: '2026-10-02', ...(treeSha256 ? { treeSha256 } : {}) }],
    });
    const update = (treeSha256, extra = {}) => runStaging(src, '# the pod runs prebuilt code', { manifest: manifest(treeSha256), archiveTop: 'nightstand-3.6.0', tree: release, ...extra });
    it('installs a download that matches, and says so', () => {
        const result = update(expected);
        assert.equal(result.status, 0, result.out);
        assert.equal(result.digest, expected);
        assert.match(result.out, /v3\.6\.0 matches its published checksum/);
    });
    for (const [what, extra] of [['the newest release', {}], ['a requested version', { target: '3.6.0' }]]) {
        it(`refuses ${what} whose download does not match, before anything changes`, () => {
            const result = update('0'.repeat(64), extra);
            assert.equal(result.status, 1, result.out);
            assert.match(result.out, new RegExp(`FATAL: ${CHECKSUM_MISMATCH('3.6.0').replaceAll('.', '\\.')}`));
            assert.equal(result.record.outcome, 'stopped');
            assert.equal(result.record.message, CHECKSUM_MISMATCH('3.6.0'));
            assert.equal(result.record.to, '3.6.0');
            assert.equal(result.liveVersion, '{"version":"3.5.1"}');
            assert.equal(result.staged, false);
            assert.equal(result.urls.length, 2, 'fetches the manifest once and the archive once');
        });
    }
    it('installs a release published before checksums, with a log line', () => {
        const result = update(undefined);
        assert.equal(result.status, 0, result.out);
        assert.match(result.out, /No published checksum for v3\.6\.0; installing without one/);
    });
    it('stops before anything changes when the checksum cannot be computed', () => {
        const result = update(expected, { liveDigest: 'broken' });
        assert.equal(result.status, 1, result.out);
        assert.equal(result.record.outcome, 'stopped');
        assert.equal(result.record.message, 'could not compute the checksum of v3.6.0; live install untouched');
        assert.equal(result.liveVersion, '{"version":"3.5.1"}');
    });
    it('installs without a check when the installed version has no digest script yet', () => {
        const result = update('0'.repeat(64), { liveDigest: false });
        assert.equal(result.status, 0, result.out);
        assert.match(result.out, /This install cannot check checksums yet; installing without one/);
    });
});
describe('switch-to-upstream.sh installs the upstream commit the switch was checked with', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/switch-to-upstream.sh'), 'utf8');
    const commit = 'a'.repeat(40);
    const upstream = {
        'server/src/serverInfo.json': '{"version":"2.1.5"}',
        'server/dist/server.js': 'server',
        'server/public/index.html': 'app',
    };
    const expected = digest(tree(upstream));
    const MISMATCH = 'the download of upstream free-sleep does not match its published checksum; live install untouched';
    const UNREADABLE = 'could not read the release list to find the checked upstream version; live install untouched';
    const switchTo = (manifest, extra = {}, archiveTop = `free-sleep-${commit}`) => runStaging(src, '# --- dependencies (old server still running)', { manifest, archiveTop, tree: upstream, ...extra });
    const pinned = (pin) => ({ channels: ['stable'], releases: [], upstreamSwitch: pin });
    const stoppedBeforeChanging = (result, reason) => {
        assert.equal(result.status, 1, result.out);
        assert.match(result.out, new RegExp(`FATAL: ${reason.replaceAll('.', '\\.')}`));
        assert.equal(result.record.operation, 'switch');
        assert.equal(result.record.outcome, 'stopped');
        assert.equal(result.record.message, reason);
        assert.equal(result.liveVersion, '{"version":"3.5.1"}');
        assert.equal(result.staged, false);
    };
    it('downloads the recorded commit and checks it', () => {
        const result = switchTo(pinned({ commit, date: '2026-10-02', treeSha256: expected }));
        assert.equal(result.status, 0, result.out);
        assert.equal(result.urls[1], `https://github.com/throwaway31265/free-sleep/archive/${commit}.zip`);
        assert.match(result.out, new RegExp(`Installing upstream commit ${commit}, the one this switch was checked with`));
        assert.match(result.out, /matches its published checksum/);
    });
    it('refuses a recorded commit whose download does not match, before anything changes', () => {
        stoppedBeforeChanging(switchTo(pinned({ commit, date: '2026-10-02', treeSha256: '0'.repeat(64) })), MISMATCH);
    });
    it('stops before anything changes when the checksum cannot be computed', () => {
        stoppedBeforeChanging(switchTo(pinned({ commit, date: '2026-10-02', treeSha256: expected }), { liveDigest: 'broken' }), 'could not compute the checksum of upstream free-sleep; live install untouched');
    });
    it('installs a recorded commit without a checksum, and says it went unchecked', () => {
        const result = switchTo(pinned({ commit, date: '2026-10-02' }));
        assert.equal(result.status, 0, result.out);
        assert.equal(result.urls[1], `https://github.com/throwaway31265/free-sleep/archive/${commit}.zip`);
        assert.match(result.out, new RegExp(`No published checksum for upstream commit ${commit}; installing without one`));
    });
    it('installs upstream\'s main only when the release list was read and records no checked commit', () => {
        const result = switchTo({ channels: ['stable'], releases: [] }, {}, 'free-sleep-main');
        assert.equal(result.status, 0, result.out);
        assert.equal(result.urls[0], 'https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json');
        assert.equal(result.urls[1], 'https://github.com/throwaway31265/free-sleep/archive/refs/heads/main.zip');
        assert.match(result.out, /No checked upstream commit is recorded; installing upstream's main/);
    });
    for (const [what, manifest] of [
        ['the release list cannot be fetched', undefined],
        ['the release list is not JSON', '<html>rate limited</html>'],
        ['the release list is not an object', '[]'],
        ['the recorded commit is not a full commit id', pinned({ commit: 'main', date: '2026-10-02' })],
        ['the record is not an object', pinned('main')],
        ['the record is empty', pinned(null)],
        ['the recorded checksum is malformed', pinned({ commit, date: '2026-10-02', treeSha256: 'abc' })],
    ]) {
        it(`stops before downloading anything when ${what}`, () => {
            const result = switchTo(manifest);
            stoppedBeforeChanging(result, UNREADABLE);
            assert.equal(result.urls.length, 1, 'nothing is downloaded');
        });
    }
});
//# sourceMappingURL=treeDigest.test.js.map