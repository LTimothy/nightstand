#!/bin/bash
# Restarts Nightstand's server when it is running but has stopped answering,
# since schedules and alarms run inside it. Runs every minute from
# free-sleep-health.timer. A stopped server is left alone, and so is one that
# an update, rollback or switch is replacing, or one that started less than
# two minutes ago.
set -u

STATE="${NIGHTSTAND_HEALTH_STATE:-/run/free-sleep-health.failures}"
LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
[ -n "${NIGHTSTAND_OPERATION_LOCK:-}" ] || [ -d /run/lock ] || LOCK=/tmp/free-sleep-operation.lock
PROC_LOCKS="${NIGHTSTAND_PROC_LOCKS:-/proc/locks}"
UPTIME="${NIGHTSTAND_UPTIME:-/proc/uptime}"
LIMIT=3
STARTUP_GRACE=120

# Reads /proc/locks rather than taking the lock, which for that moment would
# make an update starting at the same time refuse to run. Locks are listed as
# major:minor:inode, with the device in hex; without python3 only the inode
# is compared, and a match on another device only skips the check.
lock_held() {
  local key
  [ -e "$LOCK" ] || return 1
  key=$(python3 -I -c 'import os, sys; s = os.stat(sys.argv[1]); print("%02x:%02x:%d" % (os.major(s.st_dev), os.minor(s.st_dev), s.st_ino))' "$LOCK" 2>/dev/null) \
    || key=":$(ls -i "$LOCK" 2>/dev/null | awk '{ print $1 }')"
  if [ "$key" != : ] && [ -r "$PROC_LOCKS" ]; then
    awk -v key="$key" '{ for (i = 1; i <= NF; i++) if (split($i, part, ":") == 3 && ($i == key || ":" part[3] == key)) found = 1 }
      END { exit !found }' "$PROC_LOCKS"
    return
  fi
  if command -v flock >/dev/null 2>&1; then
    ! flock -n "$LOCK" true
  else
    ! python3 -I -c 'import fcntl, sys; fcntl.flock(open(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)' "$LOCK" 2>/dev/null
  fi
}

# True while the server has been active for less than STARTUP_GRACE seconds.
# Unknown counts as settled.
just_started() {
  local since now
  since=$(systemctl show -p ActiveEnterTimestampMonotonic free-sleep 2>/dev/null | sed -n 's/^ActiveEnterTimestampMonotonic=//p')
  now=$(awk '{ print int($1) }' "$UPTIME" 2>/dev/null)
  case "$since" in '' | 0 | *[!0-9]*) return 1 ;; esac
  case "$now" in '' | *[!0-9]*) return 1 ;; esac
  [ $((now - since / 1000000)) -lt "$STARTUP_GRACE" ]
}

if [ "$(systemctl is-active free-sleep 2>/dev/null)" != active ] || lock_held || just_started; then
  rm -f "$STATE"
  exit 0
fi

# Only curl's 000, no answer at all, counts. An error status is still an
# answer, and with a full or read-only /persistent a restarted server might
# not start again. No output means curl itself did not run, which says
# nothing about the server. The liveness route writes no files.
CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/serverStatus/alive 2>/dev/null)
if [ "$CODE" != 000 ]; then
  rm -f "$STATE"
  exit 0
fi

FAILS=$(cat "$STATE" 2>/dev/null)
case "$FAILS" in '' | *[!0-9]*) FAILS=0 ;; esac
FAILS=$((FAILS + 1))
if [ "$FAILS" -ge "$LIMIT" ]; then
  rm -f "$STATE"
  echo "Nightstand did not answer $LIMIT checks in a row; restarting it"
  systemctl restart free-sleep --no-block
else
  echo "$FAILS" > "$STATE"
fi
