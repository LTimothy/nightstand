#!/bin/bash
# Puts a migration target's original install back exactly the way it was
# found. This is the fork-switch tool's safety net: it's copied to
# /usr/local/lib/nightstand/restore-original-fork.sh BEFORE the swap
# so it survives regardless of what state either tree ends up in, and it's
# called from two places:
#
#   1. pod-installer.sh's own failure path (attended: the installer is still
#      running and calls this directly when something goes wrong pre- or
#      post-swap).
#   2. The dead-man sentinel (unattended: a persistent systemd timer armed
#      right before the swap and disarmed right after a successful health
#      check, if the installer is killed, OOM'd, or the pod loses power
#      mid-swap, this timer fires this same script on its own within
#      minutes, with no laptop or user needed).
#
# Idempotent by design, safe to run whether the swap never happened, half
# happened, or already happened: tree moves require the installer's swap marker
# ($SWAP_MARKER exists). Restore state separates completed tree recovery from
# pending artifact restoration. Every step tolerates its target already being
# absent/undone. The marker, not the mere existence of
# $PREV, is the signal, because the pod's own updater may keep an unrelated
# rollback tree at $PREV from before we ever ran; keying off $PREV alone would
# both mistake that stale tree for the install we swapped out and wrongly undo a
# migration that already succeeded (its marker is gone). $PREV uses the same path
# update.sh/rollback_pod.sh use for "the previous tree" deliberately: on success
# this directory becomes the in-app instant-rollback slot, so the migrated pod's
# Settings page recognizes it immediately.
set -uo pipefail

# Durable switch journals take precedence over the older migration markers.
TRANSACTION_ROOT="${NIGHTSTAND_TRANSACTION_ROOT:-/persistent/free-sleep-maintenance/nightstand-transactions}"
RESTORE_HELPER_SOURCE="$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh"
[ -f "$RESTORE_HELPER_SOURCE" ] || RESTORE_HELPER_SOURCE="$(dirname "${BASH_SOURCE[0]}")/../restore_helpers.sh"
[ -f "$RESTORE_HELPER_SOURCE" ] || RESTORE_HELPER_SOURCE=/usr/local/lib/nightstand/migrate/restore_helpers.sh
source "$RESTORE_HELPER_SOURCE" || exit 1
if has_switch_journal "$TRANSACTION_ROOT"; then
  SWITCH_RECOVERY=/usr/local/lib/nightstand/switch-recovery/recover_switch.sh
  [ -f "$SWITCH_RECOVERY" ] || { echo "Switch recovery helper is missing" >&2; exit 1; }
  PENDING_SWITCH=$(python3 -B /usr/local/lib/nightstand/switch-recovery/recover_switch.py --root "$TRANSACTION_ROOT" pending) || exit 1
  if [ "${NIGHTSTAND_OPERATION_OWNER:-}" = "$PPID" ]; then
    restore_switch_offline /usr/local/lib/nightstand/switch-recovery "$TRANSACTION_ROOT" || exit 1
  else
    bash "$SWITCH_RECOVERY" || exit 1
  fi
  [ -z "$PENDING_SWITCH" ] || exit 0
fi

LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
# The installer stashes any pre-existing $PREV here so we can put the pod's own
# rollback slot back exactly as we found it; $SWAP_MARKER is its swap-in-progress flag.
PREEXISTING_PREV=/home/dac/free-sleep-prev-preexisting
MIGRATE_STATE=/persistent/nightstand-migrate
SWAP_MARKER=$MIGRATE_STATE/free-sleep-migrate-swapped
RESTORE_STATE=$MIGRATE_STATE/free-sleep-migrate-restore-state
ABORTED_QUARANTINE=/home/dac/free-sleep-migrate-aborted
IPTABLES_SNAPSHOT=$MIGRATE_STATE/free-sleep-migrate-iptables-snapshot.rules
STATUS_FILE=/persistent/free-sleep-data/migration-status.json
SENTINEL_UNIT=free-sleep-migrate-sentinel.timer
SYSTEMD_DIR=/etc/systemd/system
PID_FILE=$MIGRATE_STATE/free-sleep-migrate.pid
STAGE=/home/dac/free-sleep-migrate-staging
ZIP=/home/dac/free-sleep-migrate.zip

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] restore-original-fork: $*"; }

write_status() {
  # $1=outcome $2=message, best-effort, never fatal. Replaced, never
  # written through, since the data folder belongs to the server user.
  python3 -I - "$STATUS_FILE" "$(printf '{"stage":"%s","outcome":"%s","message":"%s","timestamp":"%s"}' \
    "restore" "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" 2>/dev/null <<'PY' || true
import os, sys, tempfile
path, text = sys.argv[1:]
os.makedirs(os.path.dirname(path), exist_ok=True)
descriptor, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".migration-status.")
try:
    with os.fdopen(descriptor, "w") as handle:
        handle.write(text + "\n")
        os.fchmod(handle.fileno(), 0o644)
    os.replace(tmp, path)
except BaseException:
    os.unlink(tmp)
    raise
PY
}
# Root keeps its migration state and logs where the server user cannot add
# links: a real folder under /persistent that root owns.
own_folder() {
  [ ! -L "$1" ] || rm -f "$1"
  mkdir -p "$1" && [ ! -L "$1" ] && [ -O "$1" ] && chmod "$2" "$1"
}

disarm_sentinel() {
  systemctl disable --now "$SENTINEL_UNIT" >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_DIR/$SENTINEL_UNIT" "$SYSTEMD_DIR/free-sleep-migrate-sentinel.service" 2>/dev/null || true
  systemctl daemon-reload >/dev/null 2>&1 || true
}

restore_iptables() {
  if [ -f "$IPTABLES_SNAPSHOT" ]; then
    say "Restoring pre-migration iptables snapshot"
    iptables-restore < "$IPTABLES_SNAPSHOT" 2>/dev/null || say "WARNING: iptables-restore failed"
  fi
}

restore_legacy_artifacts() {
  [ -f /persistent/nightstand-migrate-artifacts/pending ] || [ -f /home/dac/free-sleep-migrate-artifacts/pending ] || return 0
  bash /usr/local/lib/nightstand/migrate/fork-artifacts.sh restore || {
    say "WARNING: legacy artifact restore failed; keeping the sentinel for another attempt"
    return 1
  }
}

record_restore_state() {
  if ! own_folder "$MIGRATE_STATE" 700 || ! printf '%s\n' "$1" > "$RESTORE_STATE.tmp" \
    || ! mv "$RESTORE_STATE.tmp" "$RESTORE_STATE"; then
    say "FATAL: could not record restore progress; keeping the recovery markers"
    write_status "restore_failed" "could not record restore progress"
    exit 1
  fi
  sync
}

finish_artifact_restore() {
  # Tree and service recovery is complete. A retry must only restore artifacts.
  record_restore_state artifacts-pending
  rm -f "$SWAP_MARKER" || exit 1
  sync
  if ! restore_legacy_artifacts; then
    write_status "restore_failed" "original install recovered; legacy cron or unit files still need restoration"
    exit 1
  fi
  # Retire restore progress before allowing another migration to start.
  rm -f "$RESTORE_STATE" || exit 1
  sync
  disarm_sentinel
  cleanup_temporary_files
  write_status "$1" "$2"
  say "Done."
}

cleanup_nightstand_services() {
  # Remove only files owned by Nightstand. Preserve other drop-ins.
  systemctl disable --now free-sleep-archive-raw.timer free-sleep-health.timer free-sleep-network-watchdog.timer >/dev/null 2>&1 || true
  systemctl stop free-sleep-archive-raw.service >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_DIR/free-sleep-archive-raw.timer" "$SYSTEMD_DIR/free-sleep-archive-raw.service" \
    "$SYSTEMD_DIR/free-sleep-health.timer" "$SYSTEMD_DIR/free-sleep-health.service" \
    "$SYSTEMD_DIR/free-sleep-network-watchdog.timer" "$SYSTEMD_DIR/free-sleep-network-watchdog.service" \
    "$SYSTEMD_DIR/free-sleep.service.d/10-nightstand-limits.conf" \
    "$SYSTEMD_DIR/free-sleep-stream.service.d/10-nightstand-limits.conf"
  systemctl daemon-reload >/dev/null 2>&1 || true
}

# Their stream comes back only if their Pod had it enabled. The migration
# stops it but never enables or disables it, and this can run after a reboot,
# so systemd's saved state is the record of their choice.
start_stream_if_enabled() {
  if [ "$(systemctl is-enabled free-sleep-stream 2>/dev/null)" = enabled ]; then
    systemctl start free-sleep-stream >/dev/null 2>&1 || true
  fi
}

cleanup_temporary_files() {
  rm -rf "$ABORTED_QUARANTINE" "$STAGE" "$STAGE.unzip"
  rm -f "$ZIP" "$PID_FILE" "$IPTABLES_SNAPSHOT" "$MIGRATE_STATE/free-sleep-migrate.lock" \
    "$MIGRATE_STATE/free-sleep-migrate-baseline.json"
}

stop_active_installer() {
  # systemd stops the entire installer cgroup, including npm/Prisma children.
  if systemctl is-active --quiet free-sleep-migrate.service; then
    systemctl stop free-sleep-migrate.service || return 1
  elif [ -f "$PID_FILE" ]; then
    local installer_pid installer_group
    installer_pid=$(cat "$PID_FILE")
    case "$installer_pid" in ''|*[!0-9]*) return 1 ;; esac
    if kill -0 "$installer_pid" 2>/dev/null; then
      # The nohup launcher uses setsid. Refuse to kill an unrelated process or
      # restore alongside a runner whose descendants cannot be stopped safely.
      [ "$installer_pid" != "$$" ] && [ "$installer_pid" != "$PPID" ] || return 1
      tr '\0' ' ' < "/proc/$installer_pid/cmdline" | grep -q '/migrate/pod-installer.sh' || return 1
      installer_group=$(ps -o pgid= -p "$installer_pid" | tr -d ' ')
      [ "$installer_group" = "$installer_pid" ] || return 1
      kill -STOP -- "-$installer_group" || return 1
      kill -KILL -- "-$installer_group" || return 1
    fi
  fi
}

if [ "${1:-}" = "--sentinel" ]; then
  stop_active_installer || {
    say "FATAL: could not stop active installer; refusing a concurrent restore"
    write_status "restore_failed" "installer could not be stopped safely"
    exit 1
  }
fi

if [ "$(cat "$RESTORE_STATE" 2>/dev/null)" = artifacts-pending ]; then
  say "Original install recovery completed; retrying legacy artifact restoration only."
  finish_artifact_restore "auto-restored" "original fork recovered; legacy artifacts restored"
  exit 0
fi

if [ ! -f "$SWAP_MARKER" ]; then
  say "No swap marker, the swap never began (or already completed successfully)."
  # If the installer set the pod's own rollback slot aside but died before the
  # swap, put it back so their instant-rollback still works. When $PREV is
  # already present it's the pod's own untouched slot, leave it alone.
  if [ ! -d "$PREV" ] && [ -d "$PREEXISTING_PREV" ]; then
    say "Restoring the pod's pre-existing rollback slot to $PREV"
    move_tree "$PREEXISTING_PREV" "$PREV" 2>/dev/null || say "WARNING: could not restore $PREV"
  fi
  restore_iptables
  # pod-installer.sh may have already stopped their service before hitting a
  # failure that lands here (e.g. it failed to even move $LIVE aside);
  # restarting is a safe no-op if it's already running.
  systemctl start free-sleep >/dev/null 2>&1 || true
  start_stream_if_enabled
  finish_artifact_restore "no_op" "no swap in progress; legacy artifacts restored"
  exit 0
fi

say "Swap marker present, reverting the migration to the original install."

systemctl stop free-sleep >/dev/null 2>&1 || true
systemctl stop free-sleep-stream >/dev/null 2>&1 || true

# $PREV holds their original tree only if the $LIVE->$PREV move completed. If we
# died between the marker and that move, $LIVE still holds their tree untouched,
# so don't quarantine it; just fall through to restoring their rollback slot.
if [ "$(cat "$RESTORE_STATE" 2>/dev/null)" != trees-restored ] && [ -d "$PREV" ]; then
  if [ -d "$LIVE" ]; then
    rm -rf "$ABORTED_QUARANTINE"
    move_tree "$LIVE" "$ABORTED_QUARANTINE" || {
      say "FATAL: could not move $LIVE aside. The original tree remains at $PREV; manual recovery may be required."
      write_status "restore_failed" "could not move current tree aside; original tree preserved"
      # Keep the marker and sentinel: moving PREV into an existing LIVE would
      # nest it inside the failed build instead of restoring it.
      exit 1
    }
  fi
  move_tree "$PREV" "$LIVE" || {
    say "FATAL: could not move $PREV into place. Manual recovery needed:"
    say "  the untouched original tree is at $PREV"
    write_status "restore_failed" "could not move original tree into place"
    exit 1
  }
fi

# Record this before putting an older rollback slot back at PREV.
record_restore_state trees-restored

# Put the pod's own pre-existing rollback slot back exactly where it was, so
# their updater's instant-rollback still works after we bow out. $PREV is now
# free (moved into $LIVE just above, or never populated).
if [ -d "$PREEXISTING_PREV" ]; then
  say "Restoring the pod's pre-existing rollback slot to $PREV"
  rm -rf "$PREV"
  move_tree "$PREEXISTING_PREV" "$PREV" 2>/dev/null || say "WARNING: could not restore the pod's pre-existing rollback slot at $PREV"
fi

cleanup_nightstand_services
restore_iptables

say "Starting their original service"
systemctl start free-sleep >/dev/null 2>&1 \
  || say "WARNING: 'systemctl start free-sleep' failed, their fork may use a different service name; the tree is restored regardless"
start_stream_if_enabled

sleep 8
if curl -sf --max-time 5 "http://127.0.0.1:3000/api/deviceStatus" >/dev/null 2>&1 \
  || curl -sf --max-time 5 "http://127.0.0.1:3000/" >/dev/null 2>&1; then
  say "Their original install is back and responding."
  RESTORE_MESSAGE="original fork restored and responding"
else
  say "Original tree restored but not yet responding, it may just be starting up. Check: systemctl status free-sleep"
  RESTORE_MESSAGE="original fork restored; health not yet confirmed"
fi

finish_artifact_restore "auto-restored" "$RESTORE_MESSAGE"
