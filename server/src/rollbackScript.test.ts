import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/rollback_pod.sh swaps the
// live install back to the previous tree. It's bash, so like update.sh it
// can't be unit-tested directly: gate the invariants that would otherwise
// brick a rollback silently: it refuses to run against a missing/unreadable
// PREV, it never unblocks WAN, and it always restores on a failed health
// check rather than leaving the pod on neither tree.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/rollback_pod.sh';
const UNIT = 'scripts/systemd/free-sleep-rollback.service';

describe('rollback_pod.sh', () => {
  it('exists, parses (bash -n), and carries the exec bit', () => {
    const full = path.join(repoRoot, SCRIPT);
    assert.equal(existsSync(full), true, `${SCRIPT} is missing`);
    assert.doesNotThrow(() => execFileSync('bash', ['-n', full]));
    const mode = statSync(full).mode;
    assert.ok(mode & 0o111, `${SCRIPT} must carry the exec bit`);
  });

  it('refuses to run against a missing or unreadable PREV', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    assert.match(src, /no previous install at \$PREV/);
    assert.match(src, /refusing to swap to an unknown tree/);
  });

  it('applies the restored firewall without opening a download window', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    assert.doesNotMatch(src, /unblock_internet_access/);
    assert.match(src, /sh "\$NIGHTSTAND_SCRIPTS\/block_internet_access\.sh"/);
  });

  it('restores the running version if the post-swap health check fails', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    assert.match(src, /Health check FAILED: swapping back/);
    // The restore path must re-run the shared node_modules fixup and
    // actually start the service back up, not just log and exit.
    const restoreIdx = src.indexOf('Health check FAILED: swapping back');
    const rest = src.slice(restoreIdx);
    assert.match(rest, /fix_shared_node_modules/);
    assert.match(rest, /restart_services/);
  });

  it('detects and relocates a shared node_modules copy after the swap', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    assert.match(src, /fix_shared_node_modules\s*\(\)\s*{/, 'expected a fix_shared_node_modules helper');
    assert.match(src, /local source="\$\{1:-\$PREV\}"/);
    assert.match(src, /cmp -s "\$LIVE\/server\/package-lock\.json" "\$source\/server\/package-lock\.json"/);
  });

  it('removes the health check, network watchdog and watchdog setting only when rolling back to another fork', () => {
    const src = readFileSync(path.join(repoRoot, SCRIPT), 'utf8');
    const success = src.slice(src.indexOf('if [ "$HEALTHY" = yes ]; then'), src.indexOf('# --- swap back on failure'));
    const otherFork = success.slice(success.indexOf('if [ "$TARGET_IS_NIGHTSTAND" != yes ]; then'), success.indexOf('\n  fi\n'));
    assert.match(otherFork, /disable --now [^\n]*free-sleep-health\.timer/);
    assert.match(otherFork, /\/etc\/systemd\/system\/free-sleep-health\.service/);
    assert.match(otherFork, /\/etc\/systemd\/system\/free-sleep-health\.timer/);
    assert.match(otherFork, /disable --now [^\n]*free-sleep-network-watchdog\.timer/);
    assert.match(otherFork, /\/etc\/systemd\/system\/free-sleep-network-watchdog\.service/);
    assert.match(otherFork, /\/etc\/systemd\/system\/free-sleep-network-watchdog\.timer/);
    // After the swap, $PREV holds the Nightstand tree that was running.
    // --switching records no owner choice, so a later install turns it on.
    assert.match(otherFork, /bash "\$NIGHTSTAND_SCRIPTS\/setup_watchdog\.sh" --remove --switching /);
    assert.equal(success.match(/setup_watchdog/g)?.length, 2, 'a Nightstand target keeps the watchdog');
  });

  it('the systemd unit runs the script via bash and exists', () => {
    const full = path.join(repoRoot, UNIT);
    assert.equal(existsSync(full), true, `${UNIT} is missing`);
    const src = readFileSync(full, 'utf8');
    assert.match(src, /ExecStart=\/bin\/bash \/usr\/local\/lib\/nightstand\/live\/scripts\/rollback_pod\.sh/);
  });

  it('setup_services.sh installs the rollback service and its sudoers rule', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/setup_services.sh'), 'utf8');
    assert.match(src, /free-sleep-rollback\.service/);
    assert.match(src, /NOPASSWD: \/bin\/systemctl start free-sleep-rollback\.service --no-block/);
  });

  it('install.sh and update.sh both run setup_services.sh', () => {
    for (const script of ['scripts/install.sh', 'scripts/update.sh']) {
      const src = readFileSync(path.join(repoRoot, script), 'utf8');
      assert.match(src, /bash "\$(COPY|NEW_COPY)\/scripts\/setup_services\.sh"/, script);
    }
  });
});
