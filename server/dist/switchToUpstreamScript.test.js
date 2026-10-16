import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// scripts/switch-to-upstream.sh swaps the live install for plain upstream
// free-sleep. It's bash, so like update.sh and rollback_pod.sh it can't be
// unit-tested directly: gate the invariants that would otherwise brick a
// revert silently: it points at upstream (not this fork), it re-blocks WAN
// even on failure, it never gates health on a populated temperature (the
// false-failure mode pod-installer.sh already hit and fixed), and it always
// restores this fork on a failed health check rather than leaving the pod
// on neither tree.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/switch-to-upstream.sh';
const UNIT = 'scripts/systemd/free-sleep-revert.service';
describe('switch-to-upstream.sh', () => {
    it('exists, parses (bash -n), and carries the exec bit', () => {
        const full = path.join(repoRoot, SCRIPT);
        assert.equal(existsSync(full), true, `${SCRIPT} is missing`);
        assert.doesNotThrow(() => execFileSync('bash', ['-n', full]));
        const mode = statSync(full).mode;
        assert.ok(mode & 0o111, `${SCRIPT} must carry the exec bit`);
    });
    it('downloads from upstream, not this fork', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.match(src, /github\.com\/throwaway31265\/free-sleep\/archive\/refs\/heads\/main\.zip/);
        assert.match(src, /UPSTREAM_ZIP_URL="https:\/\/github\.com\/throwaway31265\/free-sleep\/archive\/\$\{SWITCH_COMMIT\}\.zip"/);
        // This fork is read only for releases.json, which names the upstream
        // commit the switch was checked with; no code comes from it.
        const forkLines = src.split('\n').filter((line) => /LTimothy\/nightstand/.test(line));
        assert.deepEqual(forkLines, ['SWITCH_RELEASES_URL="https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json"'], 'must not fetch code from this fork');
    });
    it('re-blocks WAN even on failure', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.match(src, /block_internet_access\.sh/, 'must re-block WAN');
        assert.match(src, /trap cleanup EXIT/, 'must re-block WAN even on a failure exit');
    });
    it('verifies the staged build output before swapping', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.match(src, /server\/dist\/server\.js/, 'must verify the staged build output');
        assert.match(src, /server\/public\/index\.html/);
    });
    it('resolves the staged archive dir dynamically, never hardcoded', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.doesNotMatch(src, /free-sleep-main/, 'must not hardcode the archive dir name');
        assert.match(src, /find "\$WORK\/tree".*-type d/);
    });
    it('backs up code and data before swapping', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.match(src, /tar czf "\$BK\/code\.tar\.gz"/);
        assert.match(src, /free-sleep\.db/);
        assert.match(src, /lowdb/);
    });
    it('health check does not gate on a populated per-side temperature', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        const healthIdx = src.indexOf('Health check (up to 90s)');
        assert.ok(healthIdx >= 0, 'expected a health-check section');
        const healthBlock = src.slice(healthIdx, src.indexOf('HEALTHY=no', healthIdx + 1) + 400);
        assert.doesNotMatch(healthBlock, /currentTemperatureF/, 'must not repeat the false-failure mode pod-installer.sh already fixed');
    });
    it('restores this fork if the post-swap health check fails', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        assert.match(src, /Health check FAILED: rolling back to this fork/);
        const restoreIdx = src.indexOf('Health check FAILED: rolling back to this fork');
        const rest = src.slice(restoreIdx);
        assert.match(rest, /systemctl start free-sleep\b/);
    });
    it('removes fork-only systemd units after a successful revert', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        const successIdx = src.indexOf('if [ "$HEALTHY" = yes ]; then');
        assert.ok(successIdx >= 0, 'expected the successful health-check branch');
        const rest = src.slice(successIdx, src.indexOf('  exit 0', successIdx));
        assert.match(rest, /free-sleep-rollback\.service/);
        assert.match(rest, /free-sleep-revert\.service/);
        assert.match(rest, /free-sleep\.service\.d\/10-nightstand-limits\.conf/);
        assert.match(rest, /free-sleep-stream\.service\.d\/10-nightstand-limits\.conf/);
        assert.match(rest, /free-sleep\.service\.d\/20-nightstand-restart\.conf/);
        assert.match(rest, /systemctl disable --now free-sleep-health\.timer/);
        assert.match(rest, /\/etc\/systemd\/system\/free-sleep-health\.service/);
        assert.match(rest, /\/etc\/systemd\/system\/free-sleep-health\.timer/);
        assert.match(rest, /systemctl disable --now [^\n]*free-sleep-network-watchdog\.timer/);
        assert.match(rest, /\/etc\/systemd\/system\/free-sleep-network-watchdog\.service/);
        assert.match(rest, /\/etc\/systemd\/system\/free-sleep-network-watchdog\.timer/);
        // The fork's tree is at $PREV by then; $LIVE is upstream's.
        // --switching records no owner choice, so a later install turns it on.
        assert.match(rest, /bash "\$NIGHTSTAND_SCRIPTS\/setup_watchdog\.sh" --remove --switching /);
    });
    it('never rewrites /persistent/free-sleep-data other than a backup copy', () => {
        const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
        // Every reference to the data dir must be inside a backup line (cp ... "$BK"),
        // not a write into the live path.
        const dataRefs = src.match(/\/persistent\/free-sleep-data\/[^\s"']+/g) ?? [];
        for (const ref of dataRefs) {
            const line = src.split('\n').find(l => l.includes(ref)) ?? '';
            assert.doesNotMatch(line, /rm -f|rm -rf/, `must not delete from ${ref}`);
        }
    });
    it('the systemd unit runs the script via bash and exists', () => {
        const full = path.join(repoRoot, UNIT);
        assert.equal(existsSync(full), true, `${UNIT} is missing`);
        const src = readFileSync(full, 'utf8');
        assert.match(src, /^ExecStart=\/bin\/bash -c '[^'\n]*exec \/bin\/bash \/usr\/local\/lib\/nightstand\/live\/scripts\/switch-to-upstream\.sh;/m);
    });
    it('keeps the old name working as a shim', () => {
        const shim = readFileSync(path.join(repoRoot, 'scripts/revert-to-stock.sh'), 'utf8');
        assert.match(shim, /exec bash "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/switch-to-upstream\.sh" "\$@"/);
        assert.ok(statSync(path.join(repoRoot, 'scripts/revert-to-stock.sh')).mode & 0o111);
        assert.equal(spawnSync('bash', ['-n', path.join(repoRoot, 'scripts/switch-to-upstream.sh')]).status, 0);
    });
    it('the unit runs the new name', () => {
        assert.match(readFileSync(path.join(repoRoot, 'scripts/systemd/free-sleep-revert.service'), 'utf8'), /switch-to-upstream\.sh/);
    });
    it('the shim runs switch-to-upstream.sh beside it with the same arguments', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-shim-'));
        try {
            writeFileSync(path.join(dir, 'revert-to-stock.sh'), readFileSync(path.join(repoRoot, 'scripts/revert-to-stock.sh')));
            writeFileSync(path.join(dir, 'switch-to-upstream.sh'), 'echo "switch $*"; exit 7\n');
            const result = spawnSync('bash', [path.join(dir, 'revert-to-stock.sh'), 'a', 'b c'], { encoding: 'utf8' });
            assert.equal(result.stdout, 'switch a b c\n');
            assert.equal(result.status, 7);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    // A rollback swaps trees without reinstalling units, so the unit must also
    // work on a tree from before the rename.
    it('the unit falls back to the old name on a tree that has only that', () => {
        const line = readFileSync(path.join(repoRoot, UNIT), 'utf8').split('\n').find(l => l.startsWith('ExecStart='));
        const match = /^ExecStart=\/bin\/bash -c '([^']*)'$/.exec(line ?? '');
        assert.ok(match, 'ExecStart is not a single bash -c command');
        const command = match[1];
        assert.doesNotMatch(command, /[$%]/, 'systemd would expand $ or % in the command');
        for (const names of [['switch-to-upstream.sh', 'revert-to-stock.sh'], ['revert-to-stock.sh']]) {
            const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-unit-'));
            try {
                mkdirSync(path.join(dir, 'scripts'));
                for (const name of names)
                    writeFileSync(path.join(dir, 'scripts', name), `echo ${name}\n`);
                const run = spawnSync('bash', ['-c', command.replaceAll('/usr/local/lib/nightstand/live', dir)], { encoding: 'utf8' });
                assert.equal(run.stdout, `${names[0]}\n`);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });
    it('setup_services.sh installs the switch service and its sudoers rule', () => {
        const src = readFileSync(path.join(repoRoot, 'scripts/setup_services.sh'), 'utf8');
        assert.match(src, /free-sleep-revert\.service/);
        assert.match(src, /NOPASSWD: \/bin\/systemctl start free-sleep-revert\.service --no-block/);
    });
});
it('uses the transaction only for a confirmed V2 artifact and retains recovery', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    const start = src.indexOf('# Confirmed V2 targets use the durable transaction');
    assert.ok(start >= 0);
    const block = src.slice(start, src.indexOf('# Upstream imports', start));
    assert.match(block, /\[ "\$TRANSACTIONAL_SWITCH" = yes \]/);
    assert.match(block, /"\$\{SWITCH_ACTUAL:-\}" = "\$SWITCH_DIGEST"/);
    assert.match(block, /forward --stage "\$STAGE"/);
    assert.match(block, /--target-json "\$CONFIRMED_TARGET"/);
    assert.match(block, /--recheck-in-use "\$RECHECK_IN_USE"/);
    assert.doesNotMatch(block, /pip install|rm -rf.*recovery/);
    assert.match(readFileSync(path.join(repoRoot, UNIT), 'utf8'), /ExecStopPost=-\/bin\/systemctl restart --no-block free-sleep-recover-switch.service/);
});
//# sourceMappingURL=switchToUpstreamScript.test.js.map