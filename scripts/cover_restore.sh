#!/bin/bash
# Restarts the firmware service that owns the cover link, for the Cover
# sensors restart on System status. It runs at most once an hour and logs each
# attempt or refusal. It changes nothing persistent besides its stamp and log.
# It refuses while an update, rollback or revert runs; alarm and priming state
# live in the server, which checks them before it calls this script.
# Usage: cover_restore.sh   (no arguments, run as root)
set -u
export PATH="/usr/sbin:/sbin:/usr/bin:/bin"
LOG_DIR="${NIGHTSTAND_OPS_LOG_DIR:-/persistent/nightstand-logs}"
SYSTEMCTL="${NIGHTSTAND_SYSTEMCTL:-systemctl}"
UNIT=frank.service
LOG="$LOG_DIR/cover-restore.log"
STAMP="$LOG_DIR/cover-restore.stamp"

if [ $# -ne 0 ]; then
  echo "Usage: cover_restore.sh" >&2
  exit 2
fi

if [ -L "$LOG_DIR" ] || [ ! -d "$LOG_DIR" ]; then
  echo "cover_restore: refused: $LOG_DIR is missing or a link" >&2
  exit 1
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG"; }

state=$("$SYSTEMCTL" show "$UNIT" --property=LoadState --value 2>/dev/null)
if [ "$state" != "loaded" ]; then
  log "refused: $UNIT is ${state:-unknown}"
  exit 1
fi

for op in free-sleep-update.service free-sleep-rollback.service free-sleep-revert.service; do
  active=$("$SYSTEMCTL" show "$op" --property=ActiveState --value 2>/dev/null)
  case "$active" in
    inactive|failed) ;;
    *) log "refused: $op is ${active:-unknown}"; exit 1 ;;
  esac
done

if [ -n "$(find "$STAMP" -mmin -60 2>/dev/null)" ]; then
  log "refused: restarted less than an hour ago"
  exit 3
fi

bash "$(dirname "${BASH_SOURCE[0]}")/trim_log.sh" "$LOG"
# Stamped first, so a restart that fails still counts toward the hourly limit.
touch "$STAMP" || { log "refused: cannot write $STAMP"; exit 1; }
log "restarting $UNIT"
if "$SYSTEMCTL" restart "$UNIT"; then
  log "restarted"
else
  log "restart failed"
  exit 1
fi
