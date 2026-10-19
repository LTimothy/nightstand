#!/bin/bash
# Reverts this pod to plain upstream free-sleep. Upstream ships no tags or
# releases, so this installs the upstream commit the switch was last checked
# with when releases.json records one, and main when it records none. Same
# shape as update.sh: backup, stage, atomic swap, health check, auto-rollback
# on failure.
#
# Runs via free-sleep-revert.service. Re-adopting this fork afterward means
# re-running scripts/migrate/switch-to-this-fork.sh; there's no way back
# from inside the app once upstream free-sleep is running.
set -uo pipefail

UPSTREAM_ZIP_URL="https://github.com/throwaway31265/free-sleep/archive/refs/heads/main.zip"
# Only read for upstreamSwitch, the upstream commit this switch was checked with.
SWITCH_RELEASES_URL="https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json"

LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
STAGE=/home/dac/free-sleep-revert-staging
FAILED=/home/dac/free-sleep-revert-failed
SYSTEM_DIR=/usr/local/lib/nightstand
BACKUPS=/persistent/free-sleep-backups
DATABASE_BACKUPS=/persistent/free-sleep-database-backups
SQLITE_SAFETY="$(dirname "${BASH_SOURCE[0]}")/sqlite-safety.py"
UPSTREAM_TARGET_HELPER="$(dirname "${BASH_SOURCE[0]}")/upstream_target.py"
PRUNE_SNAPSHOTS="$(dirname "${BASH_SOURCE[0]}")/prune_db_snapshots.sh"
KEEP_BACKUPS=5
NPM=/home/dac/.volta/bin/npm

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

RESULT_OPERATION=switch

# How this run ended, for the app to show. The writer is read now because the
# tree it lives in can be moved aside before the run ends.
RESULT_FILE=/persistent/free-sleep-data/update-result.json
RESULT_PY=$(cat "$(dirname "${BASH_SOURCE[0]}")/write_result.py" 2>/dev/null || true)
RESULT_PHASE=preflight
RESULT_REASON=""
UP_TO_DATE=no

DATA_CHANGED=no
RESTORE_ATTEMPTED=no
ARCHIVE_WAS_ACTIVE=inactive
restore_switch_data() {
  [ "$DATA_CHANGED" = yes ] || return 0
  [ "$RESTORE_ATTEMPTED" = no ] || return 0
  # Never under a running writer, as when the run ends while upstream runs.
  local unit
  for unit in free-sleep free-sleep-stream; do
    case "$(systemctl is-active "$unit" 2>/dev/null)" in
      inactive|failed|unknown) ;;
      *) say "$unit is running, so the settings were not put back"; return 1 ;;
    esac
  done
  RESTORE_ATTEMPTED=yes
  local copy
  for name in settingsDB.json schedulesDB.json; do
    # Copied in root's /persistent, then renamed over any link at the name.
    copy=$(mktemp /persistent/.nightstand-restore.XXXXXX) || return 1
    if ! cp -p "$BK/lowdb/$name" "$copy" \
      || ! python3 -I -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$copy" "/persistent/free-sleep-data/lowdb/$name"; then
      rm -f "$copy"
      return 1
    fi
  done
  DATA_CHANGED=no
  if [ "$ARCHIVE_WAS_ACTIVE" = active ]; then
    systemctl start free-sleep-archive-raw.timer >/dev/null 2>&1 || true
  fi
}

# A failed settings restore must not prevent recovery of the web UI.
restore_switch_data_or_fail() {
  restore_switch_data || {
    if [ "$ARCHIVE_WAS_ACTIVE" = active ]; then
      systemctl start free-sleep-archive-raw.timer >/dev/null 2>&1 || true
    fi
    systemctl start free-sleep || true
    if [ "$STREAM_WAS_ACTIVE" = active ]; then
      systemctl restart free-sleep-stream 2>/dev/null || true
    fi
    fail "$*"
  }
}

# While downloading, only HTTPS and name lookups go out: open_wan and
# close_wan in restore_helpers.sh.
WAN_OPEN=no
source "$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh" || exit 1
init_update_firewall
stop_writer() { restore_stop_writer "$@"; }

# Set from the moment the services stop for a swap until upstream passes its
# health check: the tree that goes back to LIVE if the run ends before then.
# SWAP_NEW is the tree being swapped in; once it has left its place it sits at
# LIVE, possibly started and possibly holding the previous tree's
# dependencies, so it goes back. The settings go back before this fork starts.
RESTORE_TREE=
SWAP_NEW=
finish_interrupted_swap() {
  local moved=no modules_from=$FAILED
  if [ -n "${RESTORE_TREE:-}" ] && [ -n "${SWAP_NEW:-}" ] && [ ! -d "$SWAP_NEW" ] && [ -d "$LIVE" ] && [ -d "$RESTORE_TREE" ]; then
    # Nothing moves, and no settings go back, under a writer that will not stop.
    if stop_writer free-sleep && stop_writer free-sleep-stream; then
      move_tree "$LIVE" "$SWAP_NEW" || { say "Could not move the new tree at $LIVE aside; manual recovery required"; return 0; }
      modules_from=$SWAP_NEW
    else
      DATA_CHANGED=no
      say "A service did not stop, so this fork was not put back. It is kept at $RESTORE_TREE; its settings are in $BK/lowdb. Manual recovery required"
    fi
  fi
  restore_switch_data || say "WARNING: restore settings from $BK/lowdb before restarting"
  [ -n "${RESTORE_TREE:-}" ] || return 0
  if [ ! -d "$LIVE" ]; then
    move_tree "$RESTORE_TREE" "$LIVE" || { say "Could not move $RESTORE_TREE back to $LIVE; manual recovery required"; return 0; }
    moved=yes
  fi
  if [ "${MOVED_MODULES:-no}" = yes ] && [ ! -d "$LIVE/server/node_modules" ] && [ -d "$modules_from/server/node_modules" ]; then
    move_tree "$modules_from/server/node_modules" "$LIVE/server/node_modules"
  fi
  if [ "${ARCHIVE_WAS_ACTIVE:-}" = active ]; then
    systemctl start free-sleep-archive-raw.timer >/dev/null 2>&1 || true
  fi
  # The previous version runs again: an interrupted swap whose settings came
  # back changed nothing, and an interrupted swap back is a restore.
  if [ "${RESULT_PHASE:-}" = swapping ] && [ "${DATA_CHANGED:-no}" = no ]; then
    RESULT_PHASE=preflight
  elif [ "$moved" = yes ] && [ "${RESULT_PHASE:-}" = swapped ]; then
    RESULT_PHASE=restored
  fi
  systemctl is-active free-sleep >/dev/null 2>&1 || systemctl start free-sleep
  if [ "${STREAM_WAS_ACTIVE:-}" = active ] && ! systemctl is-active free-sleep-stream >/dev/null 2>&1; then
    systemctl start free-sleep-stream
  fi
}
cleanup() { local status=$?; trap '' HUP INT TERM; close_wan; finish_interrupted_swap; rm -rf "$STAGE" "${WORK:-}"; [ -z "${HBODY:-}" ] || rm -f "$HBODY"; record_result "$status"; }

fail() { say "FATAL: $*"; [ -n "${RESULT_REASON:-}" ] || RESULT_REASON="$*"; exit 1; }

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
  python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("volta", {}).get("node", ""))' \
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

# Keep the descriptor across updater exec handoffs; all three operations share it.
take_operation_lock
case $? in
  0) ;;
  1) fail "cannot open the update lock" ;;
  *) fail "another update, rollback or switch is already running" ;;
esac
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ ! -f /persistent/free-sleep-data/update-swap.json ] || fail "an earlier update swap still needs recovery; live install untouched"

# Read the confirmed target before the bed-use helper consumes the request.
CONFIRMED_TARGET=""
if [ -f "/persistent/free-sleep-data/operation-request.json" ]; then
  CONFIRMED_TARGET=$(python3 -B "$UPSTREAM_TARGET_HELPER" --request "/persistent/free-sleep-data/operation-request.json") \
    || fail "could not read the confirmed upstream target; live install untouched"
fi

read_request

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

# --- preflight ---------------------------------------------------------------
[ -d "$LIVE" ] || fail "no live install at $LIVE"
CUR_VERSION=$(python3 -I -c 'import json;print(json.load(open("'"$LIVE"'/server/src/serverInfo.json"))["version"])' 2>/dev/null) \
  || fail "cannot read current version"

# Room for what this run writes, sized from the install it replaces. On /:
# upstream's download and its unpacked tree, and a fresh node_modules plus a
# third of that again for npm's and Prisma's caches (68 and 33 MB from empty
# for 330 MB); a Node that Volta must fetch is checked once staged. On
# /persistent: the code backup
# (counted unpacked), the database snapshot and the settings copy. Nothing
# migrates on the way back.
# Old snapshots must not be what blocks this run.
if [ -f "$PRUNE_SNAPSHOTS" ]; then bash "$PRUNE_SNAPSHOTS" "$DATABASE_BACKUPS" || true; fi
MODULES_MB=$(size_mb "$LIVE/server/node_modules")
TREE_MB=$(( $(size_mb "$LIVE") - MODULES_MB ))
ROOT_NEED=$(( 2 * TREE_MB + MODULES_MB + MODULES_MB / 3 + SPACE_MARGIN_MB ))
PERS_NEED=$(( TREE_MB + $(size_mb /persistent/free-sleep-data/free-sleep.db /persistent/free-sleep-data/free-sleep.db-wal) \
  + $(size_mb /persistent/free-sleep-data/lowdb) + SPACE_MARGIN_MB ))
ROOT_NEED=$(( ROOT_NEED + 10#$EXTRA_ROOT_MB ))
PERS_NEED=$(( PERS_NEED + 10#$EXTRA_PERS_MB ))
ROOT_FREE=$(free_mb /)
PERS_FREE=$(free_mb /persistent)
[ "${ROOT_FREE:-0}" -ge "$ROOT_NEED" ] || fail "low disk on / (${ROOT_FREE:-unknown}M free, ${ROOT_NEED}M needed)"
[ "${PERS_FREE:-0}" -ge "$PERS_NEED" ] \
  || fail "low disk on /persistent (${PERS_FREE:-unknown}M free, ${PERS_NEED}M needed); old snapshots in /persistent/free-sleep-database-backups/ can be removed to make room"

# --- download + stage ---------------------------------------------------------
open_wan
# The switch installs the upstream commit it was last checked with, when
# releases.json names one. Upstream's main is installed only when the list was
# read and records no such commit; an unreadable list or a malformed record
# stops the switch, since the app may already have promised the checked one.
TRANSACTIONAL_SWITCH=no
SWITCH_MANIFEST=$(curl -fsSL --max-time 20 "$SWITCH_RELEASES_URL") || SWITCH_MANIFEST=""
if [ -n "$CONFIRMED_TARGET" ]; then
  SWITCH_PIN=$(printf '%s' "$SWITCH_MANIFEST" | python3 -B "$UPSTREAM_TARGET_HELPER" - --confirmed-json "$CONFIRMED_TARGET") \
    || fail "the confirmed upstream target is no longer available; live install untouched"
  case "$SWITCH_PIN" in
    v2\ *)
      [ -f "$NIGHTSTAND_SCRIPTS/switch_installation.py" ] || fail "the transactional switch runner is missing; live install untouched"
      TRANSACTIONAL_SWITCH=yes ;;
  esac
else
SWITCH_PIN=$(printf '%s' "$SWITCH_MANIFEST" | python3 -I -c '
import json, re, sys
data = json.load(sys.stdin)
if not isinstance(data, dict):
    sys.exit(1)
if "upstreamSwitch" not in data:
    print("main")
    sys.exit(0)
pin = data["upstreamSwitch"]
if not isinstance(pin, dict):
    sys.exit(1)
commit = pin.get("commit")
digest = pin.get("treeSha256", "")
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    sys.exit(1)
if not isinstance(digest, str) or (digest and not re.fullmatch(r"[0-9a-f]{64}", digest)):
    sys.exit(1)
print("pin", commit, digest)' 2>/dev/null) \
  || fail "could not read the release list to find the checked upstream version; live install untouched"
fi
SWITCH_COMMIT=""
SWITCH_DIGEST=""
read -r _ SWITCH_COMMIT SWITCH_DIGEST _ <<< "$SWITCH_PIN" || true
if [ -n "$SWITCH_COMMIT" ]; then
  UPSTREAM_ZIP_URL="https://github.com/throwaway31265/free-sleep/archive/${SWITCH_COMMIT}.zip"
  say "Installing upstream commit $SWITCH_COMMIT, the one this switch was checked with"
else
  say "No checked upstream commit is recorded; installing upstream's main"
fi
say "Downloading upstream (throwaway31265/free-sleep ${SWITCH_COMMIT:-main})..."
# Unpacked in a folder only root can reach, then moved to the stage.
mkdir -p "$SYSTEM_DIR" && WORK=$(mktemp -d "$SYSTEM_DIR/.download.XXXXXX") \
  || fail "could not create a download folder in $SYSTEM_DIR; live install untouched"
curl -fL --max-time 300 -o "$WORK/upstream.zip" "$UPSTREAM_ZIP_URL" || fail "download failed; live install untouched"
unzip -q "$WORK/upstream.zip" -d "$WORK/tree" || fail "unzip failed; live install untouched"
# GitHub names the archive's top dir after the repo and ref (repo-name +
# "-" + branch), so resolve it dynamically rather than hardcoding it.
STAGED_DIR=$(find "$WORK/tree" -mindepth 1 -maxdepth 1 -type d | head -n1)
[ -d "$STAGED_DIR" ] || fail "unexpected zip layout; live install untouched"
rm -rf "$STAGE"
move_tree "$STAGED_DIR" "$STAGE" || fail "could not stage upstream; live install untouched"
rm -rf "$WORK"
chown -hR dac:dac "$STAGE"
# Checked with the installed copy of the digest script, never the downloaded one.
if [ -n "$SWITCH_COMMIT" ]; then
  if [ -z "$SWITCH_DIGEST" ]; then
    say "No published checksum for upstream commit $SWITCH_COMMIT; installing without one"
  elif [ ! -f "$NIGHTSTAND_SCRIPTS/tree_digest.py" ]; then
    [ -z "$CONFIRMED_TARGET" ] || fail "cannot verify the confirmed upstream checksum; live install untouched"
    say "This install cannot check checksums yet; installing without one"
  else
    SWITCH_ACTUAL=$(python3 "$NIGHTSTAND_SCRIPTS/tree_digest.py" "$STAGE") \
      || fail "could not compute the checksum of upstream free-sleep; live install untouched"
    [ "$SWITCH_ACTUAL" = "$SWITCH_DIGEST" ] \
      || fail "the download of upstream free-sleep does not match its published checksum; live install untouched"
    say "Upstream commit $SWITCH_COMMIT matches its published checksum"
  fi
fi

[ -f "$STAGE/server/dist/server.js" ] || fail "staged tree is missing server/dist/server.js"
[ -f "$STAGE/server/public/index.html" ] || fail "staged tree is missing server/public/index.html"
STAGED_VERSION=$(python3 -I -c 'import json;print(json.load(open("'"$STAGE"'/server/src/serverInfo.json"))["version"])') \
  || fail "staged tree has no readable serverInfo.json"

# --- dependencies (old server still running) ---------------------------------
LOCK_SAME=no
cmp -s "$LIVE/server/package-lock.json" "$STAGE/server/package-lock.json" && LOCK_SAME=yes
# What / still takes now that upstream is staged: a Node that Volta has to
# fetch, and the dependency install with its caches when the lockfile differs.
DEPS_NEED=$(node_fetch_mb "$(node_pin "$STAGE")" "$(node_pin "$LIVE")")
[ "$LOCK_SAME" = yes ] || DEPS_NEED=$(( DEPS_NEED + MODULES_MB + MODULES_MB / 3 ))
DEPS_NEED=$(( DEPS_NEED + SPACE_MARGIN_MB ))
ROOT_FREE=$(free_mb /)
[ "${ROOT_FREE:-0}" -ge "$DEPS_NEED" ] \
  || fail "low disk on / (${ROOT_FREE:-unknown}M free, ${DEPS_NEED}M needed for upstream's dependencies); live install untouched"
if [ "$LOCK_SAME" = no ]; then
  say "package-lock.json differs from upstream's: installing its dependencies in staging"
  # A checked artifact's lockfile must not change after its checksum check.
  NPM_INSTALL=install
  [ "$TRANSACTIONAL_SWITCH" != yes ] || NPM_INSTALL=ci
  run_limited 900 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' $NPM_INSTALL --no-audit --no-fund" \
    || fail "npm $NPM_INSTALL failed or took over 15 minutes; live install untouched"
else
  say "package-lock.json matches: reusing existing node_modules"
fi
# Volta fetches a newly pinned Node the first time npm runs under it, which
# would otherwise be when upstream's server starts after the window closes.
if [ "$(node_fetch_mb "$(node_pin "$STAGE")" "$(node_pin "$LIVE")")" != 0 ]; then
  say "Fetching Node $(node_pin "$STAGE") for upstream"
  run_limited 600 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' --version" >/dev/null \
    || fail "could not fetch Node $(node_pin "$STAGE"); live install untouched"
fi
# Confirmed V2 targets use the durable transaction before any legacy mutation.
if [ "$TRANSACTIONAL_SWITCH" = yes ]; then
  [ -n "$SWITCH_DIGEST" ] && [ "${SWITCH_ACTUAL:-}" = "$SWITCH_DIGEST" ] \
    || fail "the confirmed V2 artifact could not be verified; live install untouched"
  recheck_in_use
  RESULT_PHASE=swapping
  python3 -B "$NIGHTSTAND_SCRIPTS/switch_installation.py" forward --stage "$STAGE" \
    --target-json "$CONFIRMED_TARGET" --artifact-digest "$SWITCH_ACTUAL" --recheck-in-use "$RECHECK_IN_USE"
  SWITCH_STATUS=$?
  if [ "$SWITCH_STATUS" -eq 0 ]; then
    RESULT_PHASE=swapped
    say "SUCCESS: the upstream transaction committed; recovery records and companion state retained"
    exit 0
  fi
  [ "$SWITCH_STATUS" -ne 3 ] || RESULT_PHASE=restored
  fail "the upstream transaction did not complete; see the retained recovery journal"
fi

# Upstream imports this even when the existing services record says installed.
if [ -x /home/dac/venv/bin/python ]; then
  # Upstream leaves this unpinned; keep our revert dependency reproducible.
  # Root never runs the venv. Earlier releases made it as root; hand that one
  # over without following links.
  [ -L /home/dac/venv ] || chown -hR dac:dac /home/dac/venv
  if [ "$(stat -L -c '%U' /home/dac/venv)" != dac ] \
    || ! sudo -u dac /home/dac/venv/bin/python -I -c 'import os,sysconfig; assert all(os.access(sysconfig.get_path(key), os.W_OK) for key in ("purelib", "platlib"))' 2>/dev/null; then
    fail "the server user cannot install into /home/dac/venv; live install untouched"
  fi
  run_limited 600 sudo -H -u dac /home/dac/venv/bin/python -I -m pip install sentry-sdk==2.71.0 \
    || fail "could not install the upstream biometrics dependency; live install untouched"
fi
close_wan

# --- backup --------------------------------------------------------------------
TS=$(date +%Y%m%d-%H%M%S)
BK="$BACKUPS/${TS}_v${CUR_VERSION}_prerevert-to-stock"
say "Backing up code + data to $BK"
mkdir -p "$BK"
tar czf "$BK/code.tar.gz" -C /home/dac --exclude free-sleep/server/node_modules free-sleep || fail "backup failed; aborting, nothing changed"
if [ -f /persistent/free-sleep-data/free-sleep.db ]; then
  DB_BACKUP="$DATABASE_BACKUPS/${TS}_v${CUR_VERSION}_switch.db"
  python3 "$SQLITE_SAFETY" backup /persistent/free-sleep-data/free-sleep.db "$DB_BACKUP" \
    || fail "database backup failed; live install untouched"
  say "Database snapshot kept separately at $DB_BACKUP"
  if [ -f "$PRUNE_SNAPSHOTS" ]; then bash "$PRUNE_SNAPSHOTS" "$DATABASE_BACKUPS" "$DB_BACKUP" || true; fi
fi
cp -r /persistent/free-sleep-data/lowdb "$BK/lowdb" || fail "settings backup failed; live install untouched"
ls -1dt "$BACKUPS"/*/ | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -rf

# --- atomic swap -----------------------------------------------------------------
recheck_in_use
say "Installing upstream free-sleep v$STAGED_VERSION (service stops now)"
# The running server hands back what the next version may not continue.
curl -fsS --max-time 60 -X POST -H 'content-type: application/json' -d '{"reason":"revert"}' \
  http://127.0.0.1:3000/api/update/prepare-to-stop >/dev/null \
  || say "WARNING: the server could not prepare to stop; continuing"
STREAM_WAS_ACTIVE=$(systemctl is-active free-sleep-stream 2>/dev/null || true)
RESTORE_TREE=$PREV
SWAP_NEW=$STAGE
{ stop_writer free-sleep-stream && stop_writer free-sleep && stop_late_stream; } || fail "could not stop the server before converting settings"
RESULT_PHASE=swapping
ARCHIVE_WAS_ACTIVE=$(systemctl is-active free-sleep-archive-raw.timer 2>/dev/null || true)
systemctl stop free-sleep-archive-raw.timer free-sleep-archive-raw.service >/dev/null 2>&1 || true
# Refresh the settings copy after stopping writers, before changing its shape.
cp -rp /persistent/free-sleep-data/lowdb/. "$BK/lowdb/" || {
  systemctl start free-sleep
  [ "$STREAM_WAS_ACTIVE" != active ] || systemctl restart free-sleep-stream
  [ "$ARCHIVE_WAS_ACTIVE" != active ] || systemctl start free-sleep-archive-raw.timer
  RESULT_PHASE=preflight
  fail "could not save the stopped settings; no conversion performed"
}
DATA_CHANGED=yes
python3 "$(dirname "${BASH_SOURCE[0]}")/prepare-upstream.py" /persistent/free-sleep-data/lowdb || {
  restore_switch_data_or_fail "conversion failed; restore settings from $BK/lowdb manually"
  systemctl start free-sleep
  [ "$STREAM_WAS_ACTIVE" != active ] || systemctl restart free-sleep-stream
  RESULT_PHASE=preflight
  fail "could not prepare upstream settings; original settings restored"
}
say "RAW archive retained; remove it manually only if no longer needed:"
du -sh /persistent/free-sleep-data/raw-archive 2>/dev/null || true
rm -rf "$PREV"
move_tree "$LIVE" "$PREV" || {
  restore_switch_data_or_fail "could not restore settings from $BK/lowdb"
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  RESULT_PHASE=restored
  RESULT_REASON="upstream free-sleep could not be put in place, so it never started"
  fail "swap failed moving live aside"
}
move_tree "$STAGE" "$LIVE" || {
  move_tree "$PREV" "$LIVE" || fail "swap failed and previous tree could not be restored; manual recovery required"
  restore_switch_data_or_fail "could not restore settings from $BK/lowdb"
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  RESULT_PHASE=restored
  RESULT_REASON="upstream free-sleep could not be put in place, so it never started"
  fail "swap failed; fork restored"
}
RESULT_PHASE=swapped
MOVED_MODULES=no
if [ "$LOCK_SAME" = yes ]; then
  MOVED_MODULES=yes
  move_tree "$PREV/server/node_modules" "$LIVE/server/node_modules" \
    && chown -hR dac:dac "$LIVE/server/node_modules"
fi

# No prisma step: migrations are additive, so upstream's schema is already
# a strict subset of ours.
systemctl start free-sleep
if [ "$STREAM_WAS_ACTIVE" = active ]; then
  systemctl restart free-sleep-stream 2>/dev/null || true
fi

# Not gated on a populated per-side temperature: it can lag a few read
# cycles after a cold reconnect (see pod-installer.sh's health check).
say "Health check (up to 90s)"
HEALTHY=no
HBODY=$(mktemp) || { say "WARNING: could not create a temporary file for the health check; treating it as failed"; HBODY=; }
[ -z "$HBODY" ] || for _ in $(seq 1 30); do
  sleep 3
  CODE=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/api/deviceStatus" 2>/dev/null || echo 000)
  say "  health attempt: HTTP $CODE"
  [ "$CODE" = 200 ] || continue
  R=$(cat "$HBODY" 2>/dev/null) || continue
  OK=$(printf '%s' "$R" | python3 -I -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert d['freeSleep']['version'] == '$STAGED_VERSION'
    print('yes')
except Exception:
    print('no')" 2>/dev/null)
  [ "$OK" = yes ] && { HEALTHY=yes; break; }
done
[ -z "$HBODY" ] || rm -f "$HBODY"
[ "$HEALTHY" = yes ] && systemctl is-active free-sleep >/dev/null || HEALTHY=no

if [ "$HEALTHY" = yes ]; then
  RESTORE_TREE=
  SWAP_NEW=
  DATA_CHANGED=no
  systemctl disable --now free-sleep-archive-raw.timer >/dev/null 2>&1 || true
  say "SUCCESS: pod is serving upstream free-sleep v$STAGED_VERSION. This fork kept at $PREV (no in-app way back; re-adopt via scripts/migrate/switch-to-this-fork.sh). Backup at $BK"
  # These units point at scripts that no longer exist in $LIVE.
  say "Removing fork-only systemd units (instant rollback, this revert service, the health check, the network watchdog)"
  systemctl disable --now free-sleep-health.timer free-sleep-network-watchdog.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/free-sleep-rollback.service /etc/systemd/system/free-sleep-revert.service \
    /etc/systemd/system/free-sleep-archive-raw.service /etc/systemd/system/free-sleep-archive-raw.timer \
    /etc/systemd/system/free-sleep-health.service /etc/systemd/system/free-sleep-health.timer \
    /etc/systemd/system/free-sleep-network-watchdog.service /etc/systemd/system/free-sleep-network-watchdog.timer
  systemctl disable --now free-sleep-recover-update.timer free-sleep-recover-update.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/free-sleep-recover-update.service /etc/systemd/system/free-sleep-recover-update.timer
  if ! has_switch_journal; then
    systemctl disable --now free-sleep-recover-switch.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/free-sleep-recover-switch.service
    for unit in free-sleep.service free-sleep-stream.service free-sleep-archive-raw.service \
      free-sleep-health.service free-sleep-network-watchdog.service free-sleep-recover-update.service \
      free-sleep-update.service free-sleep-rollback.service free-sleep-revert.service free-sleep-migrate.service; do
      rm -f "/etc/systemd/system/$unit.d/nightstand-switch-recovery.conf"
    done
    rm -rf /usr/local/lib/nightstand/switch-recovery /home/dac/free-sleep-switch-recovery
  fi
  rm -rf /usr/local/lib/nightstand/recovery /home/dac/free-sleep-recovery
  rm -f /persistent/free-sleep-data/update-swap.json
  sync
  # Upstream free-sleep never installs these. They take effect at the next service start.
  rm -f /etc/systemd/system/free-sleep.service.d/10-nightstand-limits.conf \
    /etc/systemd/system/free-sleep.service.d/20-nightstand-restart.conf \
    /etc/systemd/system/free-sleep-stream.service.d/10-nightstand-limits.conf
  systemctl daemon-reload >/dev/null 2>&1 || true
  # Upstream never turns on the hardware watchdog; take Nightstand's setting out.
  if [ -f "$NIGHTSTAND_SCRIPTS/setup_watchdog.sh" ]; then
    bash "$NIGHTSTAND_SCRIPTS/setup_watchdog.sh" --remove --switching || say "WARNING: could not remove the hardware watchdog setting"
  fi
  exit 0
fi

# --- automatic rollback to this fork ---------------------------------------------

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

[ -n "${RESULT_REASON:-}" ] || RESULT_REASON="upstream free-sleep did not pass its health check"
say "Health check FAILED: rolling back to this fork v$CUR_VERSION"
say "Last 60 server log lines from the failed upstream free-sleep build (for diagnosis):"
tail -n 60 /persistent/free-sleep-data/logs/free-sleep.log 2>/dev/null || say "  (no server log available)"
RESTORE_TREE=$PREV
# Nothing moves and no settings are put back under a writer that will not
# stop: upstream free-sleep keeps running on the settings it was given, and
# both trees and the backup stay where they are.
if ! stop_writer free-sleep || ! stop_writer free-sleep-stream; then
  RESTORE_TREE=
  DATA_CHANGED=no
  systemctl is-active free-sleep >/dev/null 2>&1 || systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ] && ! systemctl is-active free-sleep-stream >/dev/null 2>&1; then
    systemctl start free-sleep-stream
  fi
  fail "revert to upstream free-sleep failed and a service did not stop, so this fork was not put back. It is kept at $PREV; its settings are in $BK/lowdb. Manual recovery required"
fi
rm -rf "$FAILED"
SWAP_NEW=
move_tree "$LIVE" "$FAILED" || {
  restore_switch_data_or_fail "could not restore settings from $BK/lowdb"
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  fail "could not move failed tree aside; attempted to restart the tree at $LIVE; manual recovery required"
}
move_tree "$PREV" "$LIVE" || {
  move_tree "$FAILED" "$LIVE" || fail "could not restore either tree; manual recovery required"
  restore_switch_data_or_fail "could not restore settings from $BK/lowdb"
  systemctl start free-sleep
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream 2>/dev/null || true
  fi
  fail "could not restore previous tree; attempted to restart the tree at $LIVE; manual recovery required"
}
RESULT_PHASE=restored
if [ "$MOVED_MODULES" = yes ]; then
  move_tree "$FAILED/server/node_modules" "$LIVE/server/node_modules"
fi
restore_switch_data_or_fail "could not restore settings from $BK/lowdb"
sh "$NIGHTSTAND_SCRIPTS/block_internet_access.sh" || say "WARNING: restored firewall could not be applied"
systemctl start free-sleep
if [ "$STREAM_WAS_ACTIVE" = active ]; then
  systemctl restart free-sleep-stream 2>/dev/null || true
fi
RESTORE_TREE=
if restored_version_answers; then
  fail "revert to upstream free-sleep failed but rollback OK (pod back on this fork v$CUR_VERSION). Failed tree kept at $FAILED; see journalctl -u free-sleep"
else
  RESULT_PHASE=swapped
  fail "revert to upstream free-sleep failed AND rollback health check failed. Backup tarball: $BK. Check journalctl -u free-sleep. Schedules and alarms remain unavailable until the server is restored."
fi
