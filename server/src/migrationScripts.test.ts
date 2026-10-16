import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The fork-switch tool is the
// highest-stakes script in this repo: it runs against someone ELSE's pod,
// possibly mid-sleep. It can't be unit-tested against a real second fork's
// pod, so this gates the same class of invariant updaterScripts.test.ts and
// rollbackScript.test.ts gate for update.sh/rollback_pod.sh: parses, and the
// documented safety ordering is actually present in the source, in the
// right order, not just present anywhere in the file.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCRIPTS = [
  'scripts/migrate/switch-to-this-fork.sh',
  'scripts/migrate/pod-installer.sh',
  'scripts/migrate/restore-original-fork.sh',
];

function readScript(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function assertOrder(src: string, markers: string[], label: string) {
  let lastIdx = -1;
  for (const marker of markers) {
    // Search forward from just after the previous marker, indexOf() alone
    // would keep matching the same (possibly earlier) occurrence, e.g. a
    // function's definition instead of its later call site.
    const idx = src.indexOf(marker, lastIdx + 1);
    assert.ok(idx !== -1, `${label}: expected to find "${marker}" after the previous marker`);
    lastIdx = idx;
  }
}

describe('fork-switch tool scripts', () => {
  for (const script of SCRIPTS) {
    it(`${script} exists, parses (bash -n), and carries the exec bit`, () => {
      const full = path.join(repoRoot, script);
      assert.equal(existsSync(full), true, `${script} is missing`);
      assert.doesNotThrow(() => execFileSync('bash', ['-n', full]));
      const mode = statSync(full).mode;
      assert.ok(mode & 0o111, `${script} must carry the exec bit`);
    });
  }

  it('pod-installer.sh re-runs itself under bash and installs no Python packages', () => {
    const src = readScript('scripts/migrate/pod-installer.sh');
    assert.match(src, /^\[ -n "\$\{BASH_VERSION:-\}" \] \|\| exec bash "\$0" "\$@"$/m);
    assert.doesNotMatch(src, /\bpip3?\b|requirements/);
  });

  it('data-compat-check.mjs exists and parses', () => {
    const full = path.join(repoRoot, 'scripts/migrate/data-compat-check.mjs');
    assert.equal(existsSync(full), true);
    assert.doesNotThrow(() => execFileSync('node', ['--check', full]));
  });

  describe('switch-to-this-fork.sh ordering', () => {
    const src = readScript('scripts/migrate/switch-to-this-fork.sh');

    it('never modifies anything before the typed "switch" confirmation', () => {
      assertOrder(src, [
        "Type 'switch' to proceed",
        'Stage 4: backing up the pod',
      ], 'switch-to-this-fork.sh');
    });

    it('checks for its helper files before anything else happens', () => {
      assertOrder(src, [
        'was not found next to this script',
        "Type 'switch' to proceed",
        'Stage 5: pushing the installer',
      ], 'switch-to-this-fork.sh');
    });

    it('takes the iptables snapshot pre-consent (before the typed confirmation)', () => {
      assertOrder(src, [
        'IPTABLES_SNAPSHOT_LOCAL=$(mktemp)',
        "Type 'switch' to proceed",
      ], 'switch-to-this-fork.sh');
    });

    it('double-verifies the backup (pod + laptop, size match) before pushing the installer', () => {
      assertOrder(src, [
        'Backup verified in both places',
        'Stage 5: pushing the installer',
      ], 'switch-to-this-fork.sh');
      assert.match(src, /tar tzf "\$LOCAL_BACKUP_TARBALL"/, 'must verify the laptop copy with tar tzf');
      assert.match(src, /REMOTE_SIZE.*LOCAL_SIZE|LOCAL_SIZE.*REMOTE_SIZE/s, 'must compare pod and laptop backup sizes');
    });

    it('pushes the pre-consent iptables snapshot to the pod rather than trusting a late re-snapshot', () => {
      assert.match(src, /scp_to_pod "\$SSH_PORT" "\$IPTABLES_SNAPSHOT_LOCAL"/);
    });

    it('starts the installer detached (systemd-run, falling back to nohup)', () => {
      assert.match(src, /systemd-run --unit=free-sleep-migrate/);
      assert.match(src, /nohup setsid bash \/usr\/local\/lib\/nightstand\/migrate\/pod-installer\.sh/);
    });

    it('the pod-generation gate matrix refuses Pod 1/2 with no override', () => {
      assert.match(src, /Pod 1\/2 have no free-sleep lineage.*no override|fail "Pod 1\/2/);
      assert.doesNotMatch(
        src.replace(/#.*/g, ''),
        /pod1\|pod2\)\s*\n\s*:\s*;;/,
        'pod1/pod2 must not silently pass through'
      );
    });

    it('requires a typed acknowledgment for Pod 3/4 and for any --assume-model use', () => {
      assert.match(src, /pod4-ok/);
      assert.match(src, /IDENTIFICATION_FAILED/);
    });
  });

  describe('pod-installer.sh ordering', () => {
    const src = readScript('scripts/migrate/pod-installer.sh');

    // main only moves at a release, so its tip is the newest release; the
    // staged-version check still refuses a tip that does not match the manifest.
    it('installs the newest release from the tip of main', () => {
      assert.match(src, /MAIN_ZIP_URL="https:\/\/github\.com\/LTimothy\/nightstand\/archive\/refs\/heads\/main\.zip"/);
      assert.match(src, /print\(data\['releases'\]\[0\]\['version'\]/);
      assert.doesNotMatch(src, /r\['channel'\] == 'stable'/);
      assert.match(src, /staged tree reports v\$STAGED_VERSION but v\$TARGET_VERSION was requested/);
    });

    it('switch-to-this-fork.sh tells the user the version it is about to install', () => {
      const laptop = readScript('scripts/migrate/switch-to-this-fork.sh');
      assert.match(laptop, /print\(data\['releases'\]\[0\]\['version'\]/);
      assert.match(laptop, /Install LTimothy\/nightstand v\$NEWEST_VERSION/);
    });

    it('guards entry with a lock file before any other work', () => {
      const lockIdx = src.indexOf('LOCK_FILE');
      const resolveIdx = src.indexOf('Resolving the newest release');
      assert.ok(lockIdx !== -1 && lockIdx < resolveIdx, 'lock file check must precede real work');
    });

    it('refuses to run while another fork-update service is active', () => {
      assert.match(src, /free-sleep-update\.service/);
      assert.match(src, /free-sleep-rollback\.service/);
      assert.match(src, /systemctl is-active --quiet/);
    });

    it('verifies artifact hashes and runs the data-compat dry run before the swap', () => {
      assertOrder(src, [
        'Verifying artifact hashes',
        'Data-compatibility dry run',
        'Stopping their service',
      ], 'pod-installer.sh');
    });

    it('copies the restore script outside both trees before the swap', () => {
      assertOrder(src, [
        'cp "$RESTORE_SCRIPT_SRC" "$RESTORE_SCRIPT_DEST"',
        'Stopping their service',
      ], 'pod-installer.sh');
      assert.match(src, /RESTORE_SCRIPT_DEST=\/usr\/local\/lib\/nightstand\/restore-original-fork\.sh/);
    });

    it('arms the dead-man sentinel before stopping their service, and only disarms after a passed health check', () => {
      assertOrder(src, [
        'systemctl enable --now "$SENTINEL_TIMER"',
        'Stopping their service',
        'Health check passed',
        'disarm_sentinel',
      ], 'pod-installer.sh');
    });

    it('never executes the staged build pre-swap (syntax check only, port 3000 still belongs to their server)', () => {
      assert.doesNotMatch(src, /node -e "require\(/, 'must not require()/execute the staged server.js before the swap');
      assert.match(src, /node --check "\$STAGE\/server\/dist\/server\.js"/);
    });

    // The previous fork's sudoers file has no rules for this fork's Roll back
    // and Revert to stock units, so the installer has to add them. It does so
    // only after the health check, so a failed install restores their fork
    // without any of it.
    it('installs the app-control units and sudoers rules only after the health check passes', () => {
      assert.ok(
        src.indexOf('bash "$COPY/scripts/setup_services.sh"') > src.indexOf('if [ "$HEALTHY" != yes ]'),
        'setup_services.sh must not run before the health check',
      );
      assertOrder(src, [
        'Health check passed',
        'bash "$COPY/scripts/setup_services.sh" "$COPY"',
        'block_internet_access.sh',
        'disarm_sentinel',
      ], 'pod-installer.sh');
      assert.doesNotMatch(src, /\/etc\/sudoers/, 'sudoers changes belong in setup_services.sh');
    });

    // The first arming of the hardware watchdog can reset the Pod. Before the
    // sentinel is disarmed, that reset would restore their fork 12 minutes
    // after boot even though the migration had succeeded.
    it('turns on the hardware watchdog only after the sentinel is disarmed', () => {
      const success = src.slice(src.indexOf('Health check passed'));
      const disarm = success.indexOf('\ndisarm_sentinel\n');
      const arm = success.indexOf('bash "$COPY/scripts/setup_watchdog.sh"');
      assert.ok(disarm > 0, 'expected the sentinel to be disarmed on success');
      assert.ok(arm > disarm, 'setup_watchdog.sh must run after disarm_sentinel');
      // A reset during the trial must not leave a healthy migration recorded
      // as unfinished, so the success record and line come first.
      assert.ok(arm > success.indexOf('write_status "install" "success"'), 'arm after the success status is written');
      assert.ok(arm > success.indexOf('say "SUCCESS: migrated'), 'arm after the SUCCESS line');
      assert.ok(arm > success.indexOf('rm -f "$SWAP_MARKER"'), 'arm after the swap marker is cleared');
      assert.equal(src.split('setup_watchdog.sh').length - 1, 2, 'one guard and one call, both after the swap succeeded');
      assert.match(success, /bash "\$COPY\/scripts\/setup_watchdog\.sh" --auto /, 'an owner\'s --remove stays in force');
    });

    it('applies this fork\'s WAN policy only after the health check succeeds', () => {
      assertOrder(src, [
        'if [ "$HEALTHY" != yes ]',
        'Health check passed',
        'block_internet_access.sh',
      ], 'pod-installer.sh');
    });

    it('never rm -rf\'s /persistent/free-sleep-data or /persistent/free-sleep-backups', () => {
      assert.doesNotMatch(src, /rm[^\n]*\/persistent\/free-sleep-data/);
      assert.doesNotMatch(src, /rm[^\n]*\/persistent\/free-sleep-backups/);
    });

    it('the previous tree lands at the same path update.sh/rollback_pod.sh use for instant rollback', () => {
      assert.match(src, /PREV=\/home\/dac\/free-sleep-prev/);
    });

    // Health check must pass on HTTP 200 + version match. A 200 (not our fast
    // 503-while-connecting) already proves the hub link is up; additionally
    // requiring populated per-side temperatures false-failed a healthy migration
    // because currentTemperatureF reads null for the first cycles after a cold
    // Franken connect. Temperature lag is a logged NOTE, never a failure.
    it('does not hard-fail the health check on a not-yet-populated temperature', () => {
      assert.doesNotMatch(src, /assert isinstance\(d\[side\]\['currentTemperatureF'\]/);
      assert.doesNotMatch(src, /lost temperature reporting/);
      assert.match(src, /not yet reporting a numeric temperature/);
    });

    it('still passes only on HTTP 200 with a matching staged version', () => {
      assertOrder(src, [
        '"$CODE" = 200',
        "d['freeSleep']['version'] == '$STAGED_VERSION'",
      ], 'pod-installer.sh health check');
    });

    // The pod's own updater may already keep a rollback tree at $PREV. Set it
    // aside (never rm -rf) and drop a swap marker so restore keys off "did WE
    // swap", not the bare existence of $PREV.
    it('sets the pod\'s pre-existing rollback slot aside instead of destroying it', () => {
      assert.match(src, /mv "\$PREV" "\$PREEXISTING_PREV"/);
      assert.doesNotMatch(src, /^\s*rm -rf "\$PREV"\s*$/m);
    });

    it('drops the swap marker before mutating $LIVE and clears it on success', () => {
      assertOrder(src, [
        ': > "$SWAP_MARKER"',
        'mv "$LIVE" "$PREV"',
        'mv "$STAGE" "$LIVE"',
        'Health check passed',
        'rm -f "$SWAP_MARKER"',
      ], 'pod-installer.sh swap marker');
    });

    // free-sleep-rollback.service is a static, on-demand oneshot that swaps
    // $LIVE <-> $PREV. `enable --now`-ing it during install executes an instant
    // rollback that transposes the just-installed tree back out before the
    // health check, the exact defect that failed two live migrations. The
    // archive-raw TIMER is periodic and correctly started; the rollback SERVICE
    // must never be started here.
    it('never starts (enable --now) the instant-rollback service during install', () => {
      assert.doesNotMatch(src, /--now\s+free-sleep-rollback\.service/);
      assert.doesNotMatch(src, /systemctl\s+start\s+free-sleep-rollback\.service/);
      // the periodic archive timer is still legitimately started
      assert.match(src, /enable --now free-sleep-archive-raw\.timer/);
    });

    // The swap stops free-sleep-stream (its binary lives in the tree being
    // moved); nothing else restarts it, so the installer must, or live
    // biometrics stay dark until the next reboot.
    it('restarts free-sleep-stream after the swap (it stops it earlier)', () => {
      assertOrder(src, [
        'systemctl stop free-sleep-stream',
        'systemctl start free-sleep',
        'systemctl start free-sleep-stream',
      ], 'pod-installer.sh stream restart');
    });

    // As update.sh does: only a stream that was running before the swap is
    // started again. The other fork's Biometrics flag is not read, since a
    // first install there can leave it off while the stream runs.
    it('starts free-sleep-stream again only if it was running before the swap', () => {
      const before = src.indexOf('systemctl stop free-sleep-stream');
      const captured = src.lastIndexOf('systemctl is-active free-sleep-stream', before);
      assert.ok(captured > 0 && captured < before, 'read whether it ran before stopping it');
      // Run that part with each state systemd can report. A stream between
      // restarts reads activating, and it was running too.
      const from = src.indexOf('STREAM_WAS_ACTIVE=no');
      const block = src.slice(from, src.indexOf('if [ -f "$DATABASE" ]', from));
      for (const [state, expected] of [['active', 'active'], ['activating', 'active'], ['reloading', 'active'],
        ['inactive', 'no'], ['failed', 'no']]) {
        const out = execFileSync('bash', ['-c', `systemctl() { [ "$1" = is-active ] && echo ${state}; return 0; }
restore_and_report() { :; }
${block}
echo "$STREAM_WAS_ACTIVE"`], { encoding: 'utf8' });
        assert.equal(out.trim().split('\n').pop(), expected, state);
      }
      const start = src.indexOf('systemctl start free-sleep-stream', before);
      const gate = src.lastIndexOf('\n', start);
      assert.match(src.slice(src.lastIndexOf('\n', gate - 1), start), /if \[ "\$STREAM_WAS_ACTIVE" = active \]; then\s*$/);
      assert.equal(src.split('systemctl start free-sleep-stream').length - 1, 1, 'no other start');
      assert.doesNotMatch(src, /servicesDB/, 'the other fork\'s flag is not consulted');
    });

    // A fork moving here has no update channel yet; the server would default
    // to stable and offer a Pod on a beta nothing until a stable passed it.
    it('saves the installed release\'s channel after the swap, before the server starts', () => {
      assert.match(src, /read -r TARGET_VERSION TARGET_CHANNEL <<< "\$PICK"/);
      assertOrder(src, [
        'mv "$STAGE" "$LIVE"',
        '# A fork moving here has no update channel yet',
        '/persistent/free-sleep-data/lowdb/settingsDB.json "$TARGET_CHANNEL"',
        'systemctl start free-sleep ||',
      ], 'pod-installer.sh channel save');
      const block = src.slice(src.indexOf('# A fork moving here has no update channel yet'), src.indexOf('systemctl start free-sleep ||'));
      assert.match(block, /if "updateChannel" in data:\n\s+sys\.exit\(0\)/, 'keeps a channel the carried-over settings already have');
      assert.match(block, /\|\| say "WARNING: could not save the update channel"/, 'never fails the migration over it');
    });

    it('adds the channel only where the carried-over settings have none, keeping the file mode', () => {
      const block = src.slice(src.indexOf('# A fork moving here has no update channel yet'), src.indexOf('systemctl start free-sleep ||'));
      const run = (existing: string | null, channel: string, failWrite = false) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-migrate-'));
        const settings = path.join(dir, 'settingsDB.json');
        if (existing !== null) {
          writeFileSync(settings, existing);
          chmodSync(settings, 0o660);
        }
        let section = block.replaceAll('/persistent/free-sleep-data/lowdb/settingsDB.json', settings);
        if (failWrite) section = section.replace('os.replace(tmp, path)', 'raise OSError("simulated")');
        const result = spawnSync('bash', ['-c', `say() { echo "$*"; }\nTARGET_CHANNEL="$TEST_CHANNEL"\n${section}`], {
          env: { ...process.env, TEST_CHANNEL: channel }, encoding: 'utf8',
        });
        const saved = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : null;
        const mode = existsSync(settings) ? statSync(settings).mode & 0o777 : null;
        const tmpKept = existsSync(`${settings}.tmp`);
        rmSync(dir, { recursive: true, force: true });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Traceback/);
        return { saved, mode, tmpKept, out: result.stdout };
      };
      assert.deepEqual(run(null, 'beta').saved, { updateChannel: 'beta' });
      const added = run('{"timeZone":"UTC"}', 'beta');
      assert.deepEqual([added.saved, added.mode], [{ timeZone: 'UTC', updateChannel: 'beta' }, 0o660]);
      const failed = run('{"timeZone":"UTC"}', 'beta', true);
      assert.deepEqual([failed.saved, failed.tmpKept], [{ timeZone: 'UTC' }, false]);
      assert.match(failed.out, /WARNING: could not save the update channel/);
      assert.deepEqual(run('{"updateChannel":"stable"}', 'beta').saved, { updateChannel: 'stable' });
      assert.equal(run(null, 'nightly').saved, null);
    });
  });

  describe('restore-original-fork.sh idempotency', () => {
    const src = readScript('scripts/migrate/restore-original-fork.sh');

    // Their stream comes back only if their Pod had it enabled. The restore
    // can run after a reboot, so it reads systemd's saved state, which the
    // migration never changes, rather than whether it was running.
    it('starts their stream again only if it is enabled', () => {
      const fn = src.slice(src.indexOf('start_stream_if_enabled() {'), src.indexOf('\n}\n', src.indexOf('start_stream_if_enabled() {')) + 3);
      for (const [state, started] of [['enabled', true], ['disabled', false], ['masked', false], ['', false]] as const) {
        const out = execFileSync('bash', ['-c', `LOG=$(mktemp)
systemctl() { echo "systemctl $*" >> "$LOG"; [ "$1" = is-enabled ] && echo "${state}"; return 0; }
${fn}
start_stream_if_enabled
cat "$LOG"; rm -f "$LOG"`], { encoding: 'utf8' });
        assert.equal(out.includes('systemctl start free-sleep-stream'), started, `${state}: ${out}`);
      }
      assert.equal(src.split('systemctl start free-sleep-stream').length - 1, 1, 'only the gated start');
      assert.equal(src.split('\nstart_stream_if_enabled\n').length - 1 + src.split('  start_stream_if_enabled\n').length - 1, 2,
        'both the no-op and the revert path use it');
    });

    it('documents the swap-never/half/already-happened decision table', () => {
      assert.match(src, /never happened, half\s*\n?#?\s*happened, or already happened/);
    });

    it('gates the whole revert on the installer swap marker, not the bare existence of $PREV', () => {
      // Keying off $PREV alone would (a) mistake the pod's own pre-existing
      // rollback slot for the install we swapped out and (b) undo a migration
      // that already succeeded (whose marker is gone). The marker is the signal.
      assertOrder(src, [
        'if [ ! -f "$SWAP_MARKER" ]',
        'systemctl start free-sleep',
      ], 'restore-original-fork.sh');
    });

    it('restores the pod\'s pre-existing rollback slot on both the no-op and revert paths', () => {
      // On revert the stashed slot goes back to $PREV; on the no-op path (died
      // before the swap) it is only put back when $PREV is currently free.
      assert.match(src, /mv "\$PREEXISTING_PREV" "\$PREV"/);
      assert.match(src, /if \[ ! -d "\$PREV" \] && \[ -d "\$PREEXISTING_PREV" \]/);
    });

    it('clears the swap marker on the completed revert path', () => {
      assertOrder(src, [
        'Swap marker present',
        'finish_artifact_restore "auto-restored" "$RESTORE_MESSAGE"',
      ], 'restore-original-fork.sh');
      const finish = src.slice(src.indexOf('finish_artifact_restore() {'), src.indexOf('\ncleanup_nightstand_services() {'));
      assertOrder(finish, ['record_restore_state artifacts-pending', 'rm -f "$SWAP_MARKER"', 'restore_legacy_artifacts'], 'artifact restore');
    });

    it('never rm -rf\'s /persistent/free-sleep-data or /persistent/free-sleep-backups', () => {
      assert.doesNotMatch(src, /rm[^\n]*\/persistent\/free-sleep-data/);
      assert.doesNotMatch(src, /rm[^\n]*\/persistent\/free-sleep-backups/);
    });

    it('disarms the sentinel on every exit path', () => {
      const occurrences = src.split('disarm_sentinel').length - 1;
      assert.ok(occurrences >= 2, 'expected disarm_sentinel on both the no-op and restore paths');
    });
  });

  // "Already on this fork" must be decided from the pod's on-disk updater repo,
  // not the HTTP version stream, otherwise a sibling fork that shares the 3.x
  // stream is wrongly refused before SSH even starts. Gate that the decision is
  // deferred and repo-based, so a future edit can't quietly reintroduce the
  // version-only hard stop.
  describe('switch-to-this-fork.sh sibling-fork identification', () => {
    const src = readScript('scripts/migrate/switch-to-this-fork.sh');

    it('does not refuse purely on the version-stream heuristic', () => {
      // The version check may exist as a hint, but must not `fail` on its own.
      assert.doesNotMatch(src, /MAJOR_VERSION[\s\S]{0,240}?-ge 3[\s\S]{0,240}?\bfail /);
    });

    it('reads the pod-side updater and refuses only when it names THIS repo', () => {
      assert.match(src, /THIS_FORK_REPO="LTimothy\/nightstand"/);
      assertOrder(src, [
        '$REMOTE_REPO/scripts/update.sh',
        'ONDISK_FORK_REPO',
        '"$ONDISK_FORK_REPO" = "$THIS_FORK_REPO"',
        'fail ',
      ], 'switch-to-this-fork.sh sibling check');
    });

    it('proceeds when the on-disk updater names a different repo', () => {
      // The non-empty, non-matching branch must be a `say`, not a `fail`.
      assert.match(src, /if \[ -n "\$ONDISK_FORK_REPO" \]; then\s*\n\s*say /);
    });

    // Pod generation must come from the hub's own deviceStatus.coverVersion, not
    // an ls-glob for "capSense2" filenames: those strings are CBOR field names
    // inside <hex>.RAW files, never filenames, so the glob matched nothing on any
    // Pod and forced every real user through --assume-model.
    it('detects pod generation from deviceStatus coverVersion', () => {
      assert.match(src, /COVER_VERSION=.*coverVersion/);
      assert.match(src, /case "\$COVER_VERSION" in/);
    });
  });
});

// pod-installer.sh refuses to overwrite a stranger's install unless the staged
// tree's own serverInfo.json names this fork. That makes the script and the
// file a contract, and nothing else reads the field, so if the tree stops
// carrying it the only symptom is that every migration aborts. The failure
// also reports "no readable serverInfo.json", which points at the wrong cause.
describe('pod-installer.sh and serverInfo.json agree about the fork field', () => {
  const src = readScript('scripts/migrate/pod-installer.sh');
  const serverInfo = JSON.parse(readScript('server/src/serverInfo.json'));

  it('has the fork field the installer reads out of a staged tree', () => {
    assert.match(src, /serverInfo\.json"\)\)\["fork"\]/);
    assert.ok(
      Object.hasOwn(serverInfo, 'fork'),
      'pod-installer.sh reads serverInfo.json["fork"], so a tree without that field aborts every migration at the staged-tree check',
    );
  });

  it('carries the exact fork value the installer accepts', () => {
    const expected = /\[ "\$STAGED_FORK" = "([^"]+)" \]/.exec(src)?.[1];
    assert.ok(expected, 'could not find the fork comparison in pod-installer.sh');
    assert.equal(
      serverInfo.fork,
      expected,
      `pod-installer.sh accepts a staged tree only when its fork field is "${expected}"`,
    );
  });
});

// The tool's report and success text send people to the app's rollback, so
// they must name the labels the app shows today.
describe('the fork-switch tool names the app\'s real rollback path', () => {
  const tool = ['scripts/migrate/switch-to-this-fork.sh', 'scripts/migrate/pod-installer.sh'].map(readScript).join('\n');

  it('points at Settings > Software > Recovery', () => {
    assert.doesNotMatch(tool, /Software & updates/);
    assert.doesNotMatch(tool, /"Roll back"|> Roll back|in-app Roll back/);
    assert.equal(tool.split('Settings > Software > Recovery').length - 1, 4, tool.match(/Settings >[^\n]*/g)?.join('\n'));
  });

  it('uses labels the app shows', () => {
    assert.match(readScript('app/src/pages/SettingsPage/settingsCategories.ts'), /key: 'versions', title: 'Software'/);
    assert.match(readScript('app/src/pages/SettingsPage/VersionsPage/VersionsPage.tsx'), />Recovery<\/AccordionSummary>/);
  });
});

describe('the fork switch runs root-owned copies', () => {
  it('runs the fork switch from the root-owned folder and copies the fresh tree for root before the stage exists', () => {
    const tool = readScript('scripts/migrate/switch-to-this-fork.sh');
    assert.match(tool, /bash \/usr\/local\/lib\/nightstand\/migrate\/pod-installer\.sh/);
    for (const file of ['scripts/migrate/pod-installer.sh', 'scripts/migrate/agent-bootstrap-installer.sh']) {
      const src = readScript(file);
      const work = src.indexOf('WORK=$(mktemp -d "$SYSTEM_DIR/.download.XXXXXX")');
      const publish = src.indexOf('COPY=$(python3 -B "$FRESH/scripts/system_scripts.py" publish "$FRESH")');
      const stage = src.indexOf('mv "$FRESH" "$STAGE"');
      assert.ok(work > 0 && work < publish && publish < stage && stage < src.indexOf('chown -R dac:dac "$STAGE"'), file);
      assert.doesNotMatch(src, /\$STAGE\/scripts\/system_scripts\.py/, file);
      assert.match(src, /bash "\$COPY\/scripts\/setup_services\.sh" "\$COPY"/, file);
    }
  });

  it('downloads, unpacks and copies the release where the server user cannot reach it', () => {
    const src = readScript('scripts/migrate/pod-installer.sh');
    const start = src.indexOf('say "Downloading v$TARGET_VERSION');
    const end = src.indexOf('chown -R dac:dac "$STAGE"', start);
    assert.ok(start > 0 && end > start);
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-migrate-stage-'));
    try {
      const release = path.join(dir, 'release/nightstand-main/scripts');
      mkdirSync(release, { recursive: true });
      writeFileSync(path.join(release, 'system_scripts.py'),
        'import os, sys\nrecord = os.path.abspath(__file__) + " " + " ".join(sys.argv[1:])\n'
        + 'open(os.environ["FIXTURE"] + "/published", "w").write(record)\nprint("/copy")\n');
      execFileSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
        path.join(dir, 'release'), path.join(dir, 'release')]);
      const result = spawnSync('bash', ['-c', `set -uo pipefail
SYSTEM_DIR="$FIXTURE/system"; STAGE="$FIXTURE/home/free-sleep-migrate-staging"
TARGET_VERSION=3.7.0; MAIN_ZIP_URL=https://example.invalid/main.zip
mkdir -p "$FIXTURE/home" "$STAGE/old"
say() { :; }
fail() { echo "FAIL $*"; exit 1; }
curl() { while [ "$1" != -o ]; do shift; done; cp "$FIXTURE/release.zip" "$2"; }
${src.slice(start, end)}
echo "COPY=$COPY"`], { encoding: 'utf8', env: { ...process.env, FIXTURE: dir } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^COPY=\/copy$/m);
      const [tool, command, tree] = readFileSync(path.join(dir, 'published'), 'utf8').split(' ');
      const system = path.join(dir, 'system');
      assert.equal(command, 'publish');
      assert.match(tree, new RegExp(`^${system}/\\.download\\.[^/]+/tree/nightstand-main$`));
      assert.equal(tool, path.join(tree, 'scripts/system_scripts.py'));
      assert.ok(existsSync(path.join(dir, 'home/free-sleep-migrate-staging/scripts/system_scripts.py')));
      assert.ok(!existsSync(path.join(dir, 'home/free-sleep-migrate-staging/old')));
      assert.deepEqual(readdirSync(system), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
