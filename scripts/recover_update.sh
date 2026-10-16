#!/bin/bash
# Recovers only a marked update swap. Installed outside the trees it moves.
set -euo pipefail

LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
FAILED=/home/dac/free-sleep-failed
STAGE=/home/dac/free-sleep-staging
MARKER=/persistent/free-sleep-data/update-swap.json
RESULT_FILE=/persistent/free-sleep-data/update-result.json
RESULT_WRITER="$(dirname "${BASH_SOURCE[0]}")/write_result.py"
RESTORE_HELPERS="$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh"
RECOVERY_DEADLINE=$((SECONDS + 50))

say() { echo "$*"; }
record_recovery() {
  python3 "$RESULT_WRITER" "$RESULT_FILE" update "$1" "$RECOVERY_FROM" "$RECOVERY_TO" "$2"
}

fail() {
  say "Recovery stopped: $*"
  if [ -n "${RECOVERY_FROM:-}" ]; then
    record_recovery failed "The update was interrupted. Recovery stopped: $*" || true
  fi
  exit 1
}

clear_marker() {
  sync
  python3 -I - "$MARKER" <<'PY'
import os, sys
path = sys.argv[1]
if os.path.exists(path):
    os.unlink(path)
    descriptor = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

case "${1:-}" in
  --arm)
    python3 -I - "$MARKER" "$LIVE" "${2:-inactive}" "${3:-}" <<'PY'
import json, os, sys
path, live, stream, target = sys.argv[1:]
stream = "active" if stream == "active" else "inactive"
if os.path.exists(path):
    sys.exit("An earlier update swap still needs recovery")
info = os.stat(live)
version = json.load(open(live + "/server/src/serverInfo.json"))["version"]
with open(path + ".tmp", "w") as handle:
    json.dump({"device": info.st_dev, "inode": info.st_ino, "version": version,
               "stream": stream, "toVersion": target or None}, handle)
    handle.flush()
    os.fsync(handle.fileno())
os.replace(path + ".tmp", path)
descriptor = os.open(os.path.dirname(path), os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
    exit ;;
  --clear) clear_marker; exit ;;
  --settle-restored) SETTLE_RESTORED=yes ;;
  "") ;;
  *) fail "unknown argument" ;;
esac

[ -f "$MARKER" ] || exit 0
OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
  OPERATION_LOCK=/tmp/free-sleep-operation.lock
fi
if [ "${SETTLE_RESTORED:-no}" != yes ] || [ "${NIGHTSTAND_OPERATION_OWNER:-}" != "$PPID" ]; then
  exec 9>>"$OPERATION_LOCK" || fail "cannot open the operation lock"
  LOCK_DEADLINE=$((SECONDS + 30))
  if command -v flock >/dev/null 2>&1; then
    until flock -n 9; do
      [ "$SECONDS" -lt "$LOCK_DEADLINE" ] || fail "another install, update, rollback or switch is already running"
      sleep 2
    done
  else
    until python3 -I -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null; do
      [ "$SECONDS" -lt "$LOCK_DEADLINE" ] || fail "another operation is running (or lock unavailable)"
      sleep 2
    done
  fi
fi
[ -f "$MARKER" ] || exit 0
STREAM_WAS_ACTIVE=$(python3 -I - "$MARKER" 2>/dev/null <<'PY'
import json, sys
marker = json.load(open(sys.argv[1]))
assert isinstance(marker["device"], int) and isinstance(marker["inode"], int)
assert isinstance(marker["version"], str)
assert marker.get("toVersion") is None or isinstance(marker["toVersion"], str)
assert marker["stream"] in ("active", "inactive", "failed", "unknown", "")
print(marker["stream"])
PY
) || fail "unreadable swap marker; manual recovery required"

RECOVERY_FROM=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$MARKER")
RECOVERY_TO=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("toVersion") or "")' "$MARKER")

# The original tree may already be live if recovery itself was interrupted.
matches_marker() {
  python3 -I - "$MARKER" "$1" 2>/dev/null <<'PYMARKER'
import json, os, sys
marker = json.load(open(sys.argv[1]))
info = os.stat(sys.argv[2])
assert (info.st_dev, info.st_ino) == (marker["device"], marker["inode"])
assert json.load(open(sys.argv[2] + "/server/src/serverInfo.json"))["version"] == marker["version"]
PYMARKER
}
source "$RESTORE_HELPERS"

HBODY=$(mktemp)
trap 'rm -f "$HBODY"' EXIT

# Boot recovery has a shorter check window than an interactive update.
healthy_live() {
  [ -d "$LIVE" ] || return 1
  local version code attempts=${1:-3}
  version=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$LIVE/server/src/serverInfo.json" 2>/dev/null) || return 1
  for _ in $(seq 1 "$attempts"); do
    [ "$SECONDS" -lt "$RECOVERY_DEADLINE" ] || return 1
    sleep 2
    code=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 2 \
      http://127.0.0.1:3000/api/deviceStatus 2>/dev/null) || continue
    [ "$code" = 200 ] || continue
    python3 -I - "$HBODY" "$version" <<'PY' || continue
import json, sys
try:
    status = json.load(open(sys.argv[1]))
    assert status["freeSleep"]["version"] == sys.argv[2]
    assert isinstance(status["left"]["currentTemperatureF"], (int, float))
except (OSError, ValueError, KeyError, TypeError, AssertionError):
    sys.exit(1)
PY
    systemctl is-active free-sleep >/dev/null 2>&1 || continue
    if ! matches_marker "$LIVE"; then
      code=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 2 \
        http://127.0.0.1:3000/api/serverStatus 2>/dev/null) || continue
      [ "$code" = 200 ] || continue
      python3 -I - "$HBODY" <<'PYDATABASE' || continue
import json, sys
try:
    status = json.load(open(sys.argv[1]))
    assert status["database"]["status"] == "healthy"
    assert not status["database"].get("unappliedMigrations")
except (OSError, ValueError, KeyError, TypeError, AssertionError):
    sys.exit(1)
PYDATABASE
    fi
    return 0
  done
  return 1
}

if [ "${SETTLE_RESTORED:-no}" = yes ]; then
  matches_marker "$LIVE" || fail "the original tree was not restored; marker kept"
  healthy_live 15 || fail "the restored install did not pass its health check; marker kept"
  follow_scripts
  clear_marker
  exit 0
fi

if healthy_live; then
  if matches_marker "$LIVE"; then
    record_recovery rolled-back "The update was interrupted. The original install is healthy." \
      || fail "could not record recovery; marker kept"
  else
    record_recovery success "The update was interrupted. The target install passed boot recovery checks." \
      || fail "could not record recovery; marker kept"
  fi
  follow_scripts
  clear_marker
  say "The live install is healthy; cleared the interrupted update marker"
  exit 0
fi

if matches_marker "$PREV"; then
  RESTORE_FROM=$PREV
elif matches_marker "$LIVE"; then
  RESTORE_FROM=$LIVE
else
  fail "the original tree does not match the swap marker; manual recovery required"
fi

stop_writer() {
  restore_stop_writer "$@"
}
if systemctl is-active free-sleep-stream >/dev/null 2>&1; then
  STREAM_WAS_ACTIVE=active
fi
if ! stop_writer free-sleep || ! stop_writer free-sleep-stream; then
  fail "a database writer did not stop; both trees and the marker were kept"
fi
if [ "$RESTORE_FROM" = "$PREV" ]; then
  SET_ASIDE=no
  if [ -d "$LIVE" ]; then
    rm -rf "$FAILED"
    move_tree "$LIVE" "$FAILED" || {
      restore_restart_services best-effort || true
      fail "could not preserve the failed tree"
    }
    SET_ASIDE=yes
  fi
  move_tree "$PREV" "$LIVE" || {
    if [ "$SET_ASIDE" = yes ] && move_tree "$FAILED" "$LIVE"; then
      restore_restart_services best-effort || true
    fi
    fail "could not restore the previous tree; marker kept"
  }
fi
for source in "$FAILED" "$STAGE"; do
  restore_dependencies "$source"
done
restore_restart_services strict || fail "${RESTORE_SERVICE_ERROR:-could not restart restored services}; marker kept"

if healthy_live 15; then
  record_recovery rolled-back "The update was interrupted. Boot recovery restored the previous install." \
    || fail "could not record recovery; marker kept"
  follow_scripts
  clear_marker
  say "Restored the previous install after an interrupted update"
else
  fail "the restored install did not pass its health check; marker kept for manual recovery"
fi
