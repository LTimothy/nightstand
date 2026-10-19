#!/usr/bin/env bash
# Deploy the committed HEAD of this repo to the pod, with backup, staged
# dependency install, atomic swap, health check, and automatic rollback.
#
# Usage: ops/deploy.sh [--check] [--force]
#   --check   run preflight checks only, deploy nothing
#   --force   deploy even if a bed side is on or the git tree is dirty
#
# Auth: uses key auth if available, else sshpass with the password from
# $POD_PASSWORD or ~/.config/free-sleep/pod.pass (never committed).
set -euo pipefail

# Pod connection. By default, reach the pod at its stock mDNS name
# (eight-pod.local, advertised on the LAN by the firmware's avahi) over the known
# ssh user/port, so a fresh clone deploys with no configuration. Set POD_HOST to
# your own ssh target (an alias, or user@host) to override; it then carries its
# own user/port and POD_USER/POD_PORT are ignored.
POD_USER="${POD_USER:-root}"
POD_PORT="${POD_PORT:-8822}"
if [ -n "${POD_HOST:-}" ]; then
  # User-provided ssh target: it carries its own user/port/known_hosts config.
  POD="$POD_HOST"; SSH_CONN=""; SCP_CONN=""
else
  # Zero-config default: the stock mDNS name with the known user/port. accept-new
  # records the pod's host key on first contact but still rejects a changed key.
  POD="${POD_USER}@eight-pod.local"
  SSH_CONN="-p $POD_PORT -o StrictHostKeyChecking=accept-new"
  SCP_CONN="-P $POD_PORT -o StrictHostKeyChecking=accept-new"
fi
# $SSH_CONN/$SCP_CONN are used unquoted so an empty value expands to nothing
# (bash 3.2 has no clean empty-array expansion under set -u).
POD_SSH_HINT="ssh${SSH_CONN:+ $SSH_CONN} $POD"

# Health checks use HTTP, not ssh, so they need a routable host. Prefer an
# explicit POD_IP; else the ssh config's HostName for $POD (covers a user alias);
# else the pod's mDNS name.
if [ -z "${POD_IP:-}" ]; then
  POD_IP=$(ssh -G "$POD" 2>/dev/null | awk '/^hostname /{print $2; exit}')
  case "${POD_IP:-}" in ""|"$POD") POD_IP="eight-pod.local" ;; esac
fi
LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
STAGE=/home/dac/free-sleep-staging
BACKUPS=/persistent/free-sleep-backups
KEEP_BACKUPS=5
NPM=/home/dac/.volta/bin/npm
NPX=/home/dac/.volta/bin/npx

CHECK_ONLY=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown arg: $arg"; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

# --- ssh helper -------------------------------------------------------------
# SCP_SHIP carries the one big transfer: it adds its own stall detection, so a
# wedged attempt fails in ~30s instead of waiting out the pod's ~75s, and a
# rate limit (see "ship HEAD to staging" below for why). Options have to sit
# before the destination, which ssh otherwise reads as the remote command.
SHIP_OPTS=(-o ServerAliveInterval=10 -o ServerAliveCountMax=3)
SHIP_RATE_KBIT="${SHIP_RATE_KBIT:-24000}"
if ssh -o BatchMode=yes -o ConnectTimeout=5 $SSH_CONN "$POD" true 2>/dev/null; then
  SSH() { ssh $SSH_CONN "$POD" "$@"; }
  SCP_SHIP() { scp "${SHIP_OPTS[@]}" $SCP_CONN -l "$SHIP_RATE_KBIT" "$1" "$POD:$2"; }
else
  PASS="${POD_PASSWORD:-$(cat "$HOME/.config/free-sleep/pod.pass" 2>/dev/null || true)}"
  [ -n "$PASS" ] || die "no key auth and no password: set POD_PASSWORD or ~/.config/free-sleep/pod.pass"
  command -v sshpass >/dev/null || die "sshpass not installed (brew install sshpass)"
  SSH() { sshpass -p "$PASS" ssh $SSH_CONN "$POD" "$@"; }
  SCP_SHIP() { sshpass -p "$PASS" scp "${SHIP_OPTS[@]}" $SCP_CONN -l "$SHIP_RATE_KBIT" "$1" "$POD:$2"; }
fi

# --- preflight: local -------------------------------------------------------
cd "$(dirname "$0")/.."
[ -f server/src/serverInfo.json ] || die "must run from repo root"
git cat-file -e HEAD:server/dist/server.js 2>/dev/null || die "server/dist/server.js missing from HEAD - commit a build first"
git cat-file -e HEAD:server/public/index.html 2>/dev/null || die "server/public/index.html missing from HEAD - commit an app build first"

VERSION=$(git show HEAD:server/src/serverInfo.json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["version"])')
COMMIT=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain)" ] && [ "$FORCE" -ne 1 ]; then
  die "git tree is dirty; commit your changes or use --force (deploys HEAD, not the working tree)"
fi

# The pod runs the committed bundles, so a bundle is stale when the newest
# source commit is not an ancestor of the newest bundle commit.
bundle_behind() {
  local bundle=$1 source built
  shift
  source=$(git log -1 --format=%H -- "$@")
  [ -n "$source" ] || return 1
  built=$(git log -1 --format=%H -- "$bundle")
  [ -z "$built" ] || ! git merge-base --is-ancestor "$source" "$built"
}

if [ "$FORCE" -ne 1 ]; then
  if bundle_behind server/public app ':(exclude)app/e2e' ':(exclude)app/src/mocks' \
    ':(exclude,glob)**/*.test.ts' ':(exclude,glob)**/*.test.tsx' ':(exclude,glob)**/*.md'; then
    die "the committed app bundle is older than app/; run npm ci && npm run build:pr in app/ and commit (or use --force)"
  fi
  if bundle_behind server/dist server/src; then
    die "the committed server build is older than server/src; run npm ci && npm run build:pr in server/ and commit (or use --force)"
  fi
  bash scripts/check-bundles.sh || die "orphaned bundle files are committed; remove the files listed above and commit (or use --force)"
fi

# --- preflight: pod ---------------------------------------------------------
say "Preflight: pod state"
# Quoted, so nothing below expands here; it runs as is on the pod with the
# install path and the Node version HEAD pins as its arguments.
NODE_PIN=$(git show HEAD:server/package.json | python3 -I -c 'import json, sys; print(json.load(sys.stdin).get("volta", {}).get("node", ""))')
SSH "bash -s -- $LIVE $NODE_PIN" <<'PREFLIGHT' || die "pod preflight failed"
LIVE=$1
[ -d "$LIVE" ] || { echo 'NO_LIVE_INSTALL'; exit 1; }
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
# Same writes as update.sh, sized from the install this replaces. On /: the
# shipped tar and its unpacked tree, a fresh node_modules plus a third of
# that again for npm's and Prisma's caches (68 and 33 MB from empty for
# 330 MB), and a Node that Volta must fetch. On /persistent: the code backup
# (counted unpacked), the database copy and the settings copy, plus half the
# database again for migrations, which only ever add.
MODULES_MB=$(size_mb "$LIVE/server/node_modules")
TREE_MB=$(( $(size_mb "$LIVE") - MODULES_MB ))
DB_MB=$(size_mb /persistent/free-sleep-data/free-sleep.db /persistent/free-sleep-data/free-sleep.db-wal)
ROOT_NEED=$(( 2 * TREE_MB + MODULES_MB + MODULES_MB / 3 + $(node_fetch_mb "${2:-}" "$(node_pin "$LIVE")") + SPACE_MARGIN_MB ))
PERS_NEED=$(( TREE_MB + DB_MB + DB_MB / 2 + $(size_mb /persistent/free-sleep-data/lowdb) + SPACE_MARGIN_MB ))
ROOT_FREE=$(free_mb /)
PERS_FREE=$(free_mb /persistent)
[ "${ROOT_FREE:-0}" -ge "$ROOT_NEED" ] || { echo "LOW_DISK_ROOT: ${ROOT_FREE:-unknown}M free, ${ROOT_NEED}M needed"; exit 1; }
[ "${PERS_FREE:-0}" -ge "$PERS_NEED" ] \
  || { echo "LOW_DISK_PERSISTENT: ${PERS_FREE:-unknown}M free, ${PERS_NEED}M needed; old snapshots in /persistent/free-sleep-database-backups/ can be removed to make room"; exit 1; }
systemctl is-active free-sleep-update.service >/dev/null 2>&1 && { echo 'UPDATE_SERVICE_RUNNING'; exit 1; }
echo "disk ok (/ ${ROOT_FREE}M free, ${ROOT_NEED}M needed; /persistent ${PERS_FREE}M free, ${PERS_NEED}M needed)"
PREFLIGHT

STATUS_JSON=$(curl -sf --max-time 10 "http://$POD_IP:3000/api/deviceStatus") || die "current server not answering; investigate before deploying (ops/rollback.sh or journalctl -u free-sleep)"
POD_VERSION=$(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["freeSleep"]["version"])')
BED_IN_USE=$(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("yes" if d["left"]["isOn"] or d["right"]["isOn"] else "no")')
say "Pod is running v$POD_VERSION; deploying v$VERSION ($COMMIT); bed in use: $BED_IN_USE"
if [ "$BED_IN_USE" = "yes" ] && [ "$FORCE" -ne 1 ]; then
  die "a bed side is ON - schedules/alarms pause during deploy. Re-run with --force to proceed anyway."
fi

[ "$CHECK_ONLY" -eq 1 ] && { say "--check passed; nothing deployed"; exit 0; }

# --- backup -----------------------------------------------------------------
TS=$(date +%Y%m%d-%H%M%S)
BK="$BACKUPS/${TS}_v${POD_VERSION}"
say "Backing up code + data to $BK"
SSH "set -e
  mkdir -p '$BK'
  tar czf '$BK/code.tar.gz' -C /home/dac --exclude free-sleep/server/node_modules free-sleep
  cp -r /persistent/free-sleep-data/lowdb '$BK/lowdb'
" || die "backup failed - aborting, nothing changed"
# A raw copy of a live WAL database can be torn or miss committed rows. This
# checkout's helper, read from stdin, takes a consistent snapshot.
SSH "[ ! -f /persistent/free-sleep-data/free-sleep.db ] || python3 -I - backup /persistent/free-sleep-data/free-sleep.db '$BK/free-sleep.db'" < scripts/sqlite-safety.py \
  || die "database backup failed - aborting, nothing changed"
SSH "ls -1dt $BACKUPS/*/ | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -rf"

# --- ship HEAD to staging ---------------------------------------------------
# When the deploy host and the pod are both Wi-Fi stations on the same subnet,
# they never talk directly: the access point receives each frame on its radio
# and resends it on that same radio. A sustained upload between two stations
# therefore burns twice the airtime an ordinary download does, and the relay
# gives out well below line rate. Past that point the path wedges rather than
# slowing down, and the transfer eventually dies with "Connection closed by
# remote host" once the pod's sshd has waited out ClientAliveInterval 15 x
# ClientAliveCountMax 4. Measured on one such link: 36 MB lands in 8.7s at
# 4 MB/s, while 6 MB/s and up hang every time. Plain scp and an unrelated HTTP
# pull fail identically, and the pod pulls the same 36 MB from the internet at
# 16 MB/s, so neither the pod, ssh, nor the tree is at fault. Only the relayed
# station-to-station leg is.
#
# So: pace the upload under the cliff instead of letting TCP discover it, keep
# each attempt's own stall detection (fail in ~30s, not the pod's ~75s), retry,
# and confirm the staged tree arrived whole, because a truncated transfer must
# never reach the swap. Raise SHIP_RATE_KBIT on a wired link, where none of
# this applies.
SHIP_ATTEMPTS=4
# Shipped and unpacked where only root can write, so the server user cannot
# swap the tree before root copies its scripts.
SYSTEM_DIR=/usr/local/lib/nightstand
SHIP_DIR=
# The same move_tree as the pod scripts, for the commands run there over SSH.
MOVE_TREE='move_tree() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  move_mark=$(mktemp "$1/.moving.XXXXXX") || return 1
  mv -T "$1" "$2" 2>/dev/null \
    || { [ -d "$1" ] && [ ! -e "$2" ] && [ ! -L "$2" ] && mv "$1" "$2"; } \
    || { [ -d "$1" ] && [ ! -L "$1" ] && rm -f "$1/${move_mark##*/}"; return 1; }
  [ -d "$2" ] && [ ! -L "$2" ] && [ -f "$2/${move_mark##*/}" ] && rm -f "$2/${move_mark##*/}"
}
'
ship_to_stage() {
  local tarball="$1"
  attempt=1
  while [ "$attempt" -le "$SHIP_ATTEMPTS" ]; do
    [ -z "$SHIP_DIR" ] || SSH "rm -rf $SHIP_DIR"
    SHIP_DIR=$(SSH "mkdir -p $SYSTEM_DIR && mktemp -d $SYSTEM_DIR/.download.XXXXXX") || { attempt=$((attempt+1)); continue; }
    if SCP_SHIP "$tarball" "$SHIP_DIR/ship.tar"; then
      if SSH "mkdir $SHIP_DIR/tree && tar -x -C $SHIP_DIR/tree -f $SHIP_DIR/ship.tar && rm -f $SHIP_DIR/ship.tar \
              && [ -s $SHIP_DIR/tree/server/dist/server.js ] && [ -s $SHIP_DIR/tree/server/public/index.html ]"; then
        [ "$attempt" -gt 1 ] && say "staging ship succeeded on attempt $attempt"
        return 0
      fi
      say "staging ship attempt $attempt arrived incomplete"
    else
      say "staging ship attempt $attempt stalled (the link to the pod, not the tree)"
    fi
    attempt=$((attempt+1))
    [ "$attempt" -le "$SHIP_ATTEMPTS" ] && sleep 3
  done
  [ -z "$SHIP_DIR" ] || SSH "rm -rf $SHIP_DIR"
  return 1
}

say "Shipping git HEAD to staging (paced at ${SHIP_RATE_KBIT} Kbit/s)"
SHIP_TAR=$(mktemp -t nightstand-ship)
trap 'rm -f "$SHIP_TAR"' EXIT
git archive HEAD -o "$SHIP_TAR"
ship_to_stage "$SHIP_TAR" || die "staging ship failed after $SHIP_ATTEMPTS attempts; nothing was changed on the pod"
rm -f "$SHIP_TAR"; trap - EXIT
# Root runs a root-owned copy of these scripts, taken before the tree moves
# to the stage the server user owns.
COPY=$(SSH "python3 -B $SHIP_DIR/tree/scripts/system_scripts.py publish $SHIP_DIR/tree") \
  || { SSH "rm -rf $SHIP_DIR"; die "could not copy the scripts root runs on the pod; live install untouched"; }
SSH "$MOVE_TREE rm -rf $STAGE && move_tree $SHIP_DIR/tree $STAGE && rm -rf $SHIP_DIR && chown -hR dac:dac $STAGE" \
  || die "could not move the shipped tree to $STAGE; live install untouched"

# --- dependencies (while old server still runs) ------------------------------
# As in scripts/update.sh, only HTTPS and name lookups go out while npm and
# Volta download, and the rest of the firewall, including the reset on the
# firmware's upload port, stays as it is. Volta fetches a newly pinned Node the
# first time npm runs under it, so that happens here too rather than at the
# first start after the swap.
deps_failed() {
  SSH "bash $COPY/scripts/close_update_window.sh" ||
    echo "WARNING: could not reach the pod to close the download window; run scripts/close_update_window.sh on it"
  SSH "rm -rf $STAGE"
  die "dependency download failed; staging discarded, live untouched, internet blocked again"
}
LOCK_SAME=$(SSH "cmp -s $LIVE/server/package-lock.json $STAGE/server/package-lock.json && echo yes || echo no")
NODE_MISSING=$(SSH "[ -n '$NODE_PIN' ] && [ ! -d /home/dac/.volta/tools/image/node/$NODE_PIN ] && echo yes || echo no")
if [ "$LOCK_SAME" = "no" ] || [ "$NODE_MISSING" = "yes" ]; then
  say "Downloading dependencies in staging (HTTPS and DNS allowed out meanwhile)"
  SSH "bash -s -- $STAGE $NPM $LOCK_SAME $COPY" <<'DEPS' || deps_failed
STAGE=$1; NPM=$2; LOCK_SAME=$3; COPY=$4
WAN_OPEN=no
say() { echo "$*"; }
source "$COPY/scripts/restore_helpers.sh" || exit 1
init_update_firewall
trap 'trap "" HUP INT TERM; close_wan' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
open_wan
if [ "$LOCK_SAME" = no ]; then
  run_limited 900 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' install --no-audit --no-fund" || exit 1
fi
run_limited 600 sudo -u dac bash -c "cd '$STAGE/server' && '$NPM' --version" >/dev/null || exit 1
DEPS
else
  say "package-lock.json unchanged and Node already present: will reuse existing node_modules"
fi

# --- atomic swap ------------------------------------------------------------
say "Swapping (service stops now)"
MOVED_MODULES=no
# Under the lock the updater, the rollback and the switch take, from root's copy.
SWAP_STATUS=0
SSH "bash -s -- $COPY $STAGE $LIVE $PREV" <<'SWAP' || SWAP_STATUS=$?
set -e
COPY=$1; STAGE=$2; LIVE=$3; PREV=$4
say() { echo "$*"; }
source "$COPY/scripts/restore_helpers.sh"
take_operation_lock || { [ $? -eq 2 ] && exit 75; exit 1; }
systemctl stop free-sleep
rm -rf "$PREV"
move_tree "$LIVE" "$PREV" || { systemctl start free-sleep; exit 1; }
move_tree "$STAGE" "$LIVE" || { move_tree "$PREV" "$LIVE"; systemctl start free-sleep; exit 1; }
SWAP
[ "$SWAP_STATUS" -ne 75 ] || die "an update, rollback or switch is running on the pod; nothing was swapped. Try again when it has finished."
[ "$SWAP_STATUS" -eq 0 ] || die "swap failed - pod may need manual attention: $POD_SSH_HINT, check $LIVE/$PREV/$STAGE"
if [ "$LOCK_SAME" = "yes" ]; then
  SSH "$MOVE_TREE move_tree $PREV/server/node_modules $LIVE/server/node_modules && chown -hR dac:dac $LIVE/server/node_modules"
  MOVED_MODULES=yes
fi

# prisma: apply any unapplied migrations (DB already backed up); regenerate the
# client if the schema changed. Whether to migrate comes from what the database
# is missing, not from a schema.prisma diff against the previous deploy, which
# cannot see a database an earlier update left half-migrated. migrate status
# exits non-zero exactly when a migration in this tree is unapplied, and reads
# a database that is ahead of this code as up to date, so deploying an older
# commit leaves the schema alone.
#
# It is a read, so it works while the biometrics streamer holds the file. The
# write is what the streamer's connection blocks: that is how a release once
# shipped with its new tables missing, because the failure was a warning and
# the health check below cannot see a missing table.
STREAM_WAS_ACTIVE=$(SSH "systemctl is-active free-sleep-stream 2>/dev/null || true")
MIGRATION_FAILED=no
SCHEMA_CHANGED=no
SSH "cmp -s $PREV/server/prisma/schema.prisma $LIVE/server/prisma/schema.prisma" || SCHEMA_CHANGED=yes
if ! SSH "sudo -u dac bash -c 'cd $LIVE/server && $NPX dotenv -e .env.pod -- npx prisma migrate status' >/dev/null 2>&1"; then
  say "Database has unapplied migrations: migrate deploy + generate"
  SSH "systemctl stop free-sleep-stream 2>/dev/null || true"
  PRISMA_OK=no
  for attempt in 1 2 3; do
    if SSH "sudo -u dac bash -c 'cd $LIVE/server && $NPX dotenv -e .env.pod -- npx prisma migrate deploy'"; then
      PRISMA_OK=yes
      break
    fi
    echo "  prisma migrate attempt $attempt failed"
    sleep 5
  done
  [ "$PRISMA_OK" = "yes" ] &&
    { SSH "sudo -u dac bash -c 'cd $LIVE/server && $NPX dotenv -e .env.pod -- npx prisma generate'" || PRISMA_OK=no; }
  # Assert the end state rather than trusting the exit code: migrate status
  # fails when anything is still pending, which is the exact condition that
  # nothing downstream of here is able to notice.
  [ "$PRISMA_OK" = "yes" ] &&
    { SSH "sudo -u dac bash -c 'cd $LIVE/server && $NPX dotenv -e .env.pod -- npx prisma migrate status'" || PRISMA_OK=no; }
  [ "$PRISMA_OK" = "yes" ] || MIGRATION_FAILED=yes
elif [ "$SCHEMA_CHANGED" = "yes" ]; then
  # node_modules may have been carried over from the previous deploy, with its
  # generated client, so a schema change with nothing to migrate still needs one.
  say "Prisma schema changed with nothing to migrate: generate"
  SSH "sudo -u dac bash -c 'cd $LIVE/server && $NPX dotenv -e .env.pod -- npx prisma generate'" \
    || MIGRATION_FAILED=yes
fi

# Same as update.sh: before the start below, so the limits apply to it.
SSH "[ ! -f $COPY/scripts/setup_resource_limits.sh ] || bash $COPY/scripts/setup_resource_limits.sh" \
  || say "WARNING: failed to install service memory limits"

SSH "systemctl start free-sleep"
# jmew's biometrics stream service runs out of the same tree; if it's active,
# bounce it so it picks up the swapped code instead of holding stale handles.
# Plain restart when it was running before, since the prisma step above may
# have stopped it and try-restart would leave a stopped unit stopped.
if [ "$STREAM_WAS_ACTIVE" = "active" ]; then
  SSH "systemctl restart free-sleep-stream 2>/dev/null || true"
else
  SSH "systemctl try-restart free-sleep-stream 2>/dev/null || true"
fi

# --- health check -----------------------------------------------------------
say "Health check (up to 90s)"
HEALTHY=no
HBODY=$(mktemp)
for i in $(seq 1 30); do
  sleep 3
  # Log every attempt's HTTP status so a failed run shows the shape of the
  # failure on its own (000 = no/aborted response, 503 = still starting).
  CODE=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 5 "http://$POD_IP:3000/api/deviceStatus" 2>/dev/null || echo 000)
  echo "  health attempt $i: HTTP $CODE"
  [ "$CODE" = "200" ] || continue
  R=$(cat "$HBODY" 2>/dev/null) || continue
  OK=$(printf '%s' "$R" | python3 -I -c "
import json,sys
try:
    d=json.load(sys.stdin)
    assert d['freeSleep']['version']=='$VERSION'
    assert isinstance(d['left']['currentTemperatureF'],(int,float))
    print('yes')
except Exception:
    print('no')" 2>/dev/null)
  [ "$OK" = "yes" ] && { HEALTHY=yes; break; }
done
rm -f "$HBODY"

if [ "$HEALTHY" = "yes" ]; then
  SSH "systemctl is-active free-sleep >/dev/null" || HEALTHY=no
fi

# A pod serving HTTP 200 against a half-applied schema looks healthy and is not.
if [ "$MIGRATION_FAILED" = "yes" ]; then
  echo "  prisma migrations did not apply; failing the deploy so it rolls back"
  HEALTHY=no
fi

if [ "$HEALTHY" = "yes" ]; then
  # Root runs the new copy from now on, with the units and rules it needs.
  SSH "bash $COPY/scripts/setup_services.sh $COPY" \
    || say "WARNING: some services or sudoers rules could not be installed; the next in-app update retries them"
  say "SUCCESS: pod is serving v$VERSION ($COMMIT). Previous version kept at $PREV; backup at $BK"
  exit 0
fi

# --- automatic rollback -----------------------------------------------------
printf '\033[1;31m==> Health check FAILED - rolling back to v%s\033[0m\n' "$POD_VERSION"
say "Last 60 server log lines from the failed build (for diagnosis)"
SSH "tail -n 60 /persistent/free-sleep-data/logs/free-sleep.log 2>/dev/null" || echo "  (no server log available)"
SSH "set -e
  $MOVE_TREE
  systemctl stop free-sleep || true
  rm -rf /home/dac/free-sleep-failed
  move_tree $LIVE /home/dac/free-sleep-failed || { systemctl start free-sleep; exit 1; }
  move_tree $PREV $LIVE || { move_tree /home/dac/free-sleep-failed $LIVE; systemctl start free-sleep; exit 1; }
  if [ '$MOVED_MODULES' = yes ]; then move_tree /home/dac/free-sleep-failed/server/node_modules $LIVE/server/node_modules; fi
  systemctl start free-sleep
"
sleep 8
if curl -sf --max-time 5 "http://$POD_IP:3000/api/deviceStatus" >/dev/null; then
  die "deploy failed but ROLLBACK OK (pod back on v$POD_VERSION). Failed tree kept at /home/dac/free-sleep-failed; logs: $POD_SSH_HINT journalctl -u free-sleep -n 100"
else
  die "deploy failed AND rollback health check failed. SSH in: journalctl -u free-sleep -n 100. Backup tarball: $BK. Bed hardware itself keeps running regardless."
fi
