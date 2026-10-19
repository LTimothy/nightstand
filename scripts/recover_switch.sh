#!/bin/bash
# Restores uncommitted switches offline, before systemd releases writer startup.
set -euo pipefail
# Root runs this; never resolve tools or Python modules from the caller's environment.
export PATH="${NIGHTSTAND_RECOVERY_PATH:-/usr/sbin:/usr/bin:/sbin:/bin}"
TRANSACTIONS="${NIGHTSTAND_TRANSACTION_ROOT:-/persistent/free-sleep-maintenance/nightstand-transactions}"
# Ordinary startup needs no Python, service state or maintenance lock.
RECOVERY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$RECOVERY_DIR/restore_helpers.sh"
if ! has_switch_journal "$TRANSACTIONS"; then
  if [ -e "$TRANSACTIONS" ] && { [ ! -d "$TRANSACTIONS" ] || [ ! -r "$TRANSACTIONS" ] || [ ! -x "$TRANSACTIONS" ]; }; then
    echo 'Warning: switch journals could not be inspected; allowing startup without a known journal' >&2
  fi
  exit 0
fi
HELPER="$RECOVERY_DIR/recover_switch.py"
OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
  OPERATION_LOCK=/tmp/free-sleep-operation.lock
fi
case "${1:-}" in
  --startup-check) exec python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" startup-check --unit "${2:-}" --operation-lock "$OPERATION_LOCK" ;;
  --check) exec python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" check ;;
  "") ;;
  *) echo 'Unknown switch recovery argument' >&2; exit 1 ;;
esac

# Ordinary updates may restart services while holding the same lock. With no
# unfinished switch there is no live restoration to serialize.
if python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" check 2>/dev/null; then
  # Finish removing what a recovered switch left, if a removal was cut short.
  python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" cleanup || true
  exit 0
fi

# Controlled starts can pull in this unit through Wants after a journal is
# armed. The writer gates still enforce the separate validation permission.
if python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" operation-active --operation-lock "$OPERATION_LOCK" 2>/dev/null; then
  exit 0
fi

# Descendants can retain the operation lock after their parent was killed.
python3 -E -s -B "$HELPER" --root "$TRANSACTIONS" stop-operations
if [ -e "$OPERATION_LOCK" ]; then
  exec 9<"$OPERATION_LOCK"
else
  exec 9>>"$OPERATION_LOCK"
fi
python3 -I - <<'PY'
import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit('Another maintenance operation holds the lock; switch recovery deferred')
PY
restore_switch_offline "$RECOVERY_DIR" "$TRANSACTIONS"
