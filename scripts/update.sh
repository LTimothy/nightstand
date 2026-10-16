#!/bin/bash
# Self-updater for this fork. Downloads the newest release of
# LTimothy/nightstand from its tag archive on GitHub and installs it: backup,
# stage, atomic swap, health check, automatic rollback on failure.
#
# Runs on the pod as root, normally via free-sleep-update.service (triggered
# from the app's Settings page). Outbound HTTPS and DNS are allowed only long
# enough to download, then blocked again no matter how the script exits.
#
# Env:
#   FS_UPDATE_FORCE=1   install even if the published version isn't newer
#   NIGHTSTAND_REPO     GitHub repo to pull from (default: LTimothy/nightstand)
#   NIGHTSTAND_BRANCH   branch to read releases.json from (default: main)
#
# Target-version protocol: if the server wrote
# /persistent/free-sleep-data/update-target.json before starting this
# service, that file requests a specific version (and whether a downgrade is
# allowed) instead of the newest release. See the "consume the target-version
# request file" block below.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -uo pipefail

NIGHTSTAND_REPO="${NIGHTSTAND_REPO:-LTimothy/nightstand}"
NIGHTSTAND_BRANCH="${NIGHTSTAND_BRANCH:-main}"
RELEASES_URL="https://raw.githubusercontent.com/${NIGHTSTAND_REPO}/${NIGHTSTAND_BRANCH}/releases.json"
TAG_ZIP_URL_PREFIX="https://github.com/${NIGHTSTAND_REPO}/archive/refs/tags/v"

# update-target.json protocol: written by POST /api/update before starting
# this service. Consumed once (deleted immediately after reading) so a stale
# file can never redirect a future plain update. FLOOR_VERSION is the first
# release that ships this protocol; versions below it predate the target
# protocol, the rollback service, and possibly current lockfile/node_modules
# compatibility, so the picker can't reach them. 3.0.0 is this stream's first
# release and it ships both, so the floor sits there. Keep it in step with
# CAPABLE_FLOOR in the app's VersionsPage, which gates the same picker.
TARGET_FILE=/persistent/free-sleep-data/update-target.json
FLOOR_VERSION="3.0.0"
SETTINGS_FILE=/persistent/free-sleep-data/lowdb/settingsDB.json

LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
STAGE=/home/dac/free-sleep-staging
FAILED=/home/dac/free-sleep-failed
ZIP=/home/dac/free-sleep-update.zip
BACKUPS=/persistent/free-sleep-backups
DATABASE_BACKUPS=/persistent/free-sleep-database-backups
SQLITE_SAFETY="$(dirname "${BASH_SOURCE[0]}")/sqlite-safety.py"
PRUNE_SNAPSHOTS="$(dirname "${BASH_SOURCE[0]}")/prune_db_snapshots.sh"
SWAP_MARKER=/persistent/free-sleep-data/update-swap.json
# Root runs only root-owned copies of these scripts; see system_scripts.py.
SYSTEM_DIR=/usr/local/lib/nightstand
RECOVERY_HELPER=$SYSTEM_DIR/recovery/recover_update.sh
RECOVERY_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Started by hand from the server user's tree: run the root-owned copy.
case "$RECOVERY_SOURCE" in
  "$SYSTEM_DIR"/copies/*) ;;
  *) if [ "${NIGHTSTAND_UPDATE_HANDOFF:-}" != 1 ] && [ -z "${NIGHTSTAND_FROM_TREE:-}" ] \
       && [ -f "$SYSTEM_DIR/live/scripts/update.sh" ]; then
       export NIGHTSTAND_FROM_TREE=1
       exec bash "$SYSTEM_DIR/live/scripts/update.sh"
     fi ;;
esac
KEEP_BACKUPS=5
NPM=/home/dac/.volta/bin/npm
NPX=/home/dac/.volta/bin/npx

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

RESULT_OPERATION=update

# How this run ended, for the app to show. The writer is read now because the
# tree it lives in can be moved aside before the run ends.
RESULT_FILE=/persistent/free-sleep-data/update-result.json
RESULT_PY=$(cat "$(dirname "${BASH_SOURCE[0]}")/write_result.py" 2>/dev/null || true)
RESULT_PHASE=preflight
RESULT_REASON=""
UP_TO_DATE=no
record_result() {
  local status=$1 outcome
  if [ "$status" -eq 0 ]; then
    if [ "$UP_TO_DATE" = yes ]; then outcome=up-to-date; else outcome=success; fi
  else
    case "$RESULT_PHASE" in
      preflight) outcome=stopped ;;
      restored) outcome=rolled-back ;;
      *) outcome=failed ;;
    esac
    if [ -z "$RESULT_REASON" ]; then
      case "$status" in
        129|130|143) RESULT_REASON="it was interrupted before it finished" ;;
        *) RESULT_REASON="it ended without giving a reason (exit status $status). See the update log." ;;
      esac
    fi
  fi
  python3 -c "$RESULT_PY" "$RESULT_FILE" "$RESULT_OPERATION" "$outcome" \
    "${CUR_VERSION:-}" "${EXPECTED_VERSION:-${TARGET_VERSION:-${STAGED_VERSION:-}}}" "$RESULT_REASON" >/dev/null 2>&1 || true
}

# While downloading, only HTTPS and name lookups go out: open_wan and
# close_wan in restore_helpers.sh.
WAN_OPEN=no
source "$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh" || exit 1
init_update_firewall
# Report legacy firewall jobs without editing the root crontab.
bash "$NIGHTSTAND_SCRIPTS/migrate/fork-artifacts.sh" warn-cron || true
# Stops a service that writes the data and confirms it is not running. Kept
# identical in the update, rollback, switch, reset and install scripts.
# systemd refuses to stop a unit that is not installed or does not load, even
# one that is not running, so the unit's state decides, not the stop.
stop_writer() {
  systemctl stop "$1" 2>/dev/null
  case "$(systemctl is-active "$1" 2>/dev/null)" in
    inactive|failed|unknown) return 0 ;;
  esac
  return 1
}
# Until the server has stopped, its Biometrics switch can start the stream
# again, so the stream is checked once more after the server stops. A stream
# started meanwhile is stopped for the swap and started again after it.
stop_late_stream() {
  case "$(systemctl is-active free-sleep-stream 2>/dev/null)" in
    inactive|failed|unknown) return 0 ;;
  esac
  STREAM_WAS_ACTIVE=active
  stop_writer free-sleep-stream
}

# Set from the moment the services stop for a swap until the new version
# passes its health check: the tree that goes back to LIVE if the run ends
# before then. SWAP_NEW is the tree being swapped in; once it has left its
# place it sits at LIVE, possibly started and possibly holding the previous
# tree's dependencies, so it goes back.
RESTORE_TREE=
SWAP_NEW=
finish_interrupted_swap() {
  [ -n "${RESTORE_TREE:-}" ] || return 0
  local moved=no modules_from=$FAILED
  if [ -n "${SWAP_NEW:-}" ] && [ ! -d "$SWAP_NEW" ] && [ -d "$LIVE" ] && [ -d "$RESTORE_TREE" ]; then
    # Nothing moves under a writer that will not stop.
    if stop_writer free-sleep && stop_writer free-sleep-stream; then
      mv "$LIVE" "$SWAP_NEW" || { say "Could not move the new tree at $LIVE aside; manual recovery required"; return 0; }
      modules_from=$SWAP_NEW
    else
      say "A service did not stop, so v${CUR_VERSION:-} was not put back. It is kept at $RESTORE_TREE. Manual recovery required"
    fi
  fi
  if [ ! -d "$LIVE" ]; then
    mv "$RESTORE_TREE" "$LIVE" || { say "Could not move $RESTORE_TREE back to $LIVE; manual recovery required"; return 0; }
    moved=yes
  fi
  [ "$moved" = no ] || follow_scripts
  if [ "${MOVED_MODULES:-no}" = yes ] && [ ! -d "$LIVE/server/node_modules" ] && [ -d "$modules_from/server/node_modules" ]; then
    mv "$modules_from/server/node_modules" "$LIVE/server/node_modules"
  fi
  # The previous version runs again: an interrupted swap changed nothing, and
  # an interrupted swap back is a restore.
  if [ "${RESULT_PHASE:-}" = swapping ]; then
    RESULT_PHASE=preflight
  elif [ "$moved" = yes ] && [ "${RESULT_PHASE:-}" = swapped ]; then
    RESULT_PHASE=restored
  fi
  systemctl is-active free-sleep >/dev/null 2>&1 || systemctl start free-sleep
  if [ "${STREAM_WAS_ACTIVE:-}" = active ] && ! systemctl is-active free-sleep-stream >/dev/null 2>&1; then
    systemctl start free-sleep-stream
  fi
  if [ -f "$SWAP_MARKER" ]; then
    bash "$RECOVERY_HELPER" --settle-restored \
      || say "The restore could not be verified; update swap marker kept"
  fi
}
cleanup() {
  local status=$?
  trap '' HUP INT TERM
  close_wan
  finish_interrupted_swap
  # A marked swap may still need dependencies from the stage at boot.
  [ -f "$SWAP_MARKER" ] || rm -rf "$STAGE"
  rm -rf "$STAGE.unzip" "$STAGE.health" "$STAGE.migrate.log" "$ZIP" "${WORK:-}"
  record_result "$status"
}

fail() { say "FATAL: $*"; [ -n "${RESULT_REASON:-}" ] || RESULT_REASON="$*"; exit 1; }

# Bed-in-use helpers, kept identical in update.sh, rollback_pod.sh and
# switch-to-upstream.sh. The app writes REQUEST_FILE as it starts one of them.
# A request the owner did not confirm while the bed was in use is checked
# again just before the services stop, as the bed may have come into use
# since. Without the file or its field, as from an older server, an older
# updater or SSH, nothing is checked again. A file older than ten minutes
# was left by a request whose run never started, so it is ignored too.
REQUEST_FILE=/persistent/free-sleep-data/operation-request.json
RECHECK_IN_USE=no
IN_USE_REASON="the bed came into use while it was getting ready"
read_request() {
  [ -f "$REQUEST_FILE" ] || return 0
  RECHECK_IN_USE=$(python3 -c '
import json, os, sys, time
try:
    if time.time() - os.path.getmtime(sys.argv[1]) > 600:
        raise ValueError("stale")
    with open(sys.argv[1]) as handle:
        request = json.load(handle)
    print("yes" if request.get("source") == "app" and request.get("confirmInUse") is False else "no")
except Exception:
    print("no")' "$REQUEST_FILE" 2>/dev/null) || RECHECK_IN_USE=no
  rm -f "$REQUEST_FILE"
}
recheck_in_use() {
  [ "$RECHECK_IN_USE" = yes ] || return 0
  local reasons
  reasons=$(curl -fsS --max-time 20 http://127.0.0.1:3000/api/update/in-use 2>/dev/null | python3 -c '
import json, sys
reasons = json.load(sys.stdin)["reasons"]
assert isinstance(reasons, list)
print(" ".join(str(reason) for reason in reasons))' 2>/dev/null) || reasons=status-unknown
  [ -n "$reasons" ] || return 0
  RESULT_REASON=$IN_USE_REASON
  fail "the bed may be in use ($reasons); live install untouched"
}

# Compares the staged tree with the digest releases.json publishes for it,
# using the installed copy of the digest script, never the downloaded one. A
# release published before digests existed has none, and installs as before.
verify_tree() {
  local expected actual tree=$1
  expected=$(printf '%s' "${RELEASES_JSON:-}" | python3 -c '
import json, sys
for release in json.load(sys.stdin).get("releases", []):
    if release.get("version") == sys.argv[1]:
        print(release.get("treeSha256") or "")
        break' "$EXPECTED_VERSION" 2>/dev/null) || expected=""
  if [ -z "$expected" ]; then
    say "No published checksum for v$EXPECTED_VERSION; installing without one"
    return 0
  fi
  if [ ! -f "$NIGHTSTAND_SCRIPTS/tree_digest.py" ]; then
    say "This install cannot check checksums yet; installing without one"
    return 0
  fi
  actual=$(python3 "$NIGHTSTAND_SCRIPTS/tree_digest.py" "$tree") || fail "could not compute the checksum of v$EXPECTED_VERSION; live install untouched"
  [ "$actual" = "$expected" ] || fail "the download of v$EXPECTED_VERSION does not match its published checksum; live install untouched"
  say "v$EXPECTED_VERSION matches its published checksum"
}

# Free-space helpers, kept identical in update.sh, switch-to-upstream.sh,
# migrate/pod-installer.sh, migrate/switch-to-this-fork.sh and ops/deploy.sh.
# Sizes are whole MB, rounded up, and a missing path counts as 0.
# SPACE_MARGIN_MB stays free for the firmware, the server and the logs while
# the operation runs, and covers a release a little larger than the one
# installed.
SPACE_MARGIN_MB=64
free_mb() { { df -kP "$1" 2>/dev/null || true; } | awk 'NR == 2 { print int($4 / 1024) }'; }
size_mb() { { du -sk "$@" 2>/dev/null || true; } | awk '{ kb += $1 } END { print int((kb + 1023) / 1024) }'; }
# The Node version a tree pins for Volta, empty when it pins none.
node_pin() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("volta", {}).get("node", ""))' \
    "$1/server/package.json" 2>/dev/null || true
}
# Volta fetches a pinned Node the first time npm or npx runs under it. For
# 24.11.0 on arm64 that is a 56 MB archive it keeps plus 207 MB unpacked.
# $1 is the version wanted, $2 the one already in use (empty if unknown).
node_fetch_mb() {
  if [ -n "$1" ] && [ "$1" != "$2" ] && [ ! -d "/home/dac/.volta/tools/image/node/$1" ]; then
    echo 280
  else
    echo 0
  fi
}

# The updater that runs is the one already installed, so a fix to this script
# would otherwise reach a pod one release after it ships. Once the new version
# is downloaded and its dependencies installed, the rest of the update is
# handed to that version's own copy. The line below is how a copy says it
# understands the handoff; an update only hands off to a copy that has it.
# nightstand-update-handoff: 1
HANDOFF_MARKER='# nightstand-update-handoff: 1'
HANDOFF="${NIGHTSTAND_UPDATE_HANDOFF:-}"

# Keep the descriptor across updater exec handoffs; all three operations share it.
if [ "${NIGHTSTAND_OPERATION_OWNER:-}" != "$$" ]; then
  OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
  if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
    OPERATION_LOCK=/tmp/free-sleep-operation.lock
  fi
  if [ -e "$OPERATION_LOCK" ]; then exec 9<"$OPERATION_LOCK"; else exec 9>>"$OPERATION_LOCK"; fi \
    || fail "cannot open the update lock"
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || fail "another update, rollback or switch is already running"
  else
    python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null \
      || fail "another update, rollback or switch is already running (or lock unavailable)"
  fi
  export NIGHTSTAND_OPERATION_OWNER=$$
fi
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ ! -f "$SWAP_MARKER" ] || fail "an earlier update swap still needs recovery; live install untouched"

# Tests can ask for more room than this needs, to see the refusal without
# filling a partition. The amounts only add to the need, and anything but a
# plain whole number of MB stops the run before it changes anything, so a
# typo shows.
EXTRA_ROOT_MB="${NIGHTSTAND_TEST_EXTRA_ROOT_MB:-0}"
EXTRA_PERS_MB="${NIGHTSTAND_TEST_EXTRA_PERSISTENT_MB:-0}"
for EXTRA_MB in "$EXTRA_ROOT_MB" "$EXTRA_PERS_MB"; do
  case "$EXTRA_MB" in *[!0-9]*) fail "NIGHTSTAND_TEST_EXTRA_*_MB must be a whole number of MB" ;; esac
  [ "${#EXTRA_MB}" -le 9 ] || fail "NIGHTSTAND_TEST_EXTRA_*_MB must be a whole number of MB"
done

if [ "$HANDOFF" != 1 ]; then
# --- consume the target-version request file, if any -------------------------
TARGET_VERSION=""
ALLOW_DOWNGRADE=no
if [ -f "$TARGET_FILE" ]; then
  TARGET_JSON=$(cat "$TARGET_FILE")
  rm -f "$TARGET_FILE"
  TARGET_VERSION=$(printf '%s' "$TARGET_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null) || TARGET_VERSION=""
  ALLOW_DOWNGRADE_RAW=$(printf '%s' "$TARGET_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("allowDowngrade",False))' 2>/dev/null) || ALLOW_DOWNGRADE_RAW=False
  [ "$ALLOW_DOWNGRADE_RAW" = True ] && ALLOW_DOWNGRADE=yes
  [ -n "$TARGET_VERSION" ] && say "Target-version request: v$TARGET_VERSION (allowDowngrade=$ALLOW_DOWNGRADE)"
fi
read_request

fi

# --- preflight ---------------------------------------------------------------
[ -d "$LIVE" ] || fail "no live install at $LIVE"
CUR_VERSION=$(python3 -c 'import json;print(json.load(open("'"$LIVE"'/server/src/serverInfo.json"))["version"])' 2>/dev/null) \
  || fail "cannot read current version"

# Room for what this run writes, sized from the install it replaces. On /:
# the download and its unpacked tree, and a fresh node_modules when the
# lockfile changed, plus a third of that again for npm's and Prisma's caches
# (68 and 33 MB from empty for 330 MB). A handed-off run has all of that on
# disk already, and a Node that Volta must fetch is checked once staged. On
# /persistent: the code backup (counted unpacked), the database snapshot and
# the settings copy, plus half the database again for migrations, which only
# ever add.
# Old snapshots must not be what blocks this run.
if [ -f "$PRUNE_SNAPSHOTS" ]; then bash "$PRUNE_SNAPSHOTS" "$DATABASE_BACKUPS" || true; fi
MODULES_MB=$(size_mb "$LIVE/server/node_modules")
TREE_MB=$(( $(size_mb "$LIVE") - MODULES_MB ))
DB_MB=$(size_mb /persistent/free-sleep-data/free-sleep.db /persistent/free-sleep-data/free-sleep.db-wal)
ROOT_NEED=$(( 2 * TREE_MB + MODULES_MB + MODULES_MB / 3 + SPACE_MARGIN_MB ))
[ "$HANDOFF" != 1 ] || ROOT_NEED=$SPACE_MARGIN_MB
PERS_NEED=$(( TREE_MB + DB_MB + DB_MB / 2 + $(size_mb /persistent/free-sleep-data/lowdb) + SPACE_MARGIN_MB ))
ROOT_NEED=$(( ROOT_NEED + 10#$EXTRA_ROOT_MB ))
PERS_NEED=$(( PERS_NEED + 10#$EXTRA_PERS_MB ))
ROOT_FREE=$(free_mb /)
PERS_FREE=$(free_mb /persistent)
[ "${ROOT_FREE:-0}" -ge "$ROOT_NEED" ] || fail "low disk on / (${ROOT_FREE:-unknown}M free, ${ROOT_NEED}M needed)"
[ "${PERS_FREE:-0}" -ge "$PERS_NEED" ] \
  || fail "low disk on /persistent (${PERS_FREE:-unknown}M free, ${PERS_NEED}M needed); old snapshots in /persistent/free-sleep-database-backups/ can be removed to make room"

if [ "$HANDOFF" = 1 ]; then
  # Handed off by the previously installed updater, which already consumed the
  # target request, downloaded and staged this version, and installed its
  # dependencies. Pick up from the backup.
  TARGET_VERSION="${NIGHTSTAND_HANDOFF_TARGET:-}"
  IS_DOWNGRADE="${NIGHTSTAND_HANDOFF_IS_DOWNGRADE:-no}"
  RECHECK_IN_USE="${NIGHTSTAND_HANDOFF_RECHECK_IN_USE:-no}"
  unset NIGHTSTAND_UPDATE_HANDOFF NIGHTSTAND_HANDOFF_TARGET NIGHTSTAND_HANDOFF_IS_DOWNGRADE NIGHTSTAND_HANDOFF_RECHECK_IN_USE
  [ -d "$STAGE" ] || fail "handed off without a staged tree at $STAGE"
  case "$RECOVERY_SOURCE" in
    "$SYSTEM_DIR"/copies/*) NEW_COPY=$(dirname "$NIGHTSTAND_SCRIPTS") ;;
    # An updater from before root-owned copies hands off from the stage.
    *) NEW_COPY=$(python3 -B "$NIGHTSTAND_SCRIPTS/system_scripts.py" publish --any-owner "$STAGE") \
         || fail "could not copy the new version's scripts for root; live install untouched" ;;
  esac
  NIGHTSTAND_SCRIPTS="$NEW_COPY/scripts"
  SQLITE_SAFETY="$NIGHTSTAND_SCRIPTS/sqlite-safety.py"
  PRUNE_SNAPSHOTS="$NIGHTSTAND_SCRIPTS/prune_db_snapshots.sh"
  say "Continuing with the new version's updater (running v$CUR_VERSION)"
else
# Left unindented to the matching fi: the steps below carry inline python that
# has to stay at column 0.


if [ -n "$TARGET_VERSION" ]; then
  FLOOR_OK=$(python3 -c '
import sys
def parts(v): return [int(x) for x in v.split(".")]
print("yes" if parts(sys.argv[1]) >= parts(sys.argv[2]) else "no")' "$TARGET_VERSION" "$FLOOR_VERSION")
  [ "$FLOOR_OK" = yes ] || fail "target v$TARGET_VERSION is below the floor (v$FLOOR_VERSION) the version picker supports"
fi

# --- resolve what to install --------------------------------------------------
if [ -z "$TARGET_VERSION" ]; then
  # Older settings files have no channel; they use the stable default.
  UPDATE_CHANNEL=$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as settings_file:
        channel = json.load(settings_file).get("updateChannel") or "stable"
except FileNotFoundError:
    channel = "stable"
if channel not in ("stable", "beta"):
    sys.exit("invalid update channel")
print(channel)' "$SETTINGS_FILE") || fail "could not read update channel from settings"
fi
open_wan
say "Current version: v$CUR_VERSION."
IS_DOWNGRADE=no
if [ -n "$TARGET_VERSION" ]; then
  say "Resolving requested v$TARGET_VERSION against releases.json..."
  RELEASES_JSON=$(curl -fsSL --max-time 20 "$RELEASES_URL") \
    || fail "could not fetch releases.json (check internet access and DNS)"
  MANIFEST_CHECK=$(printf '%s' "$RELEASES_JSON" | python3 -c "
import json, sys
target = '$TARGET_VERSION'
data = json.load(sys.stdin)
versions = [r['version'] for r in data['releases']]
print('known' if target in versions else 'missing')
" 2>/dev/null) || fail "could not parse releases.json"
  [ "$MANIFEST_CHECK" = missing ] && fail "v$TARGET_VERSION is not a known release (checked releases.json)"

  IS_DOWNGRADE=$(python3 -c '
import sys
def parts(v): return [int(x) for x in v.split(".")]
print("yes" if parts(sys.argv[1]) < parts(sys.argv[2]) else "no")' "$TARGET_VERSION" "$CUR_VERSION")
  if [ "$IS_DOWNGRADE" = yes ] && [ "$ALLOW_DOWNGRADE" != yes ]; then
    fail "v$TARGET_VERSION is older than the running v$CUR_VERSION; refusing without allowDowngrade"
  fi

  # Always the tag, never the branch: the branch moves after a release and
  # would install code that no release describes.
  RESOLVED_ZIP_URL="${TAG_ZIP_URL_PREFIX}${TARGET_VERSION}.zip"
  EXPECTED_VERSION="$TARGET_VERSION"
else
  say "Checking GitHub for the newest $UPDATE_CHANNEL release..."
  # Kept for the checksum check once the release is staged.
  RELEASES_JSON=$(curl -fsSL --max-time 20 "$RELEASES_URL") || RELEASES_JSON=""
  REMOTE_VERSION=$(printf '%s' "$RELEASES_JSON" | python3 -c '
import json, re, sys
channel = sys.argv[1]
releases = json.load(sys.stdin)["releases"]
for release in releases:
    if release.get("channel") == "stable" or (channel == "beta" and release.get("channel") == "beta"):
        version = release["version"]
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
            sys.exit("invalid release version")
        print(version)
        break
else:
    sys.exit("no release on the selected channel")' "$UPDATE_CHANNEL") \
    || fail "could not resolve a release for $UPDATE_CHANNEL (check releases.json and internet access)"

  NEWER=$(python3 -c '
import sys
cur = [int(x) for x in sys.argv[1].split(".")]
pub = [int(x) for x in sys.argv[2].split(".")]
print("yes" if pub > cur else "no")' "$CUR_VERSION" "$REMOTE_VERSION")

  if [ "$NEWER" = no ] && [ "${FS_UPDATE_FORCE:-0}" != 1 ]; then
    UP_TO_DATE=yes
    RESULT_REASON="Nightstand is already up to date (the newest published version is v$REMOTE_VERSION)"
    say "Already up to date (published: v$REMOTE_VERSION). Nothing to do."
    exit 0
  fi
  RESOLVED_ZIP_URL="${TAG_ZIP_URL_PREFIX}${REMOTE_VERSION}.zip"
  EXPECTED_VERSION="$REMOTE_VERSION"
fi

# --- download + stage --------------------------------------------------------
# Downloaded, checked and copied for root where only root can write, before
# the server user can reach any of it.
say "Downloading v$EXPECTED_VERSION..."
mkdir -p "$SYSTEM_DIR" && WORK=$(mktemp -d "$SYSTEM_DIR/.download.XXXXXX") \
  || fail "could not create a download folder in $SYSTEM_DIR; live install untouched"
curl -fL --max-time 300 -o "$WORK/release.zip" "$RESOLVED_ZIP_URL" || fail "download failed"
unzip -q "$WORK/release.zip" -d "$WORK/tree" || fail "unzip failed"
# GitHub names the archive's top dir after the repo and ref (repo-name + "-" +
# branch or tag), so resolve it dynamically rather than hardcoding it.
STAGED_DIR=$(find "$WORK/tree" -mindepth 1 -maxdepth 1 -type d | head -n1)
[ -d "$STAGED_DIR" ] || fail "unexpected zip layout"
verify_tree "$STAGED_DIR"
# Preserve archive retention before installing a version that ignores the config.
if [ "$IS_DOWNGRADE" = yes ]; then
  python3 "$NIGHTSTAND_SCRIPTS/prepare-downgrade.py" \
    "$STAGED_DIR/scripts/archive-raw.sh" /persistent/free-sleep-data/raw-archive.conf \
    || fail "could not preserve archive retention; downgrade cancelled before the swap"
fi
NEW_COPY=$(python3 -B "$NIGHTSTAND_SCRIPTS/system_scripts.py" publish "$STAGED_DIR") \
  || fail "could not copy the new version's scripts for root; live install untouched"
rm -rf "$STAGE"
mv "$STAGED_DIR" "$STAGE" || fail "could not stage v$EXPECTED_VERSION"
rm -rf "$WORK"
chown -R dac:dac "$STAGE"
fi

# the pod runs prebuilt code; refuse anything missing its build output
[ -f "$STAGE/server/dist/server.js" ] || fail "staged tree is missing server/dist/server.js"
[ -f "$STAGE/server/public/index.html" ] || fail "staged tree is missing server/public/index.html"
STAGED_VERSION=$(python3 -c 'import json;print(json.load(open("'"$STAGE"'/server/src/serverInfo.json"))["version"])') \
  || fail "staged tree has no readable serverInfo.json"
if [ -n "$TARGET_VERSION" ] && [ "$STAGED_VERSION" != "$TARGET_VERSION" ]; then
  fail "staged tree reports v$STAGED_VERSION but v$TARGET_VERSION was requested; refusing a mislabeled release"
fi
if [ -z "$TARGET_VERSION" ] && [ -n "${EXPECTED_VERSION:-}" ] && [ "$STAGED_VERSION" != "$EXPECTED_VERSION" ]; then
  fail "staged tree reports v$STAGED_VERSION but releases.json lists v$EXPECTED_VERSION; refusing a mislabeled release"
fi

# --- dependencies (old server still running) ---------------------------------
LOCK_SAME=no
cmp -s "$LIVE/server/package-lock.json" "$STAGE/server/package-lock.json" && LOCK_SAME=yes
# What / still takes now that the release is staged: a Node that Volta has to
# fetch, and the dependency install with its caches when the lockfile changed.
DEPS_NEED=$(node_fetch_mb "$(node_pin "$STAGE")" "$(node_pin "$LIVE")")
if [ "$HANDOFF" != 1 ] && [ "$LOCK_SAME" = no ]; then
  DEPS_NEED=$(( DEPS_NEED + MODULES_MB + MODULES_MB / 3 ))
fi
DEPS_NEED=$(( DEPS_NEED + SPACE_MARGIN_MB ))
ROOT_FREE=$(free_mb /)
[ "${ROOT_FREE:-0}" -ge "$DEPS_NEED" ] \
  || fail "low disk on / (${ROOT_FREE:-unknown}M free, ${DEPS_NEED}M needed for the new dependencies); live install untouched"
if [ "$HANDOFF" != 1 ]; then
  if [ "$LOCK_SAME" = no ]; then
    say "package-lock.json changed: running npm install in staging"
    run_limited 900 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' install --no-audit --no-fund" \
      || fail "npm install failed or took over 15 minutes; live install untouched"
  else
    say "package-lock.json unchanged: reusing existing node_modules"
  fi
  # Volta fetches a newly pinned Node the first time npm or npx runs under it,
  # which would otherwise be after the window closes. Fetch it now.
  if [ "$(node_fetch_mb "$(node_pin "$STAGE")" "$(node_pin "$LIVE")")" != 0 ]; then
    say "Fetching Node $(node_pin "$STAGE") for the new version"
    run_limited 600 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' --version" >/dev/null \
      || fail "could not fetch Node $(node_pin "$STAGE"); live install untouched"
  fi
  close_wan

  # Only to a copy that carries the marker. An older updater would find the
  # target request already consumed and install the latest release instead of
  # the one asked for, so a downgrade would quietly become an upgrade. Without
  # the marker this script finishes the update itself, as before.
  if [ "$IS_DOWNGRADE" != yes ] && grep -Fxq "$HANDOFF_MARKER" "$NEW_COPY/scripts/update.sh" 2>/dev/null; then
    say "Handing the rest of the update to the v$STAGED_VERSION updater"
    # exec replaces this process, so the cleanup trap would never run anyway;
    # cleared explicitly because it deletes the stage the new updater needs.
    trap - EXIT
    export NIGHTSTAND_UPDATE_HANDOFF=1
    export NIGHTSTAND_HANDOFF_TARGET="$TARGET_VERSION"
    export NIGHTSTAND_HANDOFF_IS_DOWNGRADE="$IS_DOWNGRADE"
    export NIGHTSTAND_HANDOFF_RECHECK_IN_USE="$RECHECK_IN_USE"
    exec bash "$NEW_COPY/scripts/update.sh"
  fi
fi

# --- backup ------------------------------------------------------------------
TS=$(date +%Y%m%d-%H%M%S)
BK="$BACKUPS/${TS}_v${CUR_VERSION}"
say "Backing up code + data to $BK"
mkdir -p "$BK"
tar czf "$BK/code.tar.gz" -C /home/dac --exclude free-sleep/server/node_modules free-sleep || fail "backup failed; aborting, nothing changed"
if [ -f /persistent/free-sleep-data/free-sleep.db ]; then
  DB_BACKUP="$DATABASE_BACKUPS/${TS}_v${CUR_VERSION}_update.db"
  python3 "$SQLITE_SAFETY" backup /persistent/free-sleep-data/free-sleep.db "$DB_BACKUP" \
    || fail "database backup failed; live install untouched"
  say "Database snapshot kept separately at $DB_BACKUP"
  if [ -f "$PRUNE_SNAPSHOTS" ]; then bash "$PRUNE_SNAPSHOTS" "$DATABASE_BACKUPS" "$DB_BACKUP" || true; fi
fi
cp -r /persistent/free-sleep-data/lowdb "$BK/lowdb" || fail "settings backup failed; live install untouched"
ls -1dt "$BACKUPS"/*/ | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf

# --- atomic swap ---------------------------------------------------------------
recheck_in_use
bash "$NIGHTSTAND_SCRIPTS/setup_services.sh" "$(dirname "$NIGHTSTAND_SCRIPTS")" --recovery-only \
  || fail "could not install boot recovery; live install untouched"
say "Installing v$STAGED_VERSION (service stops now)"
# The running server hands back what the next version may not continue. A
# target that has the same route continues it itself. One without the alarm
# record rings alarms without saving that they rang, so the server forgets
# the alarms it saved rather than report them as missed on the way back.
PREPARE=""
if [ "$IS_DOWNGRADE" = yes ] && ! grep -qs prepare-to-stop "$STAGE/server/dist/routes/update/update.js"; then
  PREPARE='{"reason":"downgrade"}'
elif [ "$IS_DOWNGRADE" = yes ] && [ ! -f "$STAGE/server/dist/jobs/alarmLedger.js" ]; then
  PREPARE='{"reason":"downgrade","handBack":false}'
fi
if [ -n "$PREPARE" ]; then
  curl -fsS --max-time 60 -X POST -H 'content-type: application/json' -d "$PREPARE" \
    http://127.0.0.1:3000/api/update/prepare-to-stop >/dev/null \
    || say "WARNING: the server could not prepare to stop; continuing"
fi
RESULT_PHASE=swapping
STREAM_WAS_ACTIVE=$(systemctl is-active free-sleep-stream 2>/dev/null || true)
RESTORE_TREE=$PREV
SWAP_NEW=$STAGE
if ! stop_writer free-sleep-stream || ! stop_writer free-sleep || ! stop_late_stream; then
  RESULT_PHASE=preflight
  fail "could not stop the running services; live install untouched"
fi
bash "$RECOVERY_HELPER" --arm "$STREAM_WAS_ACTIVE" "$STAGED_VERSION" \
  || fail "could not write the update swap marker; live install untouched"
# Flush the installed recovery helper, unit and marker before moving trees.
sync
rm -rf "$PREV"
mv "$LIVE" "$PREV" || {
  RESULT_PHASE=restored
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  RESULT_REASON="the new version could not be put in place, so it never started"
  fail "swap failed moving live aside"
}
mv "$STAGE" "$LIVE" || {
  mv "$PREV" "$LIVE" || fail "swap failed and previous tree could not be restored; manual recovery required"
  RESULT_PHASE=restored
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  RESULT_REASON="the new version could not be put in place, so it never started"
  fail "swap failed; previous version restored"
}
RESULT_PHASE=swapped
python3 -B "$NIGHTSTAND_SCRIPTS/system_scripts.py" point "$NEW_COPY" \
  || say "WARNING: root still runs the previous version's scripts until the next update"
MOVED_MODULES=no
if [ "$LOCK_SAME" = yes ]; then
  MOVED_MODULES=yes
  mv "$PREV/server/node_modules" "$LIVE/server/node_modules"
  chown -R dac:dac "$LIVE/server/node_modules"
fi

# Check the database for pending migrations even when the schema is unchanged.
# migrate status treats a database ahead of the code as up to date, so it never acts on a downgrade.
MIGRATION_FAILED=no
SCHEMA_CHANGED=no
cmp -s "$PREV/server/prisma/schema.prisma" "$LIVE/server/prisma/schema.prisma" || SCHEMA_CHANGED=yes
if [ "$IS_DOWNGRADE" = yes ]; then
  say "Downgrade: skipping prisma migrate; keeping the newer database and generating the target client"
  sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma generate" \
    || MIGRATION_FAILED=yes
elif ! sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma migrate status" >/dev/null 2>&1; then
  say "Database has unapplied migrations: migrate deploy + generate"
  PRISMA_OK=no
  RESOLVED_FAILED=no
  for attempt in 1 2 3; do
    if sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma migrate deploy" 2>&1 | tee "$STAGE.migrate.log"; then
      PRISMA_OK=yes
      break
    fi
    say "prisma migrate attempt $attempt failed"
    if grep -q P3009 "$STAGE.migrate.log"; then
      [ "$RESOLVED_FAILED" = no ] || break
      MIGRATION_HELPER="$NEW_COPY/scripts/sqlite-safety.py"
      [ -f "$MIGRATION_HELPER" ] || MIGRATION_HELPER="$NIGHTSTAND_SCRIPTS/sqlite-safety.py"
      FAILED_NAMES=$(python3 "$MIGRATION_HELPER" recoverable-migrations \
        /persistent/free-sleep-data/free-sleep.db "$LIVE/server/prisma/migrations") || {
        say "Failed migration needs manual recovery. Do not reset the database; preserve the backup and inspect the migration log."
        break
      }
      RESOLVED_FAILED=yes
      RESOLVE_OK=yes
      while IFS= read -r migration; do
        sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma migrate resolve --rolled-back '$migration'" || RESOLVE_OK=no
      done <<< "$FAILED_NAMES"
      [ "$RESOLVE_OK" = yes ] || break
    fi
    sleep 5
  done
  [ "$PRISMA_OK" = yes ] &&
    { sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma generate" || PRISMA_OK=no; }
  # Assert the end state rather than trusting the exit code: migrate status
  # fails when anything is still pending, which is the exact condition that
  # nothing downstream of here is able to notice.
  [ "$PRISMA_OK" = yes ] &&
    { sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma migrate status" || PRISMA_OK=no; }
  [ "$PRISMA_OK" = yes ] || MIGRATION_FAILED=yes
elif [ "$SCHEMA_CHANGED" = yes ]; then
  # node_modules may have been carried over from the previous version, with
  # its generated client, so a schema change with nothing to migrate still
  # needs one.
  say "Prisma schema changed with nothing to migrate: generate"
  sudo -u dac bash -c "cd '$LIVE/server' && '$NPX' dotenv -e .env.pod -- npx prisma generate" \
    || MIGRATION_FAILED=yes
fi

# Before the start below, so the limits apply to the processes it starts.
if [ -f "$NEW_COPY/scripts/setup_resource_limits.sh" ]; then
  bash "$NEW_COPY/scripts/setup_resource_limits.sh" \
    || say "WARNING: failed to install service memory limits; the services run unbounded until the next successful update"
fi

if [ "$MIGRATION_FAILED" != yes ]; then
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
fi

say "Ensuring RAW-archive retention timer is installed"
if cp "$NEW_COPY/scripts/systemd/free-sleep-archive-raw.service" "$NEW_COPY/scripts/systemd/free-sleep-archive-raw.timer" /etc/systemd/system/ \
  && systemctl daemon-reload \
  && systemctl enable --now free-sleep-archive-raw.timer; then
  :
else
  say "WARNING: failed to install RAW-archive retention timer; calibration/analyze jobs may fail on stale data windows"
fi

# --- units and sudoers rules behind the app's controls --------------------------
# Installs that predate a control (or came from another fork) may lack its unit
# or sudoers rule, so the matching button would fail. Idempotent, so every
# update re-runs it.
say "Ensuring the updater, rollback, and revert services and sudoers rules are installed"
if [ -f "$NEW_COPY/scripts/setup_services.sh" ]; then
  bash "$NEW_COPY/scripts/setup_services.sh" "$NEW_COPY" \
    || say "WARNING: some services or sudoers rules could not be installed; the matching controls may not work until the next successful update"
fi

# --- health check --------------------------------------------------------------
# Waits up to 90 s for the server to answer as version $1, and with a sensor
# reading when $2 is "temperature", keeping each answer in $HBODY. Any other
# $2 returns 2. Kept identical in update.sh and install.sh.
serves_version() {
  local code body ok
  case "${2:-}" in ""|temperature) ;; *) return 2 ;; esac
  for _ in $(seq 1 30); do
    sleep 3
    # Log every attempt's HTTP status so a failed log shows the shape of the
    # failure on its own (000 = no/aborted response, 503 = still starting).
    code=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/api/deviceStatus" 2>/dev/null || echo 000)
    say "  health attempt: HTTP $code"
    [ "$code" = 200 ] || continue
    body=$(cat "$HBODY" 2>/dev/null) || continue
    ok=$(printf '%s' "$body" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert d['freeSleep']['version'] == '$1'
    if '${2:-}' == 'temperature':
        assert isinstance(d['left']['currentTemperatureF'], (int, float))
    print('yes')
except Exception:
    print('no')" 2>/dev/null)
    if [ "$ok" = yes ]; then
      systemctl is-active free-sleep >/dev/null
      return
    fi
  done
  return 1
}
say "Health check (up to 90s)"
HEALTHY=no
HBODY="$STAGE.health"
if [ "$MIGRATION_FAILED" != yes ] && serves_version "$STAGED_VERSION" temperature; then
  HEALTHY=yes
fi

# A pod serving HTTP 200 against a half-applied schema looks healthy and is not.
if [ "$MIGRATION_FAILED" = yes ]; then
  RESULT_REASON="database migrations did not apply"
  say "prisma migrations did not apply; failing the update so it rolls back"
  HEALTHY=no
fi

# The first arming of the hardware watchdog can reset the Pod, so it runs only
# once the update has succeeded. Older trees carry a hand-run copy of the
# script without the trial, which must not run on its own.
arm_watchdog() {
  local script="$NEW_COPY/scripts/setup_watchdog.sh"
  grep -q NIGHTSTAND_WATCHDOG_TRIAL "$script" 2>/dev/null || return 0
  bash "$script" --auto || say "WARNING: the hardware watchdog could not be turned on; see above"
}

if [ "$HEALTHY" = yes ]; then
  RESTORE_TREE=
  SWAP_NEW=
  for FIREWALL_ATTEMPT in 1 2; do
    sh "$NEW_COPY/scripts/block_internet_access.sh" || say "WARNING: firewall script reported an error; checking rules"
    # Older downgrade targets intentionally restore their historical firewall.
    EXPECT_RESET=yes
    if [ "${IS_DOWNGRADE:-no}" = yes ] &&
      ! grep -q -- '--dport 1337.*--reject-with tcp-reset' "$NEW_COPY/scripts/block_internet_access.sh"; then
      EXPECT_RESET=no
    fi
    # Older releases end OUTPUT with DROP.
    if { fw4 -C OUTPUT -j REJECT || fw4 -C OUTPUT -j DROP; } &&
       { fw6 -C OUTPUT -j REJECT || fw6 -C OUTPUT -j DROP; }; then
      if [ "$EXPECT_RESET" = no ] || fw4 -C OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset; then
        bash "$RECOVERY_HELPER" --clear || fail "could not clear the update swap marker"
        say "SUCCESS: pod is serving v$STAGED_VERSION. Previous version kept at $PREV; backup at $BK"
        arm_watchdog
        exit 0
      fi
      if [ "$FIREWALL_ATTEMPT" = 2 ]; then
        say "WARNING: port 1337 reset rule is unavailable; internet access remains blocked by the final OUTPUT rule"
        bash "$RECOVERY_HELPER" --clear || fail "could not clear the update swap marker"
        say "SUCCESS: pod is serving v$STAGED_VERSION. Previous version kept at $PREV; backup at $BK"
        arm_watchdog
        exit 0
      fi
    fi
    say "Firewall rules missing after attempt $FIREWALL_ATTEMPT"
  done
  RESULT_REASON="the new firewall rules could not be applied"
  say "New firewall could not be applied; restoring the previous version"
fi

# --- automatic rollback ---------------------------------------------------------

# The previous version answers 503 until it reaches the firmware, up to 30 s
# after a cold start, so it gets as long as the forward check to answer.
restored_version_answers() {
  local code
  say "Checking the restored version (up to 90s)"
  for _ in $(seq 1 30); do
    sleep 3
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/api/deviceStatus" 2>/dev/null) || true
    say "  restore attempt: HTTP ${code:-000}"
    [ "$code" = 200 ] && return 0
  done
  return 1
}

[ -n "${RESULT_REASON:-}" ] || RESULT_REASON="the new version did not pass its health check"
say "Health check FAILED: rolling back to v$CUR_VERSION"
say "Last 60 server log lines from the failed build (for diagnosis):"
tail -n 60 /persistent/free-sleep-data/logs/free-sleep.log 2>/dev/null || say "  (no server log available)"
# Armed again when a failed firewall brings a healthy run here.
RESTORE_TREE=$PREV
SWAP_NEW=$STAGE
# Nothing moves under a writer that will not stop: the failed version keeps
# running, and both trees and the backup stay where they are.
if ! stop_writer free-sleep || ! stop_writer free-sleep-stream; then
  RESTORE_TREE=
  systemctl is-active free-sleep >/dev/null 2>&1 || systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ] && ! systemctl is-active free-sleep-stream >/dev/null 2>&1; then
    systemctl start free-sleep-stream
  fi
  fail "update failed and a service did not stop, so v$CUR_VERSION was not put back. It is kept at $PREV; backup at $BK. Manual recovery required"
fi
rm -rf "$FAILED"
SWAP_NEW=
mv "$LIVE" "$FAILED" || {
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  fail "could not move failed tree aside; attempted to restart the tree at $LIVE; manual recovery required"
}
mv "$PREV" "$LIVE" || {
  mv "$FAILED" "$LIVE" || fail "could not restore either tree; manual recovery required"
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  fail "could not restore previous tree; attempted to restart the tree at $LIVE; manual recovery required"
}
RESULT_PHASE=restored
follow_scripts
if [ "$MOVED_MODULES" = yes ]; then
  mv "$FAILED/server/node_modules" "$LIVE/server/node_modules"
fi
systemctl start free-sleep
if [ "$STREAM_WAS_ACTIVE" = active ]; then
  systemctl restart free-sleep-stream 2>/dev/null || true
fi
RESTORE_TREE=
sh "$SYSTEM_DIR/live/scripts/block_internet_access.sh" || say "WARNING: restored firewall could not be applied"
restore_output_policy save
if restored_version_answers; then
  bash "$RECOVERY_HELPER" --clear || fail "could not clear the update swap marker"
  fail "update failed but rollback OK (pod back on v$CUR_VERSION). Failed tree kept at $FAILED; see journalctl -u free-sleep"
else
  RESULT_PHASE=swapped
  fail "update failed AND rollback health check failed. Backup tarball: $BK. Check journalctl -u free-sleep. The bed hardware itself keeps running regardless."
fi
