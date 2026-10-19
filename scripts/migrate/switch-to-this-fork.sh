#!/bin/bash
# Laptop-side half of the fork-switch tool. For someone running
# throwaway31265 (upstream), jmew, or another fork
# on their own pod, who wants to move to LTimothy/nightstand.
#
# The tool stages the replacement and keeps backups of the current install.
# A timed restore attempts to bring back that install if migration stops.
# It does not modify Eight Sleep's firmware files; it does block the Pod's
# internet access. Schedules and alarms pause while the server is stopped.
# Recovery can still require SSH or a firmware reset. See ops/ANTIBRICK.md.
# Keep the backup and confirm the controls work after migration completes.
#
# Read this script before running it. It requires typed confirmation before
# changing the Pod. Run with --dry-run first to inspect the migration report
# without changing the Pod.
# Dry-run still reads the current install over SSH.
#
# Usage:
#   switch-to-this-fork.sh [--ip <addr>] [--dry-run] [--assume-model podN]
#                           [--migrate-anyway]
#   switch-to-this-fork.sh --restore <backup-tarball> [--ip <addr>]
#   switch-to-this-fork.sh --help
#
# Pod-generation and bed-in-use warnings always require a typed
# acknowledgment interactively, there is no flag to skip them.
#
# Requires only curl/ssh/scp/tar on the laptop (macOS + Linux). sshpass is
# used if present but never required.
set -uo pipefail

# --- args ----------------------------------------------------------------
IP=""
DRY_RUN=no
ASSUME_MODEL=""
MIGRATE_ANYWAY=no
RESTORE_TARBALL=""
RELEASES_URL="https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json"

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \?//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=yes; shift ;;
    --assume-model) ASSUME_MODEL="$2"; shift 2 ;;
    --migrate-anyway) MIGRATE_ANYWAY=yes; shift ;;
    --restore) RESTORE_TARBALL="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo "" >&2; echo "ABORTED: $*" >&2; exit 1; }

SSH_USER=root
SSH_PASS=""
SSH_PORT=""
POD_IP=""

# Wraps ssh/scp so callers don't repeat -p/-o/sshpass plumbing. Password is
# read once (stage 2) and held only in memory for this process, never
# stored, never echoed, never logged.
ssh_cmd() {
  local port="$1"; shift
  if command -v sshpass >/dev/null 2>&1 && [ -n "$SSH_PASS" ]; then
    sshpass -p "$SSH_PASS" ssh -p "$port" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "$SSH_USER@$POD_IP" "$@"
  else
    ssh -p "$port" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 "$SSH_USER@$POD_IP" "$@"
  fi
}

scp_to_pod() {
  local port="$1" src="$2" dest="$3"
  if command -v sshpass >/dev/null 2>&1 && [ -n "$SSH_PASS" ]; then
    sshpass -p "$SSH_PASS" scp -P "$port" -o StrictHostKeyChecking=accept-new -r "$src" "$SSH_USER@$POD_IP:$dest"
  else
    scp -P "$port" -o StrictHostKeyChecking=accept-new -r "$src" "$SSH_USER@$POD_IP:$dest"
  fi
}

# The pod is a single-core ARM box guarded by a 31s hardware watchdog
# (mtk-wdt). Serving a multi-tens-of-MB backup over encrypted scp at full tilt
# can saturate the core long enough to starve the watchdog-petter and force a
# reboot mid-pull. Cap the transfer rate so scp always leaves the core headroom
# (-l is in Kbit/s; 16000 ≈ 2 MB/s, so even a 60MB backup finishes in ~30s at
# low CPU) and disable scp's own compression, the tarball is already gzipped,
# so it would only burn CPU for nothing.
POD_PULL_LIMIT_KBIT=16000
scp_from_pod() {
  local port="$1" src="$2" dest="$3"
  if command -v sshpass >/dev/null 2>&1 && [ -n "$SSH_PASS" ]; then
    sshpass -p "$SSH_PASS" scp -P "$port" -l "$POD_PULL_LIMIT_KBIT" -o Compression=no -o StrictHostKeyChecking=accept-new "$SSH_USER@$POD_IP:$src" "$dest"
  else
    scp -P "$port" -l "$POD_PULL_LIMIT_KBIT" -o Compression=no -o StrictHostKeyChecking=accept-new "$SSH_USER@$POD_IP:$src" "$dest"
  fi
}

# ==============================================================================
# --restore mode: pushes a laptop-side backup tarball back and re-swaps.
# Works even against a pod whose free-sleep layer is entirely dead, it only
# needs SSH. A fallback for when the in-app rollback button can't be used.
# ==============================================================================
if [ -n "$RESTORE_TARBALL" ]; then
  [ -f "$RESTORE_TARBALL" ] || fail "backup tarball not found: $RESTORE_TARBALL"
  [ -n "$IP" ] || fail "--restore requires --ip <addr> (the pod may not be resolvable by hostname if its layer is down)"
  POD_IP="$IP"
  echo "This will push $RESTORE_TARBALL to $POD_IP and restore it over whatever is at /home/dac/free-sleep."
  read -r -p "Type 'restore' to proceed: " CONFIRM
  [ "$CONFIRM" = "restore" ] || fail "confirmation not given"
  read -r -s -p "SSH password for root@$POD_IP: " SSH_PASS; echo
  for port in 8822 22; do
    if ssh_cmd "$port" "true" 2>/dev/null; then SSH_PORT="$port"; break; fi
  done
  [ -n "$SSH_PORT" ] || fail "could not reach $POD_IP over SSH on port 8822 or 22"
  say "Pushing backup tarball..."
  { ssh_cmd "$SSH_PORT" "mkdir -p /usr/local/lib/nightstand" \
    && scp_to_pod "$SSH_PORT" "$RESTORE_TARBALL" "/usr/local/lib/nightstand/free-sleep-restore.tar.gz"; } \
    || fail "could not upload backup; live install untouched"
  say "Extracting and restarting..."
  # The same move_tree as the pod scripts.
  MOVE_TREE='move_tree() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  move_mark=$(mktemp "$1/.moving.XXXXXX") || return 1
  mv -T "$1" "$2" 2>/dev/null \
    || { [ -d "$1" ] && [ ! -e "$2" ] && [ ! -L "$2" ] && mv "$1" "$2"; } \
    || { [ -d "$1" ] && [ ! -L "$1" ] && rm -f "$1/${move_mark##*/}"; return 1; }
  [ -d "$2" ] && [ ! -L "$2" ] && [ -f "$2/${move_mark##*/}" ] && rm -f "$2/${move_mark##*/}"
}
'
  # Unpacked where only root can write, so the server user cannot swap it.
  ssh_cmd "$SSH_PORT" "
    set -eu
    $MOVE_TREE
    LIVE=/home/dac/free-sleep
    STAGE=\$(mktemp -d /usr/local/lib/nightstand/.restore.XXXXXX)
    report_restore_tree() {
      if [ -d \"\$STAGE/previous\" ]; then
        du -sh \"\$STAGE/previous\"
        echo \"After confirming the restored install works, remove \$STAGE/previous to reclaim this space.\"
      else
        rm -rf \"\$STAGE\"
      fi
    }
    trap report_restore_tree EXIT
    tar xzf /usr/local/lib/nightstand/free-sleep-restore.tar.gz -C \"\$STAGE\"
    [ -f \"\$STAGE/free-sleep/server/dist/server.js\" ] &&
      [ -f \"\$STAGE/free-sleep/server/public/index.html\" ] &&
      [ -f \"\$STAGE/free-sleep/server/package.json\" ] &&
      [ -d \"\$STAGE/free-sleep/server/node_modules\" ] &&
      [ -n \"\$(ls -A \"\$STAGE/free-sleep/server/node_modules\")\" ] || {
        echo 'Backup is incomplete or lacks installed dependencies; live install untouched. Use the rollback in the app (Settings > Software > Recovery) if available, or supply a complete backup created with the current migration script.' >&2
        exit 1
      }
    chown -hR dac:dac \"\$STAGE/free-sleep\"
    STREAM_WAS_ACTIVE=\$(systemctl is-active free-sleep-stream 2>/dev/null || true)
    restart_services() {
      systemctl start free-sleep || return 1
      if [ \"\$STREAM_WAS_ACTIVE\" = active ]; then
        systemctl restart free-sleep-stream || return 1
      fi
    }
    systemctl stop free-sleep-stream 2>/dev/null || true
    systemctl stop free-sleep 2>/dev/null || true
    if [ -e \"\$LIVE\" ]; then
      move_tree \"\$LIVE\" \"\$STAGE/previous\" || { restart_services; exit 1; }
    fi
    move_tree \"\$STAGE/free-sleep\" \"\$LIVE\" || {
      if [ -d \"\$STAGE/previous\" ]; then
        move_tree \"\$STAGE/previous\" \"\$LIVE\" && restart_services
      fi
      exit 1
    }
    restart_services
    rm -f /usr/local/lib/nightstand/free-sleep-restore.tar.gz
  " || fail "restore failed over SSH. Keep $RESTORE_TARBALL and inspect the Pod state before retrying"
  say "Restore complete. Check http://$POD_IP:3000/ once it's back up."
  exit 0
fi

# Stage 5 copies these helpers to the pod, so check for them up front.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for helper in pod-installer.sh restore-original-fork.sh fork-artifacts.sh; do
  [ -f "$SCRIPT_DIR/$helper" ] || fail "$helper was not found next to this script. Download it from scripts/migrate/ into $SCRIPT_DIR and run again."
done
RESTORE_HELPER_LOCAL="$SCRIPT_DIR/../restore_helpers.sh"
[ -f "$RESTORE_HELPER_LOCAL" ] || RESTORE_HELPER_LOCAL="$SCRIPT_DIR/restore_helpers.sh"
[ -f "$RESTORE_HELPER_LOCAL" ] || fail "Download scripts/restore_helpers.sh next to this script and run again."
command -v python3 >/dev/null 2>&1 || fail "python3 is required on this computer."

# ==============================================================================
# Stage 1, Locate (read-only)
# ==============================================================================
say "Stage 1: locating the pod"
if [ -n "$IP" ]; then
  POD_IP="$IP"
elif curl -sf --max-time 3 "http://eight-pod.local:3000/api/deviceStatus" >/dev/null 2>&1; then
  POD_IP="eight-pod.local"
elif curl -sf --max-time 3 "http://eight-pod:3000/api/deviceStatus" >/dev/null 2>&1; then
  POD_IP="eight-pod"
else
  read -r -p "Couldn't find a pod at eight-pod.local. Scan the local /24 subnet for one? [y/N] " SCAN_OK
  if [ "$SCAN_OK" != "y" ] && [ "$SCAN_OK" != "Y" ]; then
    fail "no pod found. Re-run with --ip <address> if you know it."
  fi
  BASE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' | head -n1)
  MY_IP=$(ipconfig getifaddr "$BASE" 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$MY_IP" ] || fail "could not determine the local subnet to scan"
  SUBNET=$(echo "$MY_IP" | cut -d. -f1-3)
  say "Scanning ${SUBNET}.0/24 on port 3000 (this takes a few seconds)..."
  CANDIDATES=()
  for i in $(seq 1 254); do
    (
      exec 3<>"/dev/tcp/${SUBNET}.${i}/3000" 2>/dev/null && echo "${SUBNET}.${i}" >> /tmp/free-sleep-scan-hits
    ) 2>/dev/null &
  done
  wait
  if [ -f /tmp/free-sleep-scan-hits ]; then
    while read -r hit; do
      if curl -sf --max-time 2 "http://$hit:3000/api/deviceStatus" | grep -q "currentTemperatureF"; then
        CANDIDATES+=("$hit")
      fi
    done < /tmp/free-sleep-scan-hits
    rm -f /tmp/free-sleep-scan-hits
  fi
  case "${#CANDIDATES[@]}" in
    0) fail "subnet scan found no free-sleep pod" ;;
    1) POD_IP="${CANDIDATES[0]}" ;;
    *)
      echo "Multiple candidates found:"
      select choice in "${CANDIDATES[@]}"; do POD_IP="$choice"; break; done
      ;;
  esac
fi
say "Using pod at $POD_IP"

# ==============================================================================
# Stage 2, Identify (read-only)
# ==============================================================================
say "Stage 2: identifying the pod's current install"

DEVICE_STATUS=$(curl -sf --max-time 5 "http://$POD_IP:3000/api/deviceStatus") \
  || fail "could not reach http://$POD_IP:3000/api/deviceStatus"
RUNNING_VERSION=$(printf '%s' "$DEVICE_STATUS" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("freeSleep",{}).get("version","unknown"))' 2>/dev/null || echo unknown)
RUNNING_BRANCH=$(printf '%s' "$DEVICE_STATUS" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("freeSleep",{}).get("branch","unknown"))' 2>/dev/null || echo unknown)

# No fork serves an explicit "which fork am I" field over HTTP today:
# serverInfo.json (which has one) is fetched by the BROWSER directly from
# GitHub, never by the pod's own API (see app/src/api/serverInfo.ts). Over
# HTTP the best signal is the version stream (this fork starts at 3.0.0,
# upstream/jmew are on 2.x), but any sibling fork that shares the 3.x stream
# looks identical here. So the version is only a HINT, the authoritative
# "are you already on this fork" decision is deferred to Stage 2b, made from
# the repo the pod's own on-disk updater points at, which names the fork
# exactly.
MAJOR_VERSION=$(printf '%s' "$RUNNING_VERSION" | cut -d. -f1)
if [ "$RUNNING_BRANCH" = "main" ] && [ "${MAJOR_VERSION:-0}" -ge 3 ] 2>/dev/null; then
  say "v$RUNNING_VERSION shares this fork's 3.x version stream, will confirm the exact repo over SSH before treating it as a migration."
else
  say "Detected version v$RUNNING_VERSION on branch '$RUNNING_BRANCH'."
fi

read -r -p "SSH password for root@$POD_IP (tried on port 8822 then 22): " -s SSH_PASS
echo
for port in 8822 22; do
  if ssh_cmd "$port" "true" 2>/dev/null; then SSH_PORT="$port"; break; fi
done
[ -n "$SSH_PORT" ] || fail "could not SSH into $POD_IP as root on port 8822 or 22"
say "SSH OK on port $SSH_PORT"

REMOTE_REPO="/home/dac/free-sleep"
if ! ssh_cmd "$SSH_PORT" "[ -d '$REMOTE_REPO' ] && [ -f '$REMOTE_REPO/server/package.json' ]"; then
  fail "no recognizable free-sleep install at $REMOTE_REPO on that pod. This tool only migrates installs it recognizes, try a fresh scripts/install.sh instead."
fi
if ! ssh_cmd "$SSH_PORT" "systemctl list-unit-files | grep -q '^free-sleep.service'"; then
  fail "no free-sleep.service known to systemd on that pod. Too old or too different to migrate automatically."
fi

# ==============================================================================
# Stage 2b, Confirm this is really another fork (authoritative, on-disk)
# ==============================================================================
# The pod's own updater names the repo it pulls from, and that is the one
# unambiguous "which fork" signal there is: this fork's installs point their
# updater at LTimothy/nightstand; every other fork points elsewhere. Refuse
# only when it is demonstrably THIS repo, never on the version-stream hint
# alone, so a sibling fork that shares the 3.x stream can still migrate.
THIS_FORK_REPO="LTimothy/nightstand"
ONDISK_UPDATER=$(ssh_cmd "$SSH_PORT" "cat '$REMOTE_REPO/scripts/update.sh' 2>/dev/null; cat '$REMOTE_REPO/scripts/install.sh' 2>/dev/null" || true)
ONDISK_FORK_REPO=$(printf '%s' "$ONDISK_UPDATER" | grep -oE 'github(usercontent)?\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+' | head -n1 | sed -E 's#.*\.com/##')
if [ "$ONDISK_FORK_REPO" = "$THIS_FORK_REPO" ]; then
  fail "this pod's own updater already points at $THIS_FORK_REPO, it is already on this fork. Use the in-app updater (Settings > Software) instead; this tool is only for migrating FROM another fork."
fi
if [ -n "$ONDISK_FORK_REPO" ]; then
  say "The pod's updater points at '$ONDISK_FORK_REPO', treating this as a migration to $THIS_FORK_REPO."
else
  say "Could not read the pod's updater repo; proceeding as a migration to $THIS_FORK_REPO (running v$RUNNING_VERSION)."
fi

# Disk space, both sides. The pod works out what this switch will write and
# prints free and needed MB for / and then /persistent.
IFS= read -r -d '' POD_SPACE_SCRIPT <<'MEASURE' || true
LIVE=/home/dac/free-sleep
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
# Stage 4 copies the install and the database to / and keeps a tarball of
# them on /persistent (counted unpacked) next to its own database copy.
# pod-installer.sh then needs what it checks for itself: the release with
# its node_modules and a third again for npm's and Prisma's caches, never
# counted below 64 MB and 400 MB, and
# a database copy on /, and on /persistent the database snapshot plus half
# the database again for migrations.
MODULES_MB=$(size_mb "$LIVE/server/node_modules")
TREE_MB=$(( $(size_mb "$LIVE") - MODULES_MB ))
DB_MB=$(size_mb /persistent/free-sleep-data/free-sleep.db /persistent/free-sleep-data/free-sleep.db-wal)
RELEASE_MB=$TREE_MB
[ "$RELEASE_MB" -ge 64 ] || RELEASE_MB=64
RELEASE_MODULES_MB=$MODULES_MB
[ "$RELEASE_MODULES_MB" -ge 400 ] || RELEASE_MODULES_MB=400
ROOT_NEED=$(( TREE_MB + MODULES_MB + DB_MB ))
INSTALLER_ROOT_MB=$(( 2 * RELEASE_MB + RELEASE_MODULES_MB + RELEASE_MODULES_MB / 3 + DB_MB + DB_MB / 2 ))
[ "$ROOT_NEED" -ge "$INSTALLER_ROOT_MB" ] || ROOT_NEED=$INSTALLER_ROOT_MB
ROOT_NEED=$(( ROOT_NEED + SPACE_MARGIN_MB ))
PERS_NEED=$(( TREE_MB + MODULES_MB + DB_MB + $(size_mb /persistent/free-sleep-data/lowdb) + DB_MB \
  + DB_MB + DB_MB / 2 + SPACE_MARGIN_MB ))
# An unreadable df prints 0, so the laptop refuses rather than misreads.
ROOT_FREE=$(free_mb /)
PERS_FREE=$(free_mb /persistent)
echo "${ROOT_FREE:-0} $ROOT_NEED ${PERS_FREE:-0} $PERS_NEED"
MEASURE
POD_SPACE=$(printf '%s\n' "$POD_SPACE_SCRIPT" | ssh_cmd "$SSH_PORT" 'bash -s' 2>/dev/null || true)
read -r REMOTE_ROOT_FREE REMOTE_ROOT_NEED REMOTE_PERS_FREE REMOTE_PERS_NEED POD_SPACE_EXTRA <<< "$POD_SPACE"
for value in "${REMOTE_ROOT_FREE:-}" "${REMOTE_ROOT_NEED:-}" "${REMOTE_PERS_FREE:-}" "${REMOTE_PERS_NEED:-}"; do
  case $value in
    '' | *[!0-9]*) fail "could not measure free space on the pod (got '$POD_SPACE')" ;;
  esac
done
[ -z "${POD_SPACE_EXTRA:-}" ] || fail "could not measure free space on the pod (got '$POD_SPACE')"
[ "${REMOTE_ROOT_FREE:-0}" -ge "${REMOTE_ROOT_NEED:-1}" ] 2>/dev/null \
  || fail "low disk on the pod's / (${REMOTE_ROOT_FREE:-unknown}M free, ${REMOTE_ROOT_NEED:-unknown}M needed)"
[ "${REMOTE_PERS_FREE:-0}" -ge "${REMOTE_PERS_NEED:-1}" ] 2>/dev/null \
  || fail "low disk on the pod's /persistent (${REMOTE_PERS_FREE:-unknown}M free, ${REMOTE_PERS_NEED:-unknown}M needed); old snapshots in /persistent/free-sleep-database-backups/ can be removed to make room"
LAPTOP_FREE_KB=$(df -Pk . | awk 'NR==2{print $4}')
[ "${LAPTOP_FREE_KB:-0}" -gt 2097152 ] 2>/dev/null || fail "low free disk here on the laptop (need >2GB for the backup copy)"

# Pod generation. The hub reports it directly in deviceStatus (coverVersion),
# which every fork exposes and which comes straight from the hardware, a far
# more reliable signal than guessing from on-disk RAW files. The RAW files are
# named <hex>.RAW; "capSense2"/"capSense" are CBOR field names INSIDE them, not
# filenames, so the old ls-glob matched nothing on any Pod and forced everyone
# through --assume-model. Keep that glob only as a fallback for a fork whose
# deviceStatus somehow omits coverVersion.
say "Detecting pod generation..."
COVER_VERSION=$(printf '%s' "$DEVICE_STATUS" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("coverVersion",""))' 2>/dev/null || echo "")
case "$COVER_VERSION" in
  *5*) DETECTED_MODEL="pod5" ;;
  *4*|*3*) DETECTED_MODEL="pod3or4" ;;
  *2*) DETECTED_MODEL="pod2" ;;
  *1*) DETECTED_MODEL="pod1" ;;
  *)
    RAW_SIGNAL=$(ssh_cmd "$SSH_PORT" "ls /persistent/*/capSense2* /persistent/*/bedTemp2* 2>/dev/null | head -n1")
    LEGACY_SIGNAL=$(ssh_cmd "$SSH_PORT" "ls /persistent/*/capSense[^2]* /persistent/*/bedTemp[^2]* 2>/dev/null | head -n1")
    if [ -n "$RAW_SIGNAL" ] && [ -z "$LEGACY_SIGNAL" ]; then
      DETECTED_MODEL="pod5"
    elif [ -z "$RAW_SIGNAL" ] && [ -n "$LEGACY_SIGNAL" ]; then
      DETECTED_MODEL="pod3or4"
    else
      DETECTED_MODEL="unknown"
    fi
    ;;
esac
IDENTIFICATION_FAILED=no
if [ "$DETECTED_MODEL" = "unknown" ] || [ -n "$ASSUME_MODEL" ]; then
  IDENTIFICATION_FAILED=yes
fi
if [ -n "$ASSUME_MODEL" ]; then
  DETECTED_MODEL="$ASSUME_MODEL"
fi
say "Detected generation: $DETECTED_MODEL$([ "$IDENTIFICATION_FAILED" = yes ] && echo ' (assumed, identification failed or was overridden)')"

# Baseline health snapshot (compared again after the swap).
BASELINE_STATUS="$DEVICE_STATUS"
BASELINE_ACTIVE=$(ssh_cmd "$SSH_PORT" "systemctl is-active free-sleep" 2>/dev/null || echo "unknown")
if [ "$BASELINE_ACTIVE" != "active" ] && [ "$MIGRATE_ANYWAY" != yes ]; then
  fail "the pod's current install isn't healthy (free-sleep.service is '$BASELINE_ACTIVE'), we can't promise to return you to a working state that doesn't exist. Re-run with --migrate-anyway to proceed eyes-open."
fi

# Bed-in-use check.
LEFT_ON=$(printf '%s' "$DEVICE_STATUS" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("left",{}).get("isOn",False))' 2>/dev/null)
RIGHT_ON=$(printf '%s' "$DEVICE_STATUS" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("right",{}).get("isOn",False))' 2>/dev/null)
if [ "$LEFT_ON" = "True" ] || [ "$RIGHT_ON" = "True" ]; then
  echo "One or both sides currently show as powered on, someone may be in bed."
  read -r -p "Type 'bed-in-use-ok' to proceed anyway: " BED_ACK
  [ "$BED_ACK" = "bed-in-use-ok" ] || fail "bed-in-use acknowledgment not given"
fi

# Clock skew.
POD_TIME=$(ssh_cmd "$SSH_PORT" "date -u +%s" 2>/dev/null || echo 0)
LAPTOP_TIME=$(date -u +%s)
SKEW=$(( POD_TIME > LAPTOP_TIME ? POD_TIME - LAPTOP_TIME : LAPTOP_TIME - POD_TIME ))
if [ "$SKEW" -gt 120 ]; then
  echo "Pod clock is off by ${SKEW}s from this laptop, this can break TLS to GitHub mid-download."
  say "Clock correction can be requested after the migration confirmation."
fi

# WAN state + iptables snapshot (every abort path restores exactly this).
WAN_OK=$(ssh_cmd "$SSH_PORT" "curl -sf --max-time 5 https://github.com >/dev/null 2>&1 && echo yes || echo no")
say "Pod WAN reachability right now: $WAN_OK"
IPTABLES_SNAPSHOT_LOCAL=$(mktemp)
ssh_cmd "$SSH_PORT" "iptables-save 2>/dev/null" > "$IPTABLES_SNAPSHOT_LOCAL" || true

# --- Pod generation gate matrix -------------------------------------------
if [ "$DETECTED_MODEL" = "unknown" ] && [ -z "$ASSUME_MODEL" ]; then
  fail "could not determine the pod generation from independent signals (they conflicted or were absent). Re-run with --assume-model podN if you're sure, or file an issue."
fi
if [ "$IDENTIFICATION_FAILED" = yes ]; then
  echo "Identification failed or was overridden, proceeding on the assumption this is a $DETECTED_MODEL."
fi
case "$DETECTED_MODEL" in
  pod5)
    if [ "$IDENTIFICATION_FAILED" = yes ]; then
      read -r -p "Type 'pod4-ok' to proceed on this assumption anyway: " ACK
      [ "$ACK" = "pod4-ok" ] || fail "model acknowledgment not given"
    fi
    ;;
  pod3or4)
    echo "This looks like a Pod 3 or 4. This fork is developed and tested on Pod 5 only."
    echo "Upstream supported Pod 3/4, but biometrics RAW formats differ (legacy type names),"
    echo "so sleep tracking may be degraded or broken. Temperature control and scheduling should work."
    read -r -p "Type 'pod4-ok' to proceed anyway: " ACK
    [ "$ACK" = "pod4-ok" ] || fail "pod3/4 acknowledgment not given"
    ;;
  pod1|pod2)
    fail "Pod 1/2 have no free-sleep lineage, different platform, no dac.sock. There is nothing to migrate to. See the supported-hardware docs."
    ;;
  *)
    fail "unrecognized --assume-model value '$DETECTED_MODEL' (expected pod1, pod2, pod3or4, or pod5)"
    ;;
esac

DETECTED_MODEL_NOTE="Pod 5: fully supported."
[ "$DETECTED_MODEL" = "pod3or4" ] && DETECTED_MODEL_NOTE="Pod 3/4: acknowledged above, sleep tracking may be degraded, temperature control and scheduling should work."

# ==============================================================================
# Stage 3, Report and consent (still read-only)
# ==============================================================================
# The helper runs through stdin without installing files on the Pod.
FOREIGN_REPORT=$(ssh_cmd "$SSH_PORT" 'bash -s -- inspect' < "$SCRIPT_DIR/fork-artifacts.sh") \
  || fail "could not inspect root cron and fork-specific units; nothing was changed"
if [ -n "$FOREIGN_REPORT" ]; then
  say "Legacy fork artifacts found:"
  printf '%s\n' "$FOREIGN_REPORT"
  say "Unknown free-sleep units will be stopped before the database checkpoint."
fi
REMOVE_FOREIGN=no

NEWEST_VERSION=$(curl -fsSL --max-time 20 "$RELEASES_URL" | python3 -I -c "
import json, sys
data = json.load(sys.stdin)
print(data['releases'][0]['version'] if data['releases'] else '')
" 2>/dev/null)
[ -n "$NEWEST_VERSION" ] || fail "could not resolve the newest release from releases.json"

cat <<REPORT

============================== Migration report ==============================
Found:
  Pod:              $POD_IP (generation: $DETECTED_MODEL)
  Current version:   v$RUNNING_VERSION on branch '$RUNNING_BRANCH' (fork identity is a best-effort guess, see above)
  Disk headroom:      pod /=${REMOTE_ROOT_FREE}M, /persistent=${REMOTE_PERS_FREE}M
  WAN reachable now:  $WAN_OK

What will happen:
  1. Full backup: a tarball of the pod's code + data, kept on the pod AND
     pulled to this laptop, both integrity-verified before anything else
     happens.
  2. Install LTimothy/nightstand v$NEWEST_VERSION, the newest release (the tip
     of main, which only moves when a release is published).
  3. Your old install is preserved at /home/dac/free-sleep-prev, this
     becomes the in-app instant-rollback slot afterward.

What changes about behavior:
  - This fork firewalls the pod's WAN by default (updates open it briefly).
  - Your sleep data and schedules are kept, both databases carry over. A
    data-compatibility dry run runs before anything is touched and aborts
    pre-swap if it finds anything that can't be carried over safely.
  - ${DETECTED_MODEL_NOTE:-}

How to get back, in order of preference:
  - The rollback in the app (Settings > Software > Recovery) once
    migrated, instant, no download.
  - The laptop-side backup tarball this tool is about to create, restorable
    with: switch-to-this-fork.sh --restore <tarball> --ip $POD_IP
================================================================================

REPORT

if [ "$DRY_RUN" = yes ]; then
  say "--dry-run: stopping here. Nothing was changed."
  exit 0
fi

read -r -p "Type 'switch' to proceed: " CONFIRM
[ "$CONFIRM" = "switch" ] || fail "confirmation not given"

if printf '%s\n' "$FOREIGN_REPORT" | grep -qE '^cron:|^unit: free-sleep-ambient-light[.]service$'; then
  echo "Legacy root cron jobs can open the firewall after the switch."
  echo "The ambient-light unit writes the database and is not used by Nightstand."
  read -r -p "Type 'remove-legacy-artifacts' to back up and remove these cron jobs, the legacy time sync script and the ambient-light unit: " REMOVE_ACK
  [ "$REMOVE_ACK" = remove-legacy-artifacts ] \
    || fail "cleanup consent not given; refusing to switch with legacy firewall cron or ambient-light installed. Nothing was changed."
  REMOVE_FOREIGN=yes
fi

# Clock correction requires confirmation and is skipped in dry-run mode.
if [ "$SKEW" -gt 120 ]; then
  read -r -p "Set the pod's clock from this laptop's now? [y/N] " FIX_CLOCK
  if [ "$FIX_CLOCK" = "y" ] || [ "$FIX_CLOCK" = "Y" ]; then
    LAPTOP_TIME=$(date -u +%s)
    ssh_cmd "$SSH_PORT" "date -u -s @$LAPTOP_TIME" >/dev/null 2>&1 || say "WARNING: could not set the pod's clock"
  fi
fi

# ==============================================================================
# Stage 4, Backup before anything
# ==============================================================================
say "Stage 4: backing up the pod (code + data) before touching anything"
TS=$(date +%Y%m%d-%H%M%S)
REMOTE_BACKUP_DIR="/persistent/free-sleep-backups"
REMOTE_BACKUP_TARBALL="$REMOTE_BACKUP_DIR/migrate-${TS}.tar.gz"
LOCAL_BACKUP_TARBALL="./free-sleep-migrate-backup-${TS}.tar.gz"

ssh_cmd "$SSH_PORT" "
  set -e
  # Leave CPU and disk headroom for the hardware watchdog and running server.
  low_priority() {
    if command -v ionice >/dev/null 2>&1; then
      nice -n 19 ionice -c 2 -n 7 \"\$@\"
    else
      nice -n 19 \"\$@\"
    fi
  }
  # Staged and written only in a folder root owns, never in the server user's.
  mkdir -p '$REMOTE_BACKUP_DIR'
  [ ! -L '$REMOTE_BACKUP_DIR' ] && [ -O '$REMOTE_BACKUP_DIR' ] \
    || { echo '$REMOTE_BACKUP_DIR is not a folder only root can write' >&2; exit 1; }
  # A session that dropped mid-copy left its stage; clear those over a day old.
  find '$REMOTE_BACKUP_DIR' -mindepth 1 -maxdepth 1 -name '.staging.*' -type d -user \$(id -u) -mtime +0 \
    -exec rm -rf {} \\; 2>/dev/null || true
  STAGE=\$(mktemp -d '$REMOTE_BACKUP_DIR/.staging.XXXXXX')
  trap 'rm -rf \"\$STAGE\"' EXIT
  mkdir \"\$STAGE/free-sleep\"
  low_priority cp -a /home/dac/free-sleep/. \"\$STAGE/free-sleep/\"
  mkdir -p \"\$STAGE/free-sleep-data\"
  if [ -f /persistent/free-sleep-data/free-sleep.db ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
      low_priority sqlite3 /persistent/free-sleep-data/free-sleep.db \".backup '\$STAGE/free-sleep-data/free-sleep.db'\" || exit 1
    else
      low_priority python3 -I -c 'import sqlite3,sys; source=sqlite3.connect(sys.argv[1]); target=sqlite3.connect(sys.argv[2]); source.backup(target); target.close(); source.close()' /persistent/free-sleep-data/free-sleep.db \"\$STAGE/free-sleep-data/free-sleep.db\"
    fi
  fi
  if [ -f \"\$STAGE/free-sleep-data/free-sleep.db\" ]; then
    low_priority python3 -I -c 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); result=db.execute(\"PRAGMA integrity_check\").fetchall(); db.close(); sys.exit(0 if result==[(\"ok\",)] else 1)' \"\$STAGE/free-sleep-data/free-sleep.db\"
    mkdir -p /persistent/free-sleep-database-backups
    low_priority cp \"\$STAGE/free-sleep-data/free-sleep.db\" '/persistent/free-sleep-database-backups/migrate-${TS}.db'
    chmod 600 '/persistent/free-sleep-database-backups/migrate-${TS}.db'
  fi
  low_priority cp -r /persistent/free-sleep-data/lowdb \"\$STAGE/free-sleep-data/\"
  low_priority tar czf '$REMOTE_BACKUP_TARBALL' -C \"\$STAGE\" .
  rm -rf \"\$STAGE\"
  low_priority tar tzf '$REMOTE_BACKUP_TARBALL' >/dev/null
" || fail "backup on the pod failed; nothing else was touched"

say "Pulling the backup to this laptop..."
scp_from_pod "$SSH_PORT" "$REMOTE_BACKUP_TARBALL" "$LOCAL_BACKUP_TARBALL" \
  || fail "could not pull the backup to this laptop; nothing else was touched"
tar tzf "$LOCAL_BACKUP_TARBALL" >/dev/null || fail "local backup copy failed integrity check; nothing else was touched"
REMOTE_SIZE=$(ssh_cmd "$SSH_PORT" "stat -c%s '$REMOTE_BACKUP_TARBALL' 2>/dev/null || stat -f%z '$REMOTE_BACKUP_TARBALL'")
LOCAL_SIZE=$(stat -f%z "$LOCAL_BACKUP_TARBALL" 2>/dev/null || stat -c%s "$LOCAL_BACKUP_TARBALL")
[ "$REMOTE_SIZE" = "$LOCAL_SIZE" ] || fail "backup size mismatch between pod ($REMOTE_SIZE) and laptop ($LOCAL_SIZE) copies; nothing else was touched"
say "Backup verified in both places. Pod: $REMOTE_BACKUP_TARBALL, Laptop: $LOCAL_BACKUP_TARBALL"

# Baseline temperatures, written for pod-installer.sh's post-swap comparison.
BASELINE_JSON=$(printf '%s' "$BASELINE_STATUS" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
out = {}
for side in ("left", "right"):
    t = d.get(side, {}).get("currentTemperatureF")
    if isinstance(t, (int, float)):
        out[side] = t
print(json.dumps(out))
' 2>/dev/null || echo "{}")
# Root's migration state lives in a folder only root can write.
ssh_cmd "$SSH_PORT" 'd=/persistent/nightstand-migrate; [ ! -L "$d" ] || rm -f "$d"; mkdir -p "$d" && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d"' \
  || fail "could not create /persistent/nightstand-migrate on the pod; nothing else was touched"
printf '%s' "$BASELINE_JSON" | ssh_cmd "$SSH_PORT" "cat > /persistent/nightstand-migrate/free-sleep-migrate-baseline.json"

# ==============================================================================
# Stage 5, push pod-installer.sh, start it detached, poll status
# ==============================================================================
say "Stage 5: pushing the installer and starting it (detached, safe if this laptop disconnects)"
ssh_cmd "$SSH_PORT" "mkdir -p /usr/local/lib/nightstand/migrate && chmod 755 /usr/local/lib/nightstand /usr/local/lib/nightstand/migrate"
scp_to_pod "$SSH_PORT" "$SCRIPT_DIR/pod-installer.sh" "/usr/local/lib/nightstand/migrate/pod-installer.sh"
scp_to_pod "$SSH_PORT" "$SCRIPT_DIR/restore-original-fork.sh" "/usr/local/lib/nightstand/migrate/restore-original-fork.sh"
scp_to_pod "$SSH_PORT" "$SCRIPT_DIR/fork-artifacts.sh" "/usr/local/lib/nightstand/migrate/fork-artifacts.sh"
scp_to_pod "$SSH_PORT" "$RESTORE_HELPER_LOCAL" "/usr/local/lib/nightstand/migrate/restore_helpers.sh"
ssh_cmd "$SSH_PORT" "chmod +x /usr/local/lib/nightstand/migrate/pod-installer.sh /usr/local/lib/nightstand/migrate/restore-original-fork.sh"
# Push the Stage 2 (pre-consent) iptables snapshot rather than letting
# pod-installer.sh take a fresh one later, every abort path must restore
# the state the pod was actually in when the user typed "switch", not
# whatever it drifts to during Stage 4/5.
scp_to_pod "$SSH_PORT" "$IPTABLES_SNAPSHOT_LOCAL" "/persistent/nightstand-migrate/free-sleep-migrate-iptables-snapshot.rules"

ssh_cmd "$SSH_PORT" "
  rm -f /persistent/free-sleep-data/migration-status.json
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --unit=free-sleep-migrate --collect --property=KillMode=control-group \
      --property=ExecStopPost='-/bin/systemctl restart --no-block free-sleep-recover-switch.service' bash /usr/local/lib/nightstand/migrate/pod-installer.sh \"$REMOVE_FOREIGN\" \
      || systemd-run --unit=free-sleep-migrate --collect bash /usr/local/lib/nightstand/migrate/pod-installer.sh \"$REMOVE_FOREIGN\"
  else
    command -v setsid >/dev/null || exit 1
    nohup setsid bash /usr/local/lib/nightstand/migrate/pod-installer.sh \"$REMOVE_FOREIGN\" >/usr/local/lib/nightstand/migrate/installer.out 2>&1 & disown
  fi
" || fail "could not start the installer on the pod"

say "Installer started. Polling status (safe to close this laptop, it'll keep running)..."
STATUS_FILE_REMOTE="/persistent/free-sleep-data/migration-status.json"
ATTEMPTS=0
while [ "$ATTEMPTS" -lt 200 ]; do
  sleep 6
  ATTEMPTS=$((ATTEMPTS + 1))
  STATUS_JSON=$(ssh_cmd "$SSH_PORT" "if [ -f '$STATUS_FILE_REMOTE' ]; then cat '$STATUS_FILE_REMOTE'; fi") || { say "  (reconnecting...)"; continue; }
  if [ -z "$STATUS_JSON" ] || printf '%s' "$STATUS_JSON" | grep -q '"in_progress"'; then
    ssh_cmd "$SSH_PORT" 'systemctl is-active --quiet free-sleep-migrate.service || { pid=$(cat /persistent/nightstand-migrate/free-sleep-migrate.pid 2>/dev/null); case "$pid" in ""|*[!0-9]*) exit 1;; esac; kill -0 "$pid"; }' \
      || {
        # The installer can publish its outcome and exit between these probes.
        STATUS_JSON=$(ssh_cmd "$SSH_PORT" "if [ -f '$STATUS_FILE_REMOTE' ]; then cat '$STATUS_FILE_REMOTE'; fi") \
          || { say "  (reconnecting...)"; continue; }
        FINAL_OUTCOME=$(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("outcome",""))' 2>/dev/null || true)
        case "$FINAL_OUTCOME" in
          success|restored|failed|refused|restore_failed) ;;
          *) fail "installer is no longer running; check the migration log and sentinel recovery before retrying" ;;
        esac
      }
  fi
  [ -n "$STATUS_JSON" ] || continue
  OUTCOME=$(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("outcome",""))' 2>/dev/null)
  STAGE_NAME=$(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("stage",""))' 2>/dev/null)
  say "  [$STAGE_NAME] $OUTCOME"
  case "$OUTCOME" in
    success|restored|failed|refused|restore_failed)
      ssh_cmd "$SSH_PORT" "
        set -o pipefail
        ls -1t '$REMOTE_BACKUP_DIR'/migrate-*.tar.gz | tail -n +3 | xargs -r rm -f
      " || say "WARNING: could not prune old migration backups at $REMOTE_BACKUP_DIR"
      ;;
  esac
  case "$OUTCOME" in
    success)
      cat <<AFTERCARE

============================== Migration complete =============================
Pod:              http://$POD_IP:3000/
Backup (pod):      $REMOTE_BACKUP_TARBALL
Backup (laptop):    $LOCAL_BACKUP_TARBALL
Migration log:      /persistent/nightstand-logs/migration-*.log (on the pod)
Instant rollback to your old fork is now in the app:
Settings > Software > Recovery.

Keep the laptop backup tarball for at least a few nights.
=================================================================================
AFTERCARE
      exit 0
      ;;
    restore_failed)
      fail "migration and automatic restore failed. SSH recovery is required; inspect the original tree and migration log on the pod."
      ;;
    restored|failed|refused)
      fail "migration did not succeed (outcome: $OUTCOME). Your original install has been restored automatically. Details: $(printf '%s' "$STATUS_JSON" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get("message",""))' 2>/dev/null)"
      ;;
  esac
done
fail "gave up waiting for the migration to report a final outcome after 20 minutes. The dead-man sentinel will restore your original fork on its own if the installer died; check http://$POD_IP:3000/ directly."
