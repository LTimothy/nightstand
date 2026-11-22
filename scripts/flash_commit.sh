#!/bin/bash
# How often ext4 commits its journal on /persistent, for the Features switch
# "Write flash less often": long is every 60 s, default is the Pod's own 5 s.
# It applies at once and lasts until the next restart of the Pod; while the
# switch is on, the server applies it again when it starts. Nothing is saved.
# Usage: flash_commit.sh long|default   (run as root)
# To undo now: bash /usr/local/lib/nightstand/live/scripts/flash_commit.sh default
set -u
MOUNT_POINT="${NIGHTSTAND_PERSISTENT:-/persistent}"
MOUNTS="${NIGHTSTAND_PROC_MOUNTS:-/proc/mounts}"
MOUNT_BIN="${NIGHTSTAND_MOUNT_BIN:-mount}"

choice="usage"
[ $# -eq 1 ] && choice="$1"
case "$choice" in
  long) seconds=60 ;;
  default) seconds=5 ;;
  *)
    echo "Usage: flash_commit.sh long|default" >&2
    exit 2
    ;;
esac

if ! awk -v m="$MOUNT_POINT" '$2 == m && $3 == "ext4" { found = 1 } END { exit !found }' "$MOUNTS"; then
  echo "$MOUNT_POINT is not an ext4 mount; nothing changed." >&2
  exit 1
fi
"$MOUNT_BIN" -o "remount,commit=$seconds" "$MOUNT_POINT" || exit 1
echo "$MOUNT_POINT now commits every $seconds s until the next restart."
