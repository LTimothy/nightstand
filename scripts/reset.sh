#!/bin/bash
# Deletes Nightstand's settings, schedules and sleep data, then starts the
# server again with an empty database. Keeps the hardware socket path, which
# only the installer writes, so the server still reaches the Pod afterwards.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh" || exit 1

DATA_DIR=/persistent/free-sleep-data
SOCK_FILE="$DATA_DIR/dac_sock_path.txt"
WATCHDOG_MARK="$DATA_DIR/watchdog-trial"
SERVER_DIR=/home/dac/free-sleep/server
NPM=/home/dac/.volta/bin/npm

print_yellow() { echo -e "\033[0;33m$1\033[0m"; }

print_yellow "WARNING: This permanently deletes Nightstand's settings, schedules and sleep data in /persistent/free-sleep-data/."
print_yellow "Backups in /persistent/free-sleep-backups and /persistent/free-sleep-database-backups are kept; delete them too to remove all sleep data."
print_yellow "Nightstand starts again afterwards with empty settings."
read -r -p "Are you sure you want to continue? (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Cancelled"
  exit 0
fi

# Share admission with updates and stream reconciliation through service restarts.
if [ "${NIGHTSTAND_OPERATION_OWNER:-}" != "$$" ]; then
  OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
  if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
    OPERATION_LOCK=/tmp/free-sleep-operation.lock
  fi
  if [ -e "$OPERATION_LOCK" ]; then exec 9<"$OPERATION_LOCK"; else exec 9>>"$OPERATION_LOCK"; fi \
    || { echo "Cannot open the operation lock"; exit 1; }
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || { echo "Another update, rollback, switch, install or reset is already running"; exit 1; }
  else
    python3 -I -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null \
      || { echo "Another operation is already running (or lock unavailable)"; exit 1; }
  fi
  export NIGHTSTAND_OPERATION_OWNER=$$
fi

# Prints file $1 only when it is a plain file, never through a link the
# server user left in its folder.
read_plain() {
  python3 -I - "$1" <<'PY'
import os, stat, sys
descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, "rb") as handle:
    assert stat.S_ISREG(os.fstat(descriptor).st_mode)
    sys.stdout.buffer.write(handle.read(65536))
PY
}

SOCK_PATH=""
[ -f "$SOCK_FILE" ] && SOCK_PATH=$(read_plain "$SOCK_FILE" 2>/dev/null)
# The watchdog's trial file is kept too, byte for byte, so a failed trial or
# an owner's --remove still keeps it off. Empty means a trial never finished.
MARK=""
[ ! -f "$WATCHDOG_MARK" ] || MARK="$(read_plain "$WATCHDOG_MARK" 2>/dev/null && printf x)"
STREAM_WAS_ACTIVE=$(systemctl is-active free-sleep-stream 2>/dev/null || true)
ARCHIVE_WAS_ACTIVE=$(systemctl is-active free-sleep-archive-raw.timer 2>/dev/null || true)

# Whatever happens below, the server and the services it had start again.
# Once the data is gone, Biometrics reads off in the app, so the stream stays
# stopped and is disabled to match; enable_biometrics.sh turns it back on.
DATA_DELETED=no
restart_services() {
  systemctl start free-sleep
  if [ "$DATA_DELETED" = yes ]; then
    if systemctl cat free-sleep-stream >/dev/null 2>&1; then
      systemctl disable free-sleep-stream
      echo "Biometrics is off after the reset, so the biometrics stream stays stopped and disabled."
    fi
  elif [ "$STREAM_WAS_ACTIVE" = active ]; then
    systemctl restart free-sleep-stream
  fi
  [ "$ARCHIVE_WAS_ACTIVE" != active ] || systemctl start free-sleep-archive-raw.timer
}
trap restart_services EXIT

stop_writer() { restore_stop_writer "$@"; }

echo "Stopping Nightstand"
systemctl stop free-sleep-archive-raw.timer 2>/dev/null || true
if ! stop_writer free-sleep-stream || ! stop_writer free-sleep || ! stop_late_stream; then
  echo "Nightstand did not stop, so no data was deleted."
  exit 1
fi

echo "Deleting Nightstand data..."
rm -rf "$DATA_DIR"
# Only once its settings are really gone does Biometrics read off.
[ -e "$DATA_DIR/lowdb/servicesDB.json" ] || DATA_DELETED=yes
mkdir -p "$DATA_DIR/lowdb" "$DATA_DIR/logs"
[ -z "$SOCK_PATH" ] || printf '%s\n' "$SOCK_PATH" > "$SOCK_FILE"
[ -z "$MARK" ] || printf '%s' "${MARK%x}" > "$WATCHDOG_MARK"
chown -hR dac:dac "$DATA_DIR"
chmod 770 "$DATA_DIR"
chmod g+s "$DATA_DIR"

# server/package.json's migrate script applies the shipped migrations only.
echo "Creating an empty database..."
if ! sudo -u dac bash -c "cd '$SERVER_DIR' && '$NPM' run migrate"; then
  echo "WARNING: the database could not be created. Run fs-update or reinstall before relying on the Pod."
  exit 1
fi
echo "Done. Nightstand is starting with empty settings; set your schedules again."
