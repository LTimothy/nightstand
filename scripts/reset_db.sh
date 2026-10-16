#!/bin/bash
set -euo pipefail

print_yellow() {
  echo -e "\033[0;33m$1\033[0m"
}

SERVICES_DB=/persistent/free-sleep-data/lowdb/servicesDB.json

# The stream starts again only while Biometrics is on in the app.
biometrics_on() {
  python3 -I -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1]))["biometrics"]["enabled"] is True else 1)' "$SERVICES_DB" 2>/dev/null
}
start_services() {
  systemctl start free-sleep
  if biometrics_on; then
    systemctl start free-sleep-stream
  fi
}


print_yellow "WARNING: This will permanently delete all Nightstand biometric data!"
print_yellow "After deleting, this will recreate the DB"
read -p "Are you sure you want to continue? (y/N): " confirm


if [[ "$confirm" =~ ^[Yy]$ ]]; then
  # Recovery also runs when the copy aside or the migration exits under set -e.
  restart_on_failure() {
    result=$?
    if [ "$result" -ne 0 ]; then
      start_services || true
    fi
  }
  trap restart_on_failure EXIT
  systemctl stop free-sleep free-sleep-stream
  DATABASE="/persistent/free-sleep-data/free-sleep.db"
  if [ -f "$DATABASE" ]; then
    SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    BACKUPS=/persistent/free-sleep-database-backups
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    BACKUP="$BACKUPS/$STAMP-reset.db"
    if python3 "$SCRIPT_DIR/sqlite-safety.py" checkpoint "$DATABASE" &&
      python3 "$SCRIPT_DIR/sqlite-safety.py" backup "$DATABASE" "$BACKUP"; then
      echo "Database backup saved to $BACKUP"
      bash "$SCRIPT_DIR/prune_db_snapshots.sh" "$BACKUPS" "$BACKUP" || true
    else
      # A damaged database fails the checked copy. Keep the files as they
      # are, with any WAL, so a reset still works; pruning never removes them.
      RAW="$BACKUPS/$STAMP-reset-raw.db"
      echo "The database could not be copied cleanly and may be damaged; copying the file as it is instead."
      mkdir -p "$BACKUPS"
      for suffix in "" -wal -journal; do
        if [ -f "$DATABASE$suffix" ] && ! cp "$DATABASE$suffix" "$RAW$suffix"; then
          echo "Could not copy $DATABASE$suffix aside; nothing was deleted."
          exit 1
        fi
      done
      echo "Database file copied as it was to $RAW"
    fi
  fi
  rm -f /persistent/free-sleep-data/free-sleep.db-shm \
        /persistent/free-sleep-data/free-sleep.db-wal \
        /persistent/free-sleep-data/free-sleep.db-journal \
        /persistent/free-sleep-data/free-sleep.db

  su - dac -c "cd /home/dac/free-sleep/server && /home/dac/.volta/bin/npx dotenv -e .env.pod -- npx prisma migrate deploy && exit"

  start_services
else
    echo "Cancelled"
fi
