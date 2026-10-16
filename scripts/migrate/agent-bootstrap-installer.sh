#!/bin/bash
# Pod-side half of the agent bootstrap. Pushed to the target pod by
# ops/bootstrap-agent.sh and started detached, so a dropped laptop connection
# changes nothing here.
#
# This is the smaller sibling of pod-installer.sh. That tool migrates a pod
# from another fork onto this whole tree; this one adds the updater, rollback
# and revert tools to a pod running upstream free-sleep.
#
# The installer stages the overlay and keeps the previous install.
# A timed restore attempts to bring it back if installation stops.
# It does not modify Eight Sleep's firmware files. The updater it installs
# blocks the Pod's internet access after downloading updates. Schedules and
# alarms pause while the server is stopped. Recovery can still require SSH
# or a firmware reset. See ops/ANTIBRICK.md.
#
# Ordering principle, same as its sibling: everything expensive and failable
# happens BEFORE the running service is touched. By the time their service
# stops, the staged tree is already assembled and verified.
#
# Apply the overlay to a copy of the Pod's existing upstream free-sleep
# install. Preserve that source outside the files named in the manifest.
set -uo pipefail

LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
# Same constants as pod-installer.sh on purpose. Both tools swap LIVE and PREV
# and both are one-at-a-time operations, so they share restore-original-fork.sh
# unchanged. Restoring the original install puts upstream free-sleep back.
PREEXISTING_PREV=/home/dac/free-sleep-prev-preexisting
SWAP_MARKER=/home/dac/free-sleep-migrate-swapped
STAGE=/home/dac/free-sleep-agent-staging
SYSTEM_DIR=/usr/local/lib/nightstand
WORK=""
PAYLOAD=/usr/local/lib/nightstand/migrate/agent-payload
LOCK_FILE=/home/dac/free-sleep-agent-bootstrap.lock
STATUS_FILE=/persistent/free-sleep-data/migration-status.json
RESTORE_SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/restore-original-fork.sh"
RESTORE_SCRIPT_DEST=/usr/local/lib/nightstand/restore-original-fork.sh
SENTINEL_SERVICE=free-sleep-migrate-sentinel.service
SENTINEL_TIMER=free-sleep-migrate-sentinel.timer
SENTINEL_MINUTES=12
LOG_FILE="/persistent/free-sleep-data/logs/agent-bootstrap-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

write_status() {
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null || true
  printf '{"stage":"%s","outcome":"%s","message":"%s","timestamp":"%s"}\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS_FILE" 2>/dev/null || true
}

if [ -e "$LOCK_FILE" ]; then
  say "FATAL: $LOCK_FILE exists, a bootstrap is already running or a previous run left it behind."
  write_status "preflight" "refused" "lock file present"
  exit 1
fi
: > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"; if [ -n "$WORK" ]; then rm -rf "$WORK"; fi' EXIT

# Moves tree $1 to $2 in the server user's folder without following anything
# planted at $2: mv -T where mv has it, else only onto a free name. Fails
# unless $1 is a real folder and $2 is then the moved tree.
move_tree() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  move_mark=$(mktemp "$1/.moving.XXXXXX") || return 1
  mv -T "$1" "$2" 2>/dev/null \
    || { [ -d "$1" ] && [ ! -e "$2" ] && [ ! -L "$2" ] && mv "$1" "$2"; } \
    || { [ -d "$1" ] && [ ! -L "$1" ] && rm -f "$1/${move_mark##*/}"; return 1; }
  [ -d "$2" ] && [ ! -L "$2" ] && [ -f "$2/${move_mark##*/}" ] && rm -f "$2/${move_mark##*/}"
}

fail() {
  say "FATAL: $*"
  write_status "install" "failed" "$*"
  exit 1
}

# ==============================================================================
# Preflight. Their server is running and untouched below this line.
# ==============================================================================
for unit in free-sleep-update.service free-sleep-rollback.service; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    fail "$unit is active, refusing to bootstrap while an updater is running"
  fi
done

[ -d "$LIVE" ] || fail "no install at $LIVE; the agent overlays an existing upstream free-sleep install, it does not create one"
[ -f "$LIVE/server/package.json" ] || fail "no server/package.json under $LIVE; this does not look like a free-sleep install"
[ -d "$PAYLOAD" ] || fail "no agent payload at $PAYLOAD; the laptop half should have pushed it"
[ -f "$PAYLOAD/MANIFEST" ] || fail "payload has no MANIFEST; refusing to guess which files are the agent"

# Refuse a tree that already carries the agent. This installer expects
# upstream free-sleep and has not been validated for overlaying other forks.
if [ -f "$LIVE/server/src/routes/update/update.ts" ] || [ -d "$LIVE/server/src/agent" ]; then
  fail "this pod already carries agent files; use the in-app updater, not the bootstrap"
fi
if grep -q "routes/update/update.js" "$LIVE/server/src/setup/routes.ts" 2>/dev/null; then
  fail "this pod's routes.ts already registers an update route; not upstream free-sleep, refusing"
fi

ROOT_FREE=$(df -m / | awk 'NR==2{print $4}')
[ "${ROOT_FREE:-0}" -gt 1000 ] || fail "low disk on / (${ROOT_FREE}M free), aborting before touching anything"

# ==============================================================================
# Stage: a copy of THEIR upstream free-sleep, with the agent applied to the copy.
# ==============================================================================
write_status "stage" "in_progress" "copying the upstream free-sleep install"
say "Copying the pod's own upstream free-sleep install to $STAGE (their tree stays untouched)"
# Assembled and copied for root where only root can write. Root runs this
# copy from here on, never the stage the server user will own.
mkdir -p "$SYSTEM_DIR" && WORK=$(mktemp -d "$SYSTEM_DIR/.download.XXXXXX") \
  || fail "could not create a work folder in $SYSTEM_DIR; nothing was touched"
FRESH="$WORK/tree"
cp -a "$LIVE" "$FRESH" || fail "could not copy the upstream free-sleep install; nothing was touched"
chown -hR root:root "$FRESH" && chmod -R go-w "$FRESH" \
  || fail "could not take the copy of the upstream free-sleep install for root; nothing was touched"

say "Applying the agent overlay to the copy"
while IFS='|' read -r mode path; do
  [ -n "${path:-}" ] || continue
  src="$PAYLOAD/files/$path"
  dest="$FRESH/$path"
  case "$mode" in
    add)
      [ -e "$dest" ] && fail "manifest says add but $path already exists in upstream free-sleep; the base moved"
      mkdir -p "$(dirname "$dest")"
      cp "$src" "$dest" || fail "could not add $path"
      ;;
    copy)
      [ -e "$dest" ] || fail "manifest says copy but $path is absent from upstream free-sleep; the base moved"
      cp "$src" "$dest" || fail "could not replace $path"
      ;;
    patch)
      # Handled below. Patches touch the pod's own file, so they cannot be
      # shipped as whole-file copies without dragging this tree's content in.
      ;;
    *)
      fail "unknown manifest mode '$mode' for $path"
      ;;
  esac
done < "$PAYLOAD/MANIFEST"

# Patch 1: register the update route. Two lines is the whole difference.
ROUTES="$FRESH/server/src/setup/routes.ts"
python3 -I - "$ROUTES" <<'PY' || fail "routes.ts patch failed"
import sys
p = sys.argv[1]
s = open(p).read()
if "routes/update/update.js" in s:
    sys.exit("routes.ts already imports the update route")
anchor = "import logger from '../logger.js';"
if anchor not in s:
    sys.exit("routes.ts does not carry the expected import anchor; this base needs a human")
s = s.replace(anchor, "import update from '../routes/update/update.js';\n" + anchor, 1)
reg = "  app.use('/api/', settings);"
if reg not in s:
    sys.exit("routes.ts does not carry the expected registration anchor; this base needs a human")
s = s.replace(reg, reg + "\n  app.use('/api/', update);", 1)
open(p, "w").write(s)
PY
grep -q "routes/update/update.js" "$ROUTES" || fail "routes.ts import patch did not apply"
grep -q "app.use('/api/', update);" "$ROUTES" || fail "routes.ts registration patch did not apply"

# Patch 2: the test script entry. The agent carries the first test files this
# install has ever had, and upstream free-sleep has no runner entry to run them with.
python3 -I - "$FRESH/server/package.json" "$PAYLOAD/test-script" <<'PY' || fail "package.json patch failed"
import json, sys
pkg_path, script_path = sys.argv[1], sys.argv[2]
pkg = json.load(open(pkg_path))
if pkg.get("scripts", {}).get("test"):
    sys.exit("upstream free-sleep already has a test script; the patch is obsolete")
pkg.setdefault("scripts", {})["test"] = open(script_path).read().strip()
open(pkg_path, "w").write(json.dumps(pkg, indent=2) + "\n")
PY

[ -f "$FRESH/server/dist/server.js" ] || fail "staged tree is missing server/dist/server.js"
[ -f "$FRESH/server/public/index.html" ] || fail "staged tree is missing server/public/index.html"
COPY=$(python3 -B "$FRESH/scripts/system_scripts.py" publish "$FRESH") \
  || fail "could not copy the scripts root runs; their server was never touched"
rm -rf "$STAGE"
move_tree "$FRESH" "$STAGE" || fail "could not stage the agent; their server was never touched"
rm -rf "$WORK"
chown -hR dac:dac "$STAGE"
write_status "stage" "ok" "agent applied to a copy of upstream free-sleep"

# ==============================================================================
# Dead-man sentinel, armed immediately before we touch their service.
# ==============================================================================
say "Arming dead-man sentinel (auto-restores their install in ${SENTINEL_MINUTES}m if this script dies)"
cp "$RESTORE_SCRIPT_SRC" "$RESTORE_SCRIPT_DEST" || fail "could not stage the restore script"
chmod +x "$RESTORE_SCRIPT_DEST"

cat > "/etc/systemd/system/$SENTINEL_SERVICE" <<EOF
[Unit]
Description=Agent bootstrap dead-man restore (fires only if the sentinel timer elapses)

[Service]
Type=oneshot
ExecStart=/bin/bash $RESTORE_SCRIPT_DEST
EOF

cat > "/etc/systemd/system/$SENTINEL_TIMER" <<EOF
[Unit]
Description=Agent bootstrap dead-man sentinel, restores the original install if the installer never disarms this

[Timer]
OnActiveSec=${SENTINEL_MINUTES}min
Persistent=true
Unit=$SENTINEL_SERVICE

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SENTINEL_TIMER" || fail "could not arm the dead-man sentinel; refusing to proceed without it"

disarm_sentinel() {
  systemctl disable --now "$SENTINEL_TIMER" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SENTINEL_SERVICE" "/etc/systemd/system/$SENTINEL_TIMER" 2>/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1 || true
}

restore_and_report() {
  say "Restoring their original install via $RESTORE_SCRIPT_DEST..."
  bash "$RESTORE_SCRIPT_DEST"
  disarm_sentinel
  write_status "install" "restored" "$1"
}

# ==============================================================================
# Swap
# ==============================================================================
write_status "swap" "in_progress" "stopping the running service"
say "Stopping their service (their tree is untouched up to this point)"
systemctl stop free-sleep >/dev/null 2>&1 || true
systemctl stop free-sleep-stream >/dev/null 2>&1 || true

rm -rf "$PREEXISTING_PREV"
if [ -d "$PREV" ]; then
  say "Pod already keeps a rollback tree at $PREV, setting it aside as $PREEXISTING_PREV"
  move_tree "$PREV" "$PREEXISTING_PREV" || { restore_and_report "could not set aside the existing rollback slot"; exit 1; }
fi
: > "$SWAP_MARKER"
move_tree "$LIVE" "$PREV" || { restore_and_report "could not move their tree aside"; exit 1; }
move_tree "$STAGE" "$LIVE" || { restore_and_report "could not move the staged tree into place"; exit 1; }
chown -hR dac:dac "$LIVE"

# NB: the rollback and revert units are STATIC, on-demand oneshots the app
# starts when the user requests rollback or switches to upstream free-sleep.
# Never `enable --now` them: that would run the action immediately.
# setup_services.sh installs them,
# without starting them, once the health check below has passed.

systemctl start free-sleep || { restore_and_report "the service failed to start after the overlay"; exit 1; }
systemctl start free-sleep-stream >/dev/null 2>&1 || true

# --- health check (same shape as update.sh and pod-installer.sh) --------------
say "Health check: waiting for /api/deviceStatus to answer 200"
HEALTHY=0
for _ in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/deviceStatus 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then HEALTHY=1; break; fi
  sleep 5
done

if [ "$HEALTHY" != "1" ]; then
  restore_and_report "the server did not answer 200 after the overlay"
  exit 1
fi

# Upstream free-sleep grants sudo for the updater and reboot only. Rollback,
# switching to upstream free-sleep, and disabling biometrics need extra units
# and rules. Install them after the health check so a failed overlay restores
# the original install before any of these changes.
say "Installing the updater, rollback, and revert services and their sudoers rules..."
bash "$COPY/scripts/setup_services.sh" "$COPY" \
  || say "WARNING: some services or sudoers rules could not be installed; the next in-app update retries them"

rm -f "$SWAP_MARKER"
disarm_sentinel
say "Agent bootstrap complete. Their upstream free-sleep tree is kept at $PREV for instant rollback."
write_status "install" "ok" "agent installed on upstream free-sleep"
