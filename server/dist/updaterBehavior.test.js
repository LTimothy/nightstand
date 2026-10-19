import assert from 'node:assert/strict';
import { it } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve('..');
function section(file, from, to) {
    const src = readFileSync(path.join(root, file), 'utf8');
    const start = src.indexOf(from);
    assert.ok(start >= 0, `Missing boundary: ${from}`);
    const end = to ? src.indexOf(to, start) : src.length;
    assert.ok(end > start);
    return src.slice(start, end);
}
// Execute actual script sections with disposable trees. External service,
// network, ownership, and delay commands are replaced at their boundary.
function run(script, setup = '') {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-updater-'));
    for (const tree of ['live', 'prev']) {
        mkdirSync(path.join(dir, tree, 'server'), { recursive: true });
        writeFileSync(path.join(dir, tree, 'version'), tree === 'live' ? 'failed' : 'restored');
    }
    mkdirSync(path.join(dir, 'persistent/free-sleep-data/lowdb'), { recursive: true });
    // The root-owned scripts the run started from, stubbed.
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts/system_scripts.py'), 'import os, sys\nopen(os.environ["FIXTURE"] + "/system-scripts", "a").write(" ".join(sys.argv[1:]) + "\\n")\n');
    const env = { ...process.env, FIXTURE: dir };
    const fixtureScript = script.replaceAll('/home/dac/free-sleep', `${dir}/live`)
        .replaceAll('/persistent/', `${dir}/persistent/`).replaceAll('/usr/local/lib/nightstand', `${dir}/system`);
    const result = spawnSync('bash', ['-c', `set -uo pipefail
LIVE="$FIXTURE/live"; PREV="$FIXTURE/prev"; FAILED="$FIXTURE/failed"; TMP="$FIXTURE/tmp"; STAGE="$FIXTURE/stage"
NIGHTSTAND_SCRIPTS="$FIXTURE/scripts"; NEW_COPY="$FIXTURE/copy"; SYSTEM_DIR="$FIXTURE/system"
RECOVERY_HELPER="$FIXTURE/recovery-helper"
SWAP_MARKER="$FIXTURE/swap-marker"
BK=backup; CUR_VERSION=3.0.0; TARGET_VERSION=3.1.0; MOVED_MODULES=no; STREAM_WAS_ACTIVE=active
NPM=npm; NPX=npx; SSH_PORT=22; DRY_RUN=yes
say() { echo "$*"; }
fail() { echo "$*"; exit 1; }
sleep() { :; }
sync() { :; }
bash() {
  case "$1" in "$NIGHTSTAND_SCRIPTS/setup_services.sh"|"$RECOVERY_HELPER") return 0;; esac
  command bash "$@"
}
chown() { :; }
nice() { shift 2; "$@"; }
ionice() { shift 4; "$@"; }
export -f nice ionice
curl() { return 0; }
systemctl() { [ "$1" != is-active ] || { echo inactive; return 3; }; echo "$* $(cat "$LIVE/version")" >> "$FIXTURE/services"; }
ssh_cmd() { echo "$*" >> "$FIXTURE/ssh"; echo 0; }
restore_and_report() { echo restored > "$FIXTURE/restored"; }
fix_shared_node_modules() { :; }
restore_switch_data() { :; }
restore_switch_data_or_fail() { restore_switch_data || fail "$*"; }
${readFileSync(path.join(root, 'scripts/restore_helpers.sh'), 'utf8').replace(/^NIGHTSTAND_SCRIPTS=.*$/m, '')}
${section('scripts/rollback_pod.sh', 'restart_services() {', '# --- preflight')}
${setup}
${fixtureScript}`], { env, encoding: 'utf8', input: 'y\n', timeout: 5000 });
    const read = (name) => {
        try {
            return readFileSync(path.join(dir, name), 'utf8');
        }
        catch {
            return '';
        }
    };
    const output = {
        ...result, services: read('services'), ssh: read('ssh'), restored: read('restored'),
        liveVersion: read('live/version'), previousVersion: read('prev/version'), marker: read('marker'),
        serverState: read('state-free-sleep').trim(), streamState: read('state-free-sleep-stream').trim(), phase: read('phase'),
        failedVersion: read('failed/version'), tmpVersion: read('tmp/version'),
        outside: existsSync(path.join(dir, 'outside')) ? readdirSync(path.join(dir, 'outside')) : [],
        settings: read('persistent/free-sleep-data/lowdb/settingsDB.json'), modules: read('live/server/node_modules/marker'),
    };
    rmSync(dir, { recursive: true, force: true });
    return output;
}
// Keeps each unit's state, so a test can see what runs when the script ends.
// A command equal to TERM_ON interrupts the script once it has run, and one
// equal to STREAM_ON then starts the stream, as the server's Biometrics
// switch could while the server stops. A unit in
// STOP_FAILS fails to stop, one in STAYS_ACTIVE stops without ending, one in
// DEACTIVATING is still ending after its stop, and one in MISSING is not
// installed.
const statefulServices = (inactive = '') => `
for unit in free-sleep free-sleep-stream; do echo active > "$FIXTURE/state-$unit"; done
for unit in ${inactive}; do echo inactive > "$FIXTURE/state-$unit"; done
systemctl() {
  case "$1" in
    is-active) local state; state=$(cat "$FIXTURE/state-$2" 2>/dev/null || echo inactive); echo "$state"; [ "$state" = active ]; return;;
    show) case " \${MISSING:-} " in *" $4 "*) echo LoadState=not-found;; *) echo LoadState=loaded;; esac; return;;
  esac
  echo "$* $(cat "$LIVE/version" 2>/dev/null)" >> "$FIXTURE/services"
  if [ "$1" = stop ]; then
    case " \${MISSING:-} " in *" $2 "*) return 5;; esac
    case " \${STOP_FAILS:-} " in *" $2 "*) return 1;; esac
  fi
  case "$1" in
    stop)
      case " \${STAYS_ACTIVE:-} \${DEACTIVATING:-} " in
        *" $2 "*) [ " \${DEACTIVATING:-} " = " $2 " ] && echo deactivating > "$FIXTURE/state-$2";;
        *) echo inactive > "$FIXTURE/state-$2";;
      esac;;
    start|restart) echo active > "$FIXTURE/state-$2";;
  esac
  [ "$*" != "\${STREAM_ON:-}" ] || echo active > "$FIXTURE/state-free-sleep-stream"
  [ "$*" != "\${TERM_ON:-}" ] || kill -TERM $$
}`;
it('a failed fork migration restores the original without starting the failed build', () => {
    const result = run(section('scripts/migrate/pod-installer.sh', 'say "Running prisma', '# --- health check'), 'sudo() { return 1; }');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.restored, 'restored\n');
    assert.equal(result.services, '');
});
for (const [file, marker] of [
    ['scripts/update.sh', '# --- automatic rollback'],
    ['scripts/rollback_pod.sh', '# --- swap back on failure'],
    ['scripts/switch-to-upstream.sh', '# --- automatic rollback'],
]) {
    it(`${file} restarts biometrics from the restored tree after failure`, () => {
        const result = run(section(file, marker));
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.services, /stop free-sleep-stream failed/);
        assert.match(result.services, /(?:start|restart) free-sleep-stream restored/);
    });
}
it('dry-run with clock skew never writes the Pod clock', () => {
    const result = run(section('scripts/migrate/switch-to-this-fork.sh', '# Clock skew.', '# WAN state'));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.ssh, /date -u -s/);
});
for (const [channel, wanted] of [['stable', '3.2.0'], ['beta', '3.3.0'], ['', '3.2.0']]) {
    it(`untargeted update honors ${channel || 'default stable'} channel`, () => {
        // Run the selection block followed by its public resolved target.
        const selected = run(section('scripts/update.sh', '# --- resolve what to install', '# --- download + stage') + '\necho "selected=$EXPECTED_VERSION"', `
TARGET_VERSION=''; CUR_VERSION=3.0.0; RELEASES_URL=fixture; TAG_ZIP_URL_PREFIX=tag-v
SETTINGS_FILE="$FIXTURE/settings.json"
printf '%s' '{"updateChannel":"${channel}"}' > "$SETTINGS_FILE"
open_wan() { :; }
curl() { echo '{"releases":[{"version":"3.3.0","channel":"beta"},{"version":"3.2.0","channel":"stable"}]}'; }
`);
        assert.equal(selected.status, 0, selected.stdout + selected.stderr);
        assert.match(selected.stdout, new RegExp(`selected=${wanted.replaceAll('.', '\\.')}`));
    });
}
for (const [target, allowDowngrade, status] of [['3.0.0', 'no', 1], ['3.0.0', 'yes', 0]]) {
    it(`explicit downgrade requires consent: ${allowDowngrade}`, () => {
        const result = run(section('scripts/update.sh', '# --- resolve what to install', '# --- download + stage') + '\necho "selected=$EXPECTED_VERSION"', `
TARGET_VERSION=${target}; CUR_VERSION=3.2.0; ALLOW_DOWNGRADE=${allowDowngrade}
RELEASES_URL=fixture; TAG_ZIP_URL_PREFIX=tag-v
open_wan() { :; }
curl() { echo '{"releases":[{"version":"3.0.0","channel":"stable"}]}'; }
`);
        assert.equal(result.status, status, result.stdout + result.stderr);
        if (status === 0)
            assert.match(result.stdout, /selected=3.0.0/);
    });
}
it('a missing manifest aborts an untargeted update', () => {
    const result = run(section('scripts/update.sh', '# --- resolve what to install', '# --- download + stage'), `
TARGET_VERSION=''; RELEASES_URL=fixture; SETTINGS_FILE="$FIXTURE/missing.json"
open_wan() { :; }
curl() { return 22; }
`);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not resolve a release/);
});
function runRestore(setup = '') {
    return run(section('scripts/migrate/switch-to-this-fork.sh', '  say "Extracting and restarting..."', '  say "Restore complete.'), `
RESTORE_TARBALL=backup
mkdir -p "$FIXTURE/system" "$FIXTURE/archive/free-sleep/server/"{dist,public,node_modules}
printf restored > "$FIXTURE/archive/free-sleep/version"
touch "$FIXTURE/archive/free-sleep/server/dist/server.js" "$FIXTURE/archive/free-sleep/server/public/index.html"
echo '{"name":"fixture"}' > "$FIXTURE/archive/free-sleep/server/package.json"
echo dependency > "$FIXTURE/archive/free-sleep/server/node_modules/dependency"
tar czf "$FIXTURE/system/free-sleep-restore.tar.gz" -C "$FIXTURE/archive" .
ssh_cmd() { command bash -c "$2"; }
export -f systemctl chown
export LIVE
${setup}
`);
}
it('a corrupt restore archive leaves the live tree running and exits with failure', () => {
    const result = runRestore('echo corrupt > "$FIXTURE/system/free-sleep-restore.tar.gz"');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.liveVersion, 'failed');
    assert.equal(result.services, '');
});
it('a restore archive without installed dependencies leaves the live tree untouched', () => {
    const result = runRestore(`
rm -rf "$FIXTURE/archive/free-sleep/server/node_modules"
tar czf "$FIXTURE/system/free-sleep-restore.tar.gz" -C "$FIXTURE/archive" .
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.liveVersion, 'failed');
    assert.equal(result.services, '');
    assert.match(result.stderr, /Use.*Roll back|supply.*complete backup/i);
});
it('a complete restore archive replaces code and restarts active biometrics', () => {
    const result = runRestore(`
systemctl() {
  if [ "$1" = is-active ]; then echo active; else echo "$* $(cat "$LIVE/version")" >> "$FIXTURE/services"; fi
}
export -f systemctl
`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.liveVersion, 'restored');
    assert.match(result.services, /stop free-sleep-stream failed/);
    assert.match(result.services, /start free-sleep restored/);
    assert.match(result.services, /restart free-sleep-stream restored/);
    assert.match(result.stdout, /[0-9]+[KMGT]?\s+.*\.restore\.[^/]+\/previous/);
    assert.match(result.stdout, /remove.*after|after.*remove/i);
});
it('a restore service start failure is reported as failure', () => {
    const result = runRestore('systemctl() { [ "$1" != start ]; }; export -f systemctl');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /[0-9]+[KMGT]?\s+.*\.restore\.[^/]+\/previous/);
    assert.match(result.stdout, /remove.*after|after.*remove/i);
});
for (const mode of ['previous', 'backup']) {
    it(`ops rollback ${mode} restores the biometrics service with code`, () => {
        const script = section('ops/rollback.sh', 'if [ "${1:-}" = "--from" ]; then', '\nsleep 8');
        const result = run(script, `
BACKUPS="$FIXTURE/backups"; MOVE_TREE=
SSH() { echo "$*" > "$FIXTURE/ssh"; }
${mode === 'backup' ? 'set -- --from fixture' : 'set --'}
`);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.ssh, /stop free-sleep-stream/);
        assert.match(result.ssh, /(?:start|restart) free-sleep-stream/);
    });
}
it('a failed restore remains an explicit failure and keeps the recovery sentinel armed', () => {
    const result = run(section('scripts/migrate/pod-installer.sh', 'restore_and_report() {', '\n# ===') +
        '\nrestore_and_report "migration failed"', `
RESTORE_SCRIPT_DEST=fixture
bash() { return 1; }
write_status() { echo "status: $*"; }
disarm_sentinel() { echo disarmed; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /status: install restore_failed/);
    assert.doesNotMatch(result.stdout, /disarmed/);
});
for (const failedSource of ['LIVE', 'PREV']) {
    it(`rollback recovery restarts the surviving tree when moving ${failedSource} fails`, () => {
        const result = run(section('scripts/rollback_pod.sh', '# --- swap back on failure'), `
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$${failedSource}" ]; then return 1; else command mv "$@"; fi; }
`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'failed');
        assert.equal(result.previousVersion, 'restored');
        assert.match(result.services, /start free-sleep failed/);
        assert.match(result.services, /restart free-sleep-stream failed/);
    });
}
it('rollback recovery reports manual recovery when neither tree can be restored', () => {
    const result = run(section('scripts/rollback_pod.sh', '# --- swap back on failure'), `
mv() { [ "$1" != -T ] || shift; if [ "$2" = "$LIVE" ]; then return 1; else command mv "$@"; fi; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.liveVersion, '');
    assert.doesNotMatch(result.services, /^start free-sleep/m);
    assert.match(result.stdout, /manual recovery required/);
});
it('a failed forward rollback bookkeeping move restores the original tree before exiting', () => {
    const result = run(section('scripts/rollback_pod.sh', '# --- swap', '# --- health check'), `
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$TMP" ] && [ "$2" = "$PREV" ]; then return 1; else command mv "$@"; fi; }
${statefulServices()}
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.liveVersion, 'failed');
    assert.equal(result.previousVersion, 'restored');
    assert.match(result.services, /start free-sleep failed/);
    assert.match(result.services, /restart free-sleep-stream failed/);
});
for (const streamState of ['active', 'inactive']) {
    it(`a successful rollback preserves an ${streamState} biometrics service`, () => {
        const result = run(section('scripts/rollback_pod.sh', '# --- swap', '# --- health check'), `
${statefulServices(streamState === 'active' ? '' : 'free-sleep-stream')}
`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'restored');
        assert.equal(result.previousVersion, 'failed');
        assert.equal(result.services, 'stop free-sleep-stream failed\nstop free-sleep failed\nstart free-sleep restored\n' +
            (streamState === 'active' ? 'restart free-sleep-stream restored\n' : ''));
    });
}
it('original-fork restore preserves the previous tree and sentinel when quarantine fails', () => {
    const result = run(section('scripts/migrate/restore-original-fork.sh', 'say "Swap marker present'), `
ABORTED_QUARANTINE="$FIXTURE/quarantine"; PREEXISTING_PREV="$FIXTURE/preexisting"
SWAP_MARKER="$FIXTURE/marker"; echo armed > "$SWAP_MARKER"
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$LIVE" ]; then return 1; else command mv "$@"; fi; }
restore_iptables() { :; }
write_status() { echo "status: $*"; }
disarm_sentinel() { echo disarmed; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /status: restore_failed/);
    assert.doesNotMatch(result.stdout, /disarmed|auto-restored/);
    assert.equal(result.previousVersion, 'restored');
    assert.equal(result.marker, 'armed\n');
});
it('a failed rollback bookkeeping move still starts the restored install', () => {
    const result = run(section('scripts/rollback_pod.sh', '# --- swap back on failure'), `
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$TMP" ] && [ "$2" = "$PREV" ]; then return 1; else command mv "$@"; fi; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.liveVersion, 'restored');
    assert.match(result.services, /start free-sleep restored/);
    assert.match(result.services, /restart free-sleep-stream restored/);
});
for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
    for (const failedSource of ['LIVE', 'PREV']) {
        it(`${file} restarts the available tree when moving ${failedSource} fails during recovery`, () => {
            const result = run(section(file, '# --- automatic rollback'), `
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$${failedSource}" ]; then return 1; else command mv "$@"; fi; }
`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.equal(result.liveVersion, 'failed');
            assert.equal(result.previousVersion, 'restored');
            assert.match(result.services, /start free-sleep failed/);
            assert.match(result.services, /restart free-sleep-stream failed/);
        });
    }
}
it('an invalid saved update channel fails before opening internet access', () => {
    const result = run(section('scripts/update.sh', '# --- resolve what to install', '# --- download + stage'), `
TARGET_VERSION=''; SETTINGS_FILE="$FIXTURE/settings.json"
echo '{"updateChannel":"invalid"}' > "$SETTINGS_FILE"
open_wan() { echo opened > "$FIXTURE/marker"; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.marker, '');
});
it('an incompatible migration history restores the original with an actionable message', () => {
    const result = run(section('scripts/migrate/pod-installer.sh', 'say "Running prisma', '# --- health check'), `
sudo() { case "$*" in *'migrate status'*) return 1;; *) return 0;; esac; }
restore_and_report() { echo "$*"; echo restored > "$FIXTURE/restored"; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.restored, 'restored\n');
    assert.equal(result.services, '');
    assert.match(result.stdout, /compare.*migration histories/i);
});
it('fork migration backups contain an independently restorable dependency tree', () => {
    const backupScript = section('scripts/migrate/switch-to-this-fork.sh', 'say "Stage 4:', 'say "Pulling the backup');
    const result = run(backupScript + '\ntar tzf "$REMOTE_BACKUP_TARBALL" > "$FIXTURE/marker"', `
mkdir -p "$LIVE/server/node_modules"
echo installed > "$LIVE/server/node_modules/dependency"
ssh_cmd() { command bash -c "$2"; }
`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.marker, /free-sleep\/server\/node_modules\/dependency/);
});
it('a failed rollback bookkeeping move recovers shared dependencies before starting', () => {
    const result = run(section('scripts/rollback_pod.sh', 'fix_shared_node_modules() {', '# --- preflight') +
        section('scripts/rollback_pod.sh', '# --- swap back on failure'), `
mkdir "$LIVE/server/node_modules"
echo same > "$LIVE/server/package-lock.json"
echo same > "$PREV/server/package-lock.json"
mv() { [ "$1" != -T ] || shift; if [ "$1" = "$TMP" ] && [ "$2" = "$PREV" ]; then return 1; else command mv "$@"; fi; }
systemctl() {
  [ "$1" != is-active ] || { echo inactive; return 3; }
  if [ "$1" = start ]; then [ -d "$LIVE/server/node_modules" ] && echo modules > "$FIXTURE/marker"; fi
}
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.marker, 'modules\n');
});
for (const failedMove of ['live', 'replacement']) {
    it(`a restore ${failedMove} move failure restarts the original install`, () => {
        const result = runRestore(`
mv() { [ "$1" != -T ] || shift;
  if ${failedMove === 'live' ? '[ "$1" = "$LIVE" ]' : '[[ "$1" = */free-sleep ]]'}; then return 1; fi
  command mv "$@"
}
export -f mv
`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'failed');
        assert.match(result.services, /start free-sleep failed/);
    });
}
it('a failed archive upload never starts the remote restore', () => {
    const uploadScript = section('scripts/migrate/switch-to-this-fork.sh', '  say "Pushing backup tarball..."', '  say "Extracting and restarting..."');
    const result = run(uploadScript + '\necho continued > "$FIXTURE/marker"', `
RESTORE_TARBALL=backup
scp_to_pod() { return 1; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.marker, '');
    assert.equal(result.liveVersion, 'failed');
});
it('a failed backup copy aborts without reporting a completed archive', () => {
    const backupScript = section('scripts/migrate/switch-to-this-fork.sh', 'say "Stage 4:', 'say "Pulling the backup');
    const result = run(backupScript + '\necho completed > "$FIXTURE/marker"', `
cp() { return 1; }
export -f cp
ssh_cmd() { command bash -c "$2"; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.marker, '');
    assert.equal(result.liveVersion, 'failed');
});
it('a failed SQLite migration backup aborts instead of accepting a code-only archive', () => {
    const backupScript = section('scripts/migrate/switch-to-this-fork.sh', 'say "Stage 4:', 'say "Pulling the backup');
    const result = run(backupScript + '\necho completed > "$FIXTURE/marker"', `
mkdir -p "$FIXTURE/persistent/free-sleep-data/lowdb"
touch "$FIXTURE/persistent/free-sleep-data/free-sleep.db"
sqlite3() { return 1; }
export -f sqlite3
ssh_cmd() { command bash -c "$2"; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.marker, '');
});
for (const hasIonice of [false, true]) {
    it(`migration backup lowers copy and archive priority with ionice ${hasIonice ? 'available' : 'absent'}`, () => {
        const result = run(section('scripts/migrate/switch-to-this-fork.sh', 'say "Stage 4:', 'say "Pulling the backup'), `
mkdir -p "$FIXTURE/persistent/free-sleep-data/lowdb"
ssh_cmd() { command bash -c "$2"; }
nice() { [ "$1 $2" = '-n 19' ] || return 1; shift 2; LOW_CPU=yes "$@"; }
cp() { [ "\${LOW_CPU:-}" = yes ] || return 1; ${hasIonice ? '[ "${LOW_IO:-}" = yes ] || return 1;' : ''} command cp "$@"; }
tar() { [ "\${LOW_CPU:-}" = yes ] || return 1; ${hasIonice ? '[ "${LOW_IO:-}" = yes ] || return 1;' : ''} command tar "$@"; }
${hasIonice
            ? 'ionice() { [ "$1 $2 $3 $4" = "-c 2 -n 7" ] || return 1; shift 4; LOW_IO=yes "$@"; }; export -f ionice'
            : 'command() { if [ "${1:-} ${2:-}" = "-v ionice" ]; then return 1; fi; builtin command "$@"; }; export -f command'}
export -f nice cp tar
`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'failed');
    });
}
for (const outcome of ['success', 'restored', 'failed', 'restore_failed']) {
    it(`migration archive retention keeps two recovery archives after ${outcome}`, () => {
        const result = run(section('scripts/migrate/switch-to-this-fork.sh', 'say "Installer started.'), `
POD_IP=fixture; REMOTE_BACKUP_DIR="$FIXTURE/backups"; REMOTE_BACKUP_TARBALL=remote; LOCAL_BACKUP_TARBALL=local
mkdir -p "$REMOTE_BACKUP_DIR"
for number in 1 2 3 4; do touch -t "20260101000$number" "$REMOTE_BACKUP_DIR/migrate-$number.tar.gz"; done
touch "$REMOTE_BACKUP_DIR/keep.tar.gz"
ssh_cmd() {
  case "$2" in *migration-status.json*) echo '{"outcome":"${outcome}","stage":"done"}';;
    *) command bash -c "$2";;
  esac
}
trap 'ls "$REMOTE_BACKUP_DIR" > "$FIXTURE/marker"' EXIT
`);
        assert.equal(result.status, outcome === 'success' ? 0 : 1, result.stdout + result.stderr);
        assert.equal(result.marker, 'keep.tar.gz\nmigrate-3.tar.gz\nmigrate-4.tar.gz\n');
    });
}
it('an untargeted update refuses an archive labeled with a different version', () => {
    const result = run(section('scripts/update.sh', '# the pod runs prebuilt code', '# --- dependencies'), `
STAGE="$FIXTURE/stage"; TARGET_VERSION=''; EXPECTED_VERSION=3.2.0
mkdir -p "$STAGE/server/"{src,dist,public}
touch "$STAGE/server/dist/server.js" "$STAGE/server/public/index.html"
echo '{"version":"3.1.0"}' > "$STAGE/server/src/serverInfo.json"
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /but releases.json lists v3.2.0.*mislabeled release/);
    assert.equal(result.liveVersion, 'failed');
    assert.equal(result.services, '');
});
for (const { failedSources, expectedVersion } of [
    { failedSources: ['LIVE'], expectedVersion: 'failed' },
    { failedSources: ['PREV'], expectedVersion: 'failed' },
    { failedSources: ['TMP'], expectedVersion: 'restored' },
    { failedSources: ['TMP', 'LIVE'], expectedVersion: 'restored' },
    { failedSources: ['TMP', 'PREV'], expectedVersion: '' },
]) {
    it(`forward rollback preserves a tree when moves from ${failedSources.join(', ')} fail`, () => {
        const result = run(section('scripts/rollback_pod.sh', '# --- swap', '# --- health check'), `
moves=0
mv() { [ "$1" != -T ] || shift;
  moves=$((moves + 1))
  if [ "$moves" -ge ${failedSources[0] === 'TMP' ? 3 : 1} ]; then
    case "$1" in ${failedSources.map(source => `"$${source}"`).join('|')}) return 1;; esac
  fi
  command mv "$@"
}
${statefulServices()}
`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion, expectedVersion);
        if (!expectedVersion) {
            assert.doesNotMatch(result.services, /^start free-sleep/m);
            assert.match(result.stdout, /manual recovery required/);
        }
        else {
            assert.match(result.services, new RegExp(`start free-sleep ${result.liveVersion}`));
            assert.match(result.services, new RegExp(`restart free-sleep-stream ${result.liveVersion}`));
        }
    });
}
const prepareToStop = (reason) => 'curl -fsS --max-time 60 -X POST -H content-type: application/json '
    + `-d {"reason":"${reason}"} http://127.0.0.1:3000/api/update/prepare-to-stop`;
const recordCurl = (status) => `curl() { echo "curl $*" >> "$FIXTURE/services"; return ${status}; }`;
for (const [file, from, to, reason, setup] of [
    ['scripts/update.sh', '# --- atomic swap', 'rm -rf "$PREV"', 'downgrade', 'IS_DOWNGRADE=yes; STAGED_VERSION=3.0.0; STAGE="$FIXTURE/stage"'],
    ['scripts/rollback_pod.sh', '# --- swap', 'rm -rf "$TMP"', 'rollback', ''],
    ['scripts/switch-to-upstream.sh', '# --- atomic swap', 'ARCHIVE_WAS_ACTIVE=', 'revert', 'STAGED_VERSION=1.0.0; STAGE="$FIXTURE/stage"'],
]) {
    for (const status of [0, 7]) {
        it(`${file} lets the server prepare just before it stops${status ? ', even when that fails' : ''}`, () => {
            const result = run(section(file, from, to), `${setup}\n${recordCurl(status)}`);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const calls = result.services.trim().split('\n');
            const prepared = calls.indexOf(prepareToStop(reason));
            assert.ok(prepared >= 0, result.services);
            assert.ok(prepared < calls.findIndex(line => line.startsWith('stop free-sleep ')), result.services);
            assert.ok(calls.some(line => line.startsWith('stop free-sleep ')), result.services);
            if (status)
                assert.match(result.stdout, /WARNING: the server could not prepare to stop; continuing/);
        });
    }
}
it('scripts/update.sh leaves the server alone before an upgrade', () => {
    const result = run(section('scripts/update.sh', '# --- atomic swap', 'rm -rf "$PREV"'), `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; STAGE="$FIXTURE/stage"\n${recordCurl(0)}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.services, /prepare-to-stop/);
    assert.match(result.services, /^stop free-sleep /m);
});
// The target's own server continues what this one would hand back.
const withRoute = (tree) => `mkdir -p "${tree}/server/dist/routes/update"
echo "router.post('/prepare-to-stop', handler);" > "${tree}/server/dist/routes/update/update.js"`;
const withLedger = (tree) => `mkdir -p "${tree}/server/dist/jobs" && touch "${tree}/server/dist/jobs/alarmLedger.js"`;
for (const [file, from, to, reason, setup, tree] of [
    [
        'scripts/update.sh', '# --- atomic swap', 'rm -rf "$PREV"', 'downgrade',
        'IS_DOWNGRADE=yes; STAGED_VERSION=3.0.0; STAGE="$FIXTURE/stage"', '$STAGE',
    ],
    ['scripts/rollback_pod.sh', '# --- swap', 'rm -rf "$TMP"', 'rollback', '', '$PREV'],
]) {
    it(`${file} leaves the server alone when the target has the same prepare-to-stop route and alarm record`, () => {
        const result = run(section(file, from, to), `${setup}\n${withRoute(tree)}\n${withLedger(tree)}\n${recordCurl(0)}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.services, /prepare-to-stop/);
        assert.match(result.services, /^stop free-sleep /m);
    });
    it(`${file} keeps Rhythms but lets the server forget its alarms when the target keeps no alarm record`, () => {
        // Such a target rings the alarms without saving that they rang.
        const result = run(section(file, from, to), `${setup}\n${withRoute(tree)}\n${recordCurl(0)}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const calls = result.services.trim().split('\n');
        const prepared = calls.indexOf('curl -fsS --max-time 60 -X POST -H content-type: application/json '
            + `-d {"reason":"${reason}","handBack":false} http://127.0.0.1:3000/api/update/prepare-to-stop`);
        assert.ok(prepared >= 0, result.services);
        assert.ok(prepared < calls.findIndex(line => line.startsWith('stop free-sleep ')), result.services);
    });
}
const termAfterMovingLive = 'mv() { [ "$1" != -T ] || shift; command mv "$@" || return; [ "$1" != "$LIVE" ] || kill -TERM $$; }';
// The script's own exit handling around one of its swaps.
function withExitHandling(file, swap) {
    const end = file === 'scripts/rollback_pod.sh' ? '\n# --- preflight' : '\nfail() {';
    const traps = file === 'scripts/rollback_pod.sh' ? "trap 'status=$?" : 'trap cleanup EXIT';
    return `${section(file, 'finish_interrupted_swap() {', end)}\n${section(file, traps, '\n\n')}\n${swap}`;
}
// Inline python runs; helper scripts given by path do not.
const stubs = [
    'close_wan() { :; }',
    'record_result() { printf "%s" "${RESULT_REASON:-}" > "$FIXTURE/marker"; printf "%s" "${RESULT_PHASE:-}" > "$FIXTURE/phase"; }',
    'python3() { case "$1" in -I|-c) command python3 "$@";; esac; }', 'ZIP="$FIXTURE/zip"; STAGE="$FIXTURE/stage"',
].join('\n');
const staged = 'STAGE="$FIXTURE/stage"; mkdir -p "$STAGE/server"; echo staged > "$STAGE/version"';
for (const [file, from, to, setup, liveAfterMove] of [
    ['scripts/update.sh', '# --- atomic swap', 'MOVED_MODULES=no', `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; ${staged}`, 'failed'],
    ['scripts/update.sh', '# --- automatic rollback', '', 'RESULT_PHASE=swapped', 'restored'],
    ['scripts/rollback_pod.sh', '# --- swap', '# --- health check', '', 'failed'],
    ['scripts/rollback_pod.sh', '# --- swap back on failure', '', '', 'restored'],
    ['scripts/switch-to-upstream.sh', '# --- atomic swap', 'MOVED_MODULES=no',
        `RESULT_PHASE=preflight; STAGED_VERSION=1.0.0; BK="$FIXTURE/bk"; mkdir -p "$BK/lowdb"
restore_switch_data() { DATA_CHANGED=no; }; ${staged}`, 'failed'],
    ['scripts/switch-to-upstream.sh', '# --- automatic rollback', '', 'RESULT_PHASE=swapped', 'restored'],
]) {
    const swap = section(file, from, to || undefined);
    // update.sh's rollback puts the previous tree back once the writers stop.
    const liveAfterStop = file === 'scripts/update.sh' && from === '# --- automatic rollback' ? 'restored' : 'failed';
    for (const [phase, interrupt, liveVersion] of [
        ['while stopping the server', 'TERM_ON="stop free-sleep"', liveAfterStop],
        ['after moving the live tree', termAfterMovingLive, liveAfterMove],
    ]) {
        it(`${file} (${from}) interrupted ${phase} leaves a live tree and its services running`, () => {
            const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices()}\n${setup}\n${interrupt}`);
            assert.equal(result.status, 143, result.stdout + result.stderr);
            assert.equal(result.liveVersion, liveVersion, result.stdout + result.stderr);
            assert.equal(result.serverState, 'active', result.services);
            assert.equal(result.streamState, 'active', result.services);
            // Nothing changed when the forward swap is undone; the swap back is a restore.
            if (from === '# --- atomic swap')
                assert.equal(result.phase, 'preflight', result.stdout + result.stderr);
            else if (phase !== 'while stopping the server' && file !== 'scripts/rollback_pod.sh') {
                assert.equal(result.phase, 'restored', result.stdout + result.stderr);
            }
        });
    }
    if (from === '# --- atomic swap' && file !== 'scripts/rollback_pod.sh') {
        // With an unchanged lockfile the new tree has no node_modules until after
        // the swap, so the previous tree, with its own, must be the one started.
        it(`${file} interrupted right after moving the new tree in starts the previous one`, () => {
            const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices()}\n${setup}
LOCK_SAME=yes; mkdir -p "$LIVE/server/node_modules"
mv() { [ "$1" != -T ] || shift; command mv "$@" || return; [ "$1 $2" != "$STAGE $LIVE" ] || kill -TERM $$; }`);
            assert.equal(result.status, 143, result.stdout + result.stderr);
            assert.equal(result.liveVersion, 'failed', result.stdout + result.stderr);
            assert.equal(result.serverState, 'active', result.services);
            assert.equal(result.streamState, 'active', result.services);
            assert.match(result.services, /^start free-sleep failed$/m);
            assert.equal(result.phase, 'preflight');
        });
    }
}
// These swaps stop short of the health check. Past it, the previous tree no
// longer goes back when the run ends.
const passed = (file) => (file === 'scripts/rollback_pod.sh' ? '' : '\nRESTORE_TREE=\nSWAP_NEW=');
// Every writer must be stopped, or confirmed absent, before a tree moves.
for (const [file, from, to, setup] of [
    ['scripts/update.sh', '# --- atomic swap', 'MOVED_MODULES=no', `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; ${staged}`],
    ['scripts/rollback_pod.sh', '# --- swap', '# --- health check', ''],
    ['scripts/switch-to-upstream.sh', '# --- atomic swap', 'MOVED_MODULES=no',
        `STAGED_VERSION=1.0.0; BK="$FIXTURE/bk"; mkdir -p "$BK/lowdb"; ${staged}`],
]) {
    const swap = `${section(file, from, to)}${passed(file)}`;
    for (const failure of ['STOP_FAILS=free-sleep', 'STAYS_ACTIVE=free-sleep', 'DEACTIVATING=free-sleep',
        'STOP_FAILS=free-sleep-stream', 'STAYS_ACTIVE=free-sleep-stream']) {
        it(`${file} changes nothing and restarts the services when ${failure}`, () => {
            const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices()}\n${setup}\n${failure}`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.equal(result.liveVersion, 'failed', result.stdout);
            assert.equal(result.previousVersion, 'restored', result.stdout);
            assert.match(result.stdout, file === 'scripts/switch-to-upstream.sh'
                ? /could not stop the server before converting settings/
                : /could not stop the running services; live install untouched/);
            assert.equal(result.serverState, 'active', result.services);
            assert.equal(result.streamState, 'active', result.services);
        });
    }
    if (file === 'scripts/rollback_pod.sh') {
        // A rollback to another fork stops the archive timer before this point.
        it(`${file} starts the archive timer again when the server does not stop`, () => {
            const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices()}
ARCHIVE_WAS_ACTIVE=active; mkdir -p "$LIVE/scripts"; touch "$LIVE/scripts/archive-raw.sh"
STOP_FAILS=free-sleep`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.services, /^start free-sleep-archive-raw\.timer /m);
        });
    }
    // systemd refuses to stop a unit that does not load, even one already stopped.
    it(`${file} goes on when a stream unit that does not load is already stopped`, () => {
        const stopped = `${stubs}\n${statefulServices('free-sleep-stream')}\n${setup}\nSTOP_FAILS=free-sleep-stream`;
        const result = run(withExitHandling(file, swap), stopped);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.notEqual(result.liveVersion, 'failed', result.stdout);
    });
    it(`${file} goes on when the biometrics stream is not installed`, () => {
        const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices('free-sleep-stream')}\n${setup}\nMISSING=free-sleep-stream`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.notEqual(result.liveVersion, 'failed', result.stdout);
    });
}
// The stream started while the server stopped is stopped again before any
// tree moves, and runs again once the swap is done.
const streamAtMove = 'mv() { [ "$1" != -T ] || shift; cat "$FIXTURE/state-free-sleep-stream" >> "$FIXTURE/ssh"; command mv "$@"; }';
for (const [file, from, to, setup] of [
    ['scripts/update.sh', '# --- atomic swap', 'MOVED_MODULES=no', `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; ${staged}`],
    ['scripts/rollback_pod.sh', '# --- swap', '# --- health check', ''],
    ['scripts/switch-to-upstream.sh', '# --- atomic swap', 'MOVED_MODULES=no',
        `STAGED_VERSION=1.0.0; BK="$FIXTURE/bk"; mkdir -p "$BK/lowdb"; ${staged}`],
]) {
    const swap = `${section(file, from, to)}${passed(file)}\necho "$STREAM_WAS_ACTIVE" > "$FIXTURE/restored"`;
    it(`${file} stops a stream the server started while it stopped, before the swap`, () => {
        const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices('free-sleep-stream')}\n${setup}\nSTREAM_ON="stop free-sleep"\n${streamAtMove}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.notEqual(result.liveVersion, 'failed', result.stdout);
        assert.ok(result.ssh.length > 0, 'trees moved');
        assert.deepEqual([...new Set(result.ssh.trim().split('\n'))], ['inactive'], 'no tree moves under the stream');
        const calls = result.services.trim().split('\n');
        assert.ok(calls.lastIndexOf('stop free-sleep-stream failed') > calls.indexOf('stop free-sleep failed'), result.services);
        assert.equal(result.restored.trim(), 'active', 'the stream runs again after the swap');
    });
    it(`${file} changes nothing when a stream the server started will not stop`, () => {
        const result = run(withExitHandling(file, swap), `${stubs}\n${statefulServices('free-sleep-stream')}\n${setup}\nSTREAM_ON="stop free-sleep"\nSTAYS_ACTIVE=free-sleep-stream`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'failed', result.stdout);
        assert.equal(result.previousVersion, 'restored', result.stdout);
        assert.equal(result.serverState, 'active', result.services);
        assert.equal(result.streamState, 'active', result.services);
    });
}
// A recovery swap moves nothing, and puts no settings back, under a writer
// that does not stop. The version that failed keeps running.
const revertSettings = `${section('scripts/switch-to-upstream.sh', 'restore_switch_data() {', '\n# While downloading')}`;
const switchedSettings = `DATA_CHANGED=yes; RESTORE_ATTEMPTED=no; ARCHIVE_WAS_ACTIVE=inactive; BK="$FIXTURE/bk"
mkdir -p "$BK/lowdb"; echo original > "$BK/lowdb/settingsDB.json"; echo original > "$BK/lowdb/schedulesDB.json"`;
const recordMoves = 'mv() { [ "$1" != -T ] || shift; echo "mv $*" >> "$FIXTURE/ssh"; command mv "$@"; }';
for (const [file, marker] of [
    ['scripts/update.sh', '# --- automatic rollback'],
    ['scripts/rollback_pod.sh', '# --- swap back on failure'],
    ['scripts/switch-to-upstream.sh', '# --- automatic rollback'],
]) {
    const revert = file === 'scripts/switch-to-upstream.sh';
    const recovery = `${revert ? `${revertSettings}\necho converted > /persistent/free-sleep-data/lowdb/settingsDB.json\n` : ''}`
        + withExitHandling(file, section(file, marker));
    const setup = `${stubs}\n${statefulServices()}\nRESULT_PHASE=swapped\n${revert ? switchedSettings : ''}
mkdir -p "$FAILED" "$TMP"; echo earlier > "$FAILED/version"; echo earlier > "$TMP/version"\n${recordMoves}`;
    for (const failure of ['STOP_FAILS=free-sleep', 'STAYS_ACTIVE=free-sleep', 'DEACTIVATING=free-sleep',
        'STOP_FAILS=free-sleep-stream', 'STAYS_ACTIVE=free-sleep-stream', 'DEACTIVATING=free-sleep-stream']) {
        it(`${file} keeps the failed version and both trees when ${failure} during recovery`, () => {
            const result = run(recovery, `${setup}\n${failure}`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.equal(result.ssh, '', 'no tree moved');
            assert.equal(result.liveVersion, 'failed', result.stdout);
            assert.equal(result.previousVersion, 'restored', result.stdout);
            assert.equal(result.failedVersion, 'earlier\n');
            assert.equal(result.tmpVersion, 'earlier\n');
            assert.equal(result.serverState, 'active', result.services);
            assert.equal(result.streamState, 'active', result.services);
            assert.doesNotMatch(result.services, / restored$/m, 'nothing ran from the previous tree');
            assert.equal(result.phase, 'swapped', 'recorded as failed');
            assert.match(result.stdout, /a service did not stop, so .* was not put back/);
            if (revert)
                assert.equal(result.settings, 'converted\n', 'settings left to the running version');
        });
    }
    it(`${file} recovers as before once both writers stop`, () => {
        const result = run(recovery, setup);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion, 'restored', result.stdout);
        assert.match(result.services, /^start free-sleep restored$/m);
        if (revert)
            assert.equal(result.settings, 'original\n');
    });
}
it('switch-to-upstream.sh puts no settings back while a writer still runs', () => {
    for (const [states, settings] of [['active active', 'converted\n'], ['inactive active', 'converted\n'],
        ['inactive inactive', 'original\n']]) {
        const result = run(`${revertSettings}\necho converted > /persistent/free-sleep-data/lowdb/settingsDB.json
restore_switch_data || echo refused`, `${statefulServices()}\n${switchedSettings}
read -r server stream <<< "${states}"; echo "$server" > "$FIXTURE/state-free-sleep"; echo "$stream" > "$FIXTURE/state-free-sleep-stream"`);
        assert.equal(result.settings, settings, `${states}: ${result.stdout}`);
        assert.equal(/refused/.test(result.stdout), settings === 'converted\n', result.stdout);
    }
});
// The bed-in-use helpers the three operations share from restore_helpers.sh.
function inUseHelpers() {
    const src = readFileSync(path.join(root, 'scripts/restore_helpers.sh'), 'utf8');
    const start = src.indexOf('# Bed-in-use helpers');
    assert.ok(start >= 0, 'restore_helpers.sh has no bed-in-use helpers');
    const last = src.indexOf('recheck_in_use() {', start);
    return src.slice(start, src.indexOf('\n}\n', last) + 3);
}
for (const [request, recheck] of [
    [null, 'no'],
    ['{"source":"app","confirmInUse":false}', 'yes'],
    ['{"source":"app","confirmInUse":true}', 'no'],
    ['{"source":"app"}', 'no'],
    ['{"confirmInUse":false}', 'no'],
    ['{not json', 'no'],
]) {
    it(`a request of ${request ?? 'none'} is checked again: ${recheck}`, () => {
        const result = run(`${inUseHelpers()}
read_request
echo "recheck=$RECHECK_IN_USE"
if [ -e "$REQUEST_FILE" ]; then echo kept; fi`, request === null ? '' : `mkdir -p "$FIXTURE/persistent/free-sleep-data"
printf '%s' '${request}' > "$FIXTURE/persistent/free-sleep-data/operation-request.json"`);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`recheck=${recheck}`));
        assert.doesNotMatch(result.stdout, /kept/);
    });
}
it('a request left from a run that never started is not checked again', () => {
    const result = run(`${inUseHelpers()}
read_request
echo "recheck=$RECHECK_IN_USE"`, `mkdir -p "$FIXTURE/persistent/free-sleep-data"
printf '%s' '{"source":"app","confirmInUse":false}' > "$FIXTURE/persistent/free-sleep-data/operation-request.json"
touch -t 202001010000 "$FIXTURE/persistent/free-sleep-data/operation-request.json"`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /recheck=no/);
});
const IN_USE_REASON = 'the bed came into use while it was getting ready';
for (const [file, from, to, setup] of [
    ['scripts/update.sh', '# --- atomic swap', 'MOVED_MODULES=no', `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; ${staged}`],
    // A rollback to another fork stops the archive timer first, so it is checked before that.
    ['scripts/rollback_pod.sh', '# Before the archive timer below stops', '# --- health check', 'ARCHIVE_WAS_ACTIVE=active'],
    ['scripts/switch-to-upstream.sh', '# --- atomic swap', 'MOVED_MODULES=no',
        `STAGED_VERSION=1.0.0; BK="$FIXTURE/bk"; mkdir -p "$BK/lowdb"; ${staged}`],
]) {
    const script = (recheck) => `${inUseHelpers()}\nRECHECK_IN_USE=${recheck}\n${withExitHandling(file, section(file, from, to))}`;
    const answer = (body, status = 0) => `curl() { echo "curl $*" >> "$FIXTURE/services"; case "$*" in *in-use*) printf '%s' '${body}'; return ${status};; esac; }`;
    for (const [what, curl] of [
        ['a side came on', answer('{"reasons":["left-on"]}')],
        ['an alarm became due', answer('{"reasons":["alarm-soon"]}')],
        ['the bed cannot be read', answer('', 7)],
        ['the answer is not readable', answer('<html>')],
    ]) {
        it(`${file} stops before any service when ${what} since an unconfirmed request`, () => {
            const result = run(script('yes'), `${stubs}\n${statefulServices()}\n${setup}\n${curl}`);
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.doesNotMatch(result.services, /^stop |prepare-to-stop/m);
            assert.equal(result.liveVersion, 'failed');
            assert.match(result.stdout, /the bed may be in use/);
            assert.equal(result.marker, IN_USE_REASON);
            assert.equal(result.serverState, 'active');
        });
    }
    it(`${file} goes on when the bed is still idle`, () => {
        const result = run(script('yes'), `${stubs}\n${statefulServices()}\n${setup}\n${answer('{"reasons":[]}')}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.services, /in-use/);
        assert.match(result.services, /^stop free-sleep /m);
    });
    it(`${file} does not ask again for a confirmed request or one from outside the app`, () => {
        const result = run(script('no'), `${stubs}\n${statefulServices()}\n${setup}\n${answer('{"reasons":["left-on"]}')}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.services, /in-use/);
        assert.match(result.services, /^stop free-sleep /m);
    });
}
it('update.sh carries the request across the handoff, and an older updater means no check', () => {
    const src = readFileSync(path.join(root, 'scripts/update.sh'), 'utf8');
    const handoff = src.slice(src.indexOf('if [ "$HANDOFF" = 1 ]; then'), src.indexOf('else', src.indexOf('if [ "$HANDOFF" = 1 ]; then')));
    assert.match(handoff, /RECHECK_IN_USE="\$\{NIGHTSTAND_HANDOFF_RECHECK_IN_USE:-no\}"/);
    assert.match(src, /export NIGHTSTAND_HANDOFF_RECHECK_IN_USE="\$RECHECK_IN_USE"\n\s*exec bash "\$NEW_COPY\/scripts\/update\.sh"/);
    const consume = src.slice(src.indexOf('# --- consume the target-version request file'), src.indexOf('# --- preflight'));
    assert.match(consume, /^read_request$/m);
});
it('rollback and switch read the request before anything else', () => {
    for (const file of ['scripts/rollback_pod.sh', 'scripts/switch-to-upstream.sh']) {
        const src = readFileSync(path.join(root, file), 'utf8');
        const read = src.search(/^read_request$/m);
        assert.ok(read > 0 && read < src.indexOf('# --- preflight'), file);
    }
});
// From the swap through the new version's health check, the previous tree
// waits at PREV. A run that ends anywhere in there puts it back, with the
// dependencies it lent the new tree, and starts it again.
const systemFiles = (script) => script.replaceAll('/etc/systemd/system/', '$FIXTURE/etc/');
const answering = (version, temperature = '80') => `curl() {
  local out=/dev/null
  while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
  if [ "$out" != /dev/null ] && [ -n "\${TERM_ON_HEALTH:-}" ]; then kill -TERM $$; fi
  printf '%s' '{"freeSleep":{"version":"${version}"},"left":{"currentTemperatureF":${temperature}}}' > "$out"; printf 200
}`;
// The new version never answers; the restored one does.
const notAnswering = 'curl() { case "$*" in *" -o /dev/null "*) printf 200;; *) printf 503;; esac; }';
const lentModules = 'LOCK_SAME=yes; mkdir -p "$LIVE/server/node_modules" "$FIXTURE/etc"; echo deps > "$LIVE/server/node_modules/marker"';
const pendingMigrations = `sudo() {
  echo "sudo $*" >> "$FIXTURE/services"
  case "$*" in
    *"migrate deploy"*) if [ -n "\${TERM_ON_DEPLOY:-}" ]; then kill -TERM $$; return 1; fi; touch "$FIXTURE/migrated";;
    *"migrate status"*) [ -f "$FIXTURE/migrated" ];;
  esac
}`;
// Runs a hook just before the given systemctl call when the live tree is the given one.
const onSystemctl = (call, tree, hook) => `eval "orig_$(declare -f systemctl)"
systemctl() { [ "$* $(cat "$LIVE/version" 2>/dev/null)" != "${call} ${tree}" ] || ${hook}; orig_systemctl "$@"; }`;
const settingsFile = '"$FIXTURE/persistent/free-sleep-data/lowdb/settingsDB.json"';
const switchSettings = `DATA_CHANGED=no; RESTORE_ATTEMPTED=no; ARCHIVE_WAS_ACTIVE=inactive
echo original > ${settingsFile}; echo original > "$FIXTURE/persistent/free-sleep-data/lowdb/schedulesDB.json"
python3() { case "$1" in -I|-c) command python3 "$@";; *prepare-upstream.py) echo converted > "$2/settingsDB.json";; esac; }
eval "inner_$(declare -f systemctl)"
systemctl() { [ "$*" != "start free-sleep" ] || echo "start on $(cat ${settingsFile})" >> "$FIXTURE/ssh"; inner_systemctl "$@"; }`;
for (const [file, staging, healthyVersion] of [
    ['scripts/update.sh', `IS_DOWNGRADE=no; STAGED_VERSION=3.2.0; ${staged}\n${pendingMigrations}`, '3.2.0'],
    ['scripts/switch-to-upstream.sh', `RESULT_PHASE=preflight; STAGED_VERSION=1.0.0; BK="$FIXTURE/bk"; mkdir -p "$BK/lowdb"; ${staged}
${switchSettings}`, '1.0.0'],
]) {
    const revert = file === 'scripts/switch-to-upstream.sh';
    const script = `${revert ? `${revertSettings}\n` : ''}${withExitHandling(file, systemFiles(section(file, '# --- atomic swap')))}`;
    const setup = (extra) => `${stubs}\n${statefulServices()}\n${lentModules}\nfw4() { :; }; fw6() { :; }; sh() { :; }\n${staging}\n${extra}`;
    const interruptions = [
        ['after the dependencies move',
            'mv() { [ "$1" != -T ] || shift; command mv "$@" || return; [ "$1" != "$PREV/server/node_modules" ] || kill -TERM $$; }'],
        ['after the new server starts', `TERM_ON="start free-sleep"\n${answering(healthyVersion)}`],
        ['during the health check', `TERM_ON_HEALTH=1\n${answering(healthyVersion)}`],
    ];
    if (!revert)
        interruptions.splice(1, 0, ['in the middle of the migration', 'TERM_ON_DEPLOY=1']);
    for (const [when, interrupt] of interruptions) {
        it(`${file} interrupted ${when} puts the previous tree back and starts it`, () => {
            const result = run(script, setup(interrupt));
            assert.equal(result.status, 143, result.stdout + result.stderr);
            assert.equal(result.liveVersion.trim(), 'failed', result.stdout + result.stderr);
            assert.equal(result.modules, 'deps\n', result.stdout);
            assert.equal(result.serverState, 'active', result.services);
            assert.equal(result.streamState, 'active', result.services);
            const starts = result.services.split('\n').filter(line => /^start free-sleep /.test(line));
            assert.equal(starts.at(-1), 'start free-sleep failed', result.services);
            assert.equal(result.phase, 'restored', result.stdout);
            if (revert)
                assert.equal(result.ssh.trim().split('\n').at(-1), 'start on original', result.ssh);
        });
    }
    it(`${file} keeps the new version running when its server will not stop after an interruption`, () => {
        const result = run(script, setup(`${answering(healthyVersion)}
${onSystemctl('start free-sleep', 'staged', 'STAYS_ACTIVE=free-sleep')}
TERM_ON_HEALTH=1`));
        assert.equal(result.status, 143, result.stdout + result.stderr);
        assert.equal(result.liveVersion.trim(), 'staged');
        assert.equal(result.previousVersion.trim(), 'failed');
        assert.equal(result.serverState, 'active', result.services);
        assert.match(result.stdout, /did not stop, so .* was not put back/);
        assert.equal(result.phase, 'swapped');
        if (revert)
            assert.equal(result.settings, 'converted\n', 'settings left to the running version');
    });
    it(`${file} interrupted while rolling back after a failed health check still puts the previous tree back`, () => {
        const result = run(script, setup(`${notAnswering}\n${onSystemctl('stop free-sleep', 'staged', 'TERM_ON="stop free-sleep"')}`));
        assert.equal(result.status, 143, result.stdout + result.stderr);
        assert.equal(result.liveVersion.trim(), 'failed', result.stdout);
        assert.equal(result.modules, 'deps\n', result.stdout);
        assert.equal(result.serverState, 'active', result.services);
        assert.equal(result.phase, 'restored');
    });
    it(`${file} rolls back as before when the new version fails its health check`, () => {
        const result = run(script, setup(notAnswering));
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(result.liveVersion.trim(), 'failed', result.stdout);
        assert.equal(result.failedVersion.trim(), 'staged', result.stdout);
        assert.equal(result.modules, 'deps\n', result.stdout);
        assert.match(result.stdout, /rollback OK/);
        assert.equal(result.phase, 'restored');
        if (revert)
            assert.equal(result.settings, 'original\n');
    });
    if (!revert) {
        it(`${file} still needs a sensor reading from the new version`, () => {
            const result = run(script, setup(answering(healthyVersion, 'null')));
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.equal(result.liveVersion.trim(), 'failed', result.stdout);
            assert.equal(result.failedVersion.trim(), 'staged', result.stdout);
        });
        // A healthy version whose firewall cannot be applied is rolled back too.
        for (const [family, tool] of [['IPv4', 'fw4'], ['IPv6', 'fw6']]) {
            it(`${file} interrupted while rolling back after a failed ${family} firewall still puts the previous tree back`, () => {
                const result = run(script, setup(`${answering(healthyVersion)}\n${tool}() { return 1; }
${onSystemctl('stop free-sleep', 'staged', 'TERM_ON="stop free-sleep"')}`));
                assert.equal(result.status, 143, result.stdout + result.stderr);
                assert.match(result.stdout, /New firewall could not be applied/);
                assert.equal(result.liveVersion.trim(), 'failed', result.stdout);
                assert.equal(result.modules, 'deps\n', result.stdout);
                assert.equal(result.serverState, 'active', result.services);
                assert.equal(result.phase, 'restored');
            });
        }
    }
    it(`${file} keeps the new version once it passes its health check`, () => {
        const result = run(script, setup(answering(healthyVersion)));
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.liveVersion.trim(), 'staged', result.stdout);
        assert.equal(result.previousVersion.trim(), 'failed', result.stdout);
        assert.equal(result.modules, 'deps\n', result.stdout);
        assert.equal(result.serverState, 'active', result.services);
        assert.doesNotMatch(result.services, /^stop free-sleep staged$/m);
        assert.match(result.stdout, /SUCCESS: pod is serving/);
        if (revert)
            assert.equal(result.settings, 'converted\n');
    });
}
// The updater's own check still needs a sensor reading, and a mistyped
// requirement fails rather than quietly checking less.
it('update.sh checks the new version with a sensor reading', () => {
    const src = readFileSync(path.join(root, 'scripts/update.sh'), 'utf8');
    const calls = src.match(/^.*\bserves_version "[^\n]*$/gm) ?? [];
    assert.deepEqual(calls, ['if [ "$MIGRATION_FAILED" != yes ] && serves_version "$STAGED_VERSION" temperature; then']);
});
it('serves_version refuses a requirement it does not know', () => {
    const fn = section('scripts/update.sh', 'serves_version() {', '\nsay "Health check (up to 90s)"');
    for (const [requirement, status] of [['temperatures', 2], ['Temperature', 2], ['temperature', 0], ['', 0]]) {
        const result = run(`${fn}\nHBODY="$FIXTURE/health"; serves_version 3.2.0 '${requirement}'`, `${statefulServices()}
curl() { printf '%s' '{"freeSleep":{"version":"3.2.0"},"left":{"currentTemperatureF":80}}' > "$FIXTURE/health"; printf 200; }`);
        assert.equal(result.status, status, `${requirement}: ${result.stdout}${result.stderr}`);
    }
});
it('refuses cross-fork rollback without companion state before executing a transaction', () => {
    const helper = section('scripts/restore_helpers.sh', 'restore_cross_fork_rollback() {');
    for (const available of [false, true]) {
        const result = run(helper + '\nrestore_cross_fork_rollback\n', `
touch "$NIGHTSTAND_SCRIPTS/switch_installation.py"
python3() {
  printf '%s\\n' "$*" >> "$FIXTURE/marker"
  if [ "$3" = companion ]; then return ${available ? 0 : 1}; fi
  [ "$3" = rollback ]
}
`);
        assert.equal(result.status, available ? 0 : 1, result.stderr);
        assert.equal(result.marker.includes('rollback --stage'), available);
        assert.match(result.marker, /companion --stage/);
    }
});
// The server user owns /home/dac, so it can put a symlink back at a name root
// has just removed. Each move refuses it: nothing lands in the link's
// target, and the tree that was running starts again.
const plantAfterRm = (target) => `mkdir -p "$FIXTURE/outside"
rm() { command rm "$@"; [ "\${!#}" != "${target}" ] || ln -s "$FIXTURE/outside" "\${!#}"; }
export -f rm`;
for (const [file, from, to, target] of [
    ['scripts/update.sh', '# Flush the installed recovery helper', 'RESULT_PHASE=swapped', '$PREV'],
    ['scripts/update.sh', '# --- automatic rollback', undefined, '$FAILED'],
    ['scripts/switch-to-upstream.sh', 'du -sh /persistent/free-sleep-data/raw-archive', 'RESULT_PHASE=swapped', '$PREV'],
    ['scripts/switch-to-upstream.sh', '# --- automatic rollback', undefined, '$FAILED'],
    ['scripts/rollback_pod.sh', '# --- swap', '# --- health check', '$TMP'],
    ['scripts/rollback_pod.sh', '# --- swap back on failure', undefined, '$TMP'],
]) {
    it(`${file} moves no tree into a symlink planted at ${target} (${from.slice(0, 30)})`, () => {
        const result = run(section(file, from, to), `${plantAfterRm(target)}
${statefulServices()}`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.deepEqual(result.outside, []);
        assert.equal(result.liveVersion, 'failed');
        if (target !== '$PREV')
            assert.equal(result.previousVersion, 'restored');
        assert.match(result.services, /^start free-sleep failed$/m);
    });
}
it('original-fork restore moves no tree into a symlink planted at the quarantine', () => {
    const result = run(section('scripts/migrate/restore-original-fork.sh', 'say "Swap marker present'), `
ABORTED_QUARANTINE="$FIXTURE/quarantine"; PREEXISTING_PREV="$FIXTURE/preexisting"
SWAP_MARKER="$FIXTURE/marker"; echo armed > "$SWAP_MARKER"
${plantAfterRm('$ABORTED_QUARANTINE')}
restore_iptables() { :; }
write_status() { echo "status: $*"; }
disarm_sentinel() { echo disarmed; }
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(result.outside, []);
    assert.equal(result.liveVersion, 'failed');
    assert.equal(result.previousVersion, 'restored');
    assert.equal(result.marker, 'armed\n');
});
for (const mode of ['previous', 'backup']) {
    it(`ops rollback ${mode} moves no tree into a symlink planted where the live tree goes`, () => {
        const target = mode === 'backup' ? '$PREV' : '$LIVE-failed';
        const result = run(section('ops/rollback.sh', "MOVE_TREE='", '\nif ssh ') +
            section('ops/rollback.sh', 'if [ "${1:-}" = "--from" ]; then', '\nsleep 8'), `
BACKUPS="$FIXTURE/backups"; mkdir -p "$BACKUPS/fixture"
tar czf "$BACKUPS/fixture/code.tar.gz" -C "$FIXTURE" prev
${plantAfterRm(target)}
SSH() { command bash -c "$1"; }
python3() { :; }
export -f systemctl python3; export LIVE PREV
${mode === 'backup' ? 'set -- --from fixture' : 'set --'}
`);
        assert.deepEqual(result.outside, []);
        assert.equal(result.liveVersion, 'failed');
        assert.match(result.services, /^start free-sleep failed$/m);
    });
}
it('ops deploy rollback moves no tree into a symlink planted where the failed tree goes', () => {
    const result = run(section('ops/deploy.sh', "MOVE_TREE='", 'ship_to_stage() {') +
        section('ops/deploy.sh', '# --- automatic rollback', '\nsleep 8'), `
POD_VERSION=3.0.0; POD_IP=pod; MOVED_MODULES=no
${plantAfterRm('$LIVE-failed')}
SSH() { command bash -c "$1"; }
export -f systemctl; export LIVE
`);
    assert.deepEqual(result.outside, []);
    assert.equal(result.liveVersion, 'failed');
    assert.match(result.services, /^start free-sleep failed$/m);
});
it('a laptop restore moves no tree into a symlink planted at the live path', () => {
    const result = runRestore(`
mkdir -p "$FIXTURE/outside"
mv() {
  local from=$1
  [ "$from" != -T ] || from=$2
  command mv "$@" || return
  [ "$from" != "$LIVE" ] || ln -s "$FIXTURE/outside" "$LIVE"
}
export -f mv
`);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(result.outside, []);
    assert.match(result.stdout, /\.restore\.[^/]+\/previous/);
});
for (const [file, from] of [
    ['scripts/migrate/pod-installer.sh', 'rm -rf "$PREEXISTING_PREV"'],
    ['scripts/migrate/agent-bootstrap-installer.sh', 'rm -rf "$PREEXISTING_PREV"'],
]) {
    it(`${file} sets no rollback slot aside into a symlink planted there, and hands over to the restore`, () => {
        const result = run(section(file, from, 'chown -hR dac:dac "$LIVE"'), `
PREEXISTING_PREV="$FIXTURE/preexisting"; SWAP_MARKER="$FIXTURE/marker"
${plantAfterRm('$PREEXISTING_PREV')}
`);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.deepEqual(result.outside, []);
        assert.equal(result.previousVersion, 'restored');
        assert.equal(result.liveVersion, 'failed');
        assert.equal(result.restored, 'restored\n');
    });
}
//# sourceMappingURL=updaterBehavior.test.js.map