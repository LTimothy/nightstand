#!/bin/bash
# Restarts the Pod when its Wi-Fi has died and cannot come back by itself.
# The stock Wi-Fi driver can crash and leave the Pod running but unreachable
# until it is unplugged. Runs every minute from
# free-sleep-network-watchdog.timer, and only where that driver is loaded.
#
# It restarts when the driver crashed this boot and the network has been down
# for 5 minutes, or when the network has been down for 20 minutes and Wi-Fi
# scans failed the whole time. A router that is away while scans still work
# never counts. Nothing happens in the first 10 minutes after boot or while
# an update, rollback, switch, install, reset or biometrics install runs, and
# it restarts at most once in 6 hours and 3 times in 24.
#
# A restart after this crash can hang with PID 1 frozen, so it only
# restarts while systemd's hardware watchdog is on to reset a Pod whose
# shutdown hangs. Otherwise it leaves the Pod running as it is.
#
# Usage: network_watchdog.sh [--dry-run]   (run as root)
# --dry-run prints the decision and its inputs and changes nothing. With it,
# NIGHTSTAND_NETWATCH_NETWORK=up|down, NIGHTSTAND_NETWATCH_OOPS=yes|no,
# NIGHTSTAND_NETWATCH_DOWN_FOR and NIGHTSTAND_NETWATCH_SCAN_FAILING_FOR
# (seconds) replace what it would read.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -u

DRIVER=wlan_drv_gen4_MT7663
BOOT_GRACE=600     # no restart in the first 10 minutes after boot
OOPS_DOWN=300      # after a driver crash: 5 minutes without network
SCAN_DOWN=1200     # otherwise: 20 minutes without network, scans failing
SCAN_WINDOW=3      # minutes of journal checked for scan failures
SCAN_FAILURES=3    # a dead driver fails every 30 s; a busy one only now and then
MIN_GAP=21600      # at most one restart in 6 hours
DAY=86400
DAY_LIMIT=3        # and 3 in 24 hours
WAIT_LOG=1800      # while a restart waits, log it again every 30 minutes

STATE="${NIGHTSTAND_NETWATCH_STATE:-/persistent/free-sleep-data/network-watchdog}"
MODULE="${NIGHTSTAND_NETWATCH_MODULE:-/sys/module/$DRIVER}"
PROBE_SECONDS="${NIGHTSTAND_NETWATCH_PROBE_SECONDS:-10}"
ROUTES="${NIGHTSTAND_ROUTES:-/proc/net/route}"
BOOT_ID="${NIGHTSTAND_BOOT_ID:-/proc/sys/kernel/random/boot_id}"
UPTIME="${NIGHTSTAND_UPTIME:-/proc/uptime}"
PROC="${NIGHTSTAND_PROC:-/proc}"
LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
[ -n "${NIGHTSTAND_OPERATION_LOCK:-}" ] || [ -d /run/lock ] || LOCK=/tmp/free-sleep-operation.lock
PROC_LOCKS="${NIGHTSTAND_PROC_LOCKS:-/proc/locks}"
OPERATION_UNITS="free-sleep-update.service free-sleep-rollback.service free-sleep-revert.service free-sleep-migrate.service"
# Scripts that install, reset or replace Nightstand. install.sh run from curl
# shows up as bash -c with its source, recognized by its first setting.
OPERATION_SCRIPTS='(^|[ /])(install|update|update_service|rollback_pod|switch-to-upstream|revert-to-stock|reset|reset_db|enable_biometrics|setup_python|install_python_packages|pod-installer|agent-bootstrap-installer|restore-original-fork)\.sh( |$)|MIN_INSTALL_VERSION='

DRY=no
case "${1:-}" in
  '') ;;
  --dry-run) DRY=yes ;;
  *) echo "Usage: network_watchdog.sh [--dry-run]" >&2; exit 2 ;;
esac

say() { echo "Network watchdog: $*"; }
show() { [ "$DRY" = no ] || echo "$*"; }
# A leading zero would make shell arithmetic read the value as octal and stop.
number() { case "${1:-}" in '' | *[!0-9]* | 0?*) return 1 ;; esac; }
injected() { [ "$DRY" = yes ] && [ -n "${1:-}" ]; }

if [ ! -d "$MODULE" ]; then
  show "decision: no action ($DRIVER is not loaded)"
  exit 0
fi

UP=$(awk '{ print int($1) }' "$UPTIME" 2>/dev/null)
if ! number "$UP" || [ "$UP" -lt "$BOOT_GRACE" ]; then
  show "decision: no action (less than $((BOOT_GRACE / 60)) minutes since boot)"
  exit 0
fi
BOOT=$(cat "$BOOT_ID" 2>/dev/null)
number "$PROBE_SECONDS" || PROBE_SECONDS=10

state_get() { sed -n "s/^$1=//p" "$STATE" 2>/dev/null | head -n 1; }
S_BOOT=$(state_get boot)
S_DOWN=$(state_get down_since)
S_SCAN=$(state_get scan_failing_since)
S_RESTARTS=$(state_get restarts)
S_LAST=$(state_get last_restart)
S_WAIT=$(state_get waiting)
[ "$S_BOOT" = "$BOOT" ] || S_WAIT=
if [ "$S_BOOT" != "$BOOT" ] || ! number "$S_DOWN"; then S_DOWN=; S_SCAN=; fi
number "$S_SCAN" || S_SCAN=

# Replaces the state file at once through a new file, so a link planted in
# the data folder is never followed. Fails when it could not be written.
write_state() {
  local tmp
  tmp=$(mktemp "$STATE.XXXXXX" 2>/dev/null) || return 1
  if ! printf 'boot=%s\ndown_since=%s\nscan_failing_since=%s\nrestarts=%s\nlast_restart=%s\nwaiting=%s\n' \
    "$BOOT" "$1" "$2" "$3" "$4" "$5" > "$tmp" 2>/dev/null || ! mv -f "$tmp" "$STATE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
}

# Runs a probe and gives up on it after PROBE_SECONDS without waiting for it
# to end, since a probe stuck in a wedged driver cannot be killed. 124 means
# it was given up on.
probe() {
  local status
  read -r -t "$PROBE_SECONDS" status < <(exec 2>/dev/null; "$@" >/dev/null; echo $?) || status=124
  return "$status"
}

# The default gateway and its interface from the kernel's route table.
GATEWAY=
ROUTE=$(awk 'NR > 1 && $2 == "00000000" && $3 != "00000000" { print $1, $3; exit }' "$ROUTES" 2>/dev/null)
DEVICE=${ROUTE% *}
HEX=${ROUTE#* }
case "$HEX" in
  [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f])
    GATEWAY=$(printf '%d.%d.%d.%d' "0x${HEX:6:2}" "0x${HEX:4:2}" "0x${HEX:2:2}" "0x${HEX:0:2}") ;;
esac

# Only "no reply" (1, or 124 for a probe given up on) counts as down. Any other
# failure, such as ping exiting 2 because a firewall refused the address or a
# missing command, says nothing about Wi-Fi.
if injected "${NIGHTSTAND_NETWATCH_NETWORK:-}"; then
  NETWORK="${NIGHTSTAND_NETWATCH_NETWORK} (injected)"
elif [ -z "$GATEWAY" ]; then
  NETWORK="down (no default route)"
else
  probe ping -c 2 -W 2 "$GATEWAY"
  PING=$?
  ARPING=
  [ "$PING" = 0 ] || { probe arping -c 2 -w 3 -I "$DEVICE" "$GATEWAY"; ARPING=$?; }
  case "$PING:$ARPING" in
    0:* | *:0) NETWORK="up (gateway $GATEWAY answered)" ;;
    1:* | 124:* | *:1 | *:124) NETWORK="down (gateway $GATEWAY did not answer)" ;;
    *) NETWORK="unknown (neither ping nor arping could run: $PING, $ARPING)" ;;
  esac
fi

# A kernel oops whose trace runs through the driver: its frames end in
# "[wlan_drv_gen4...]". The loaded-module list names it in every oops, so
# that line does not count. A warning or the end of the trace closes an
# oops, so a later warning from the driver never counts as part of one.
# dmesg is read when the journal holds nothing that matches.
oops_in() {
  awk '
    /Internal error: Oops/ { inside = 1; next }
    /---\[ end trace|cut here \]|WARNING: CPU:/ { inside = 0 }
    inside && /\[wlan_drv_gen4/ { found = 1 }
    END { exit !found }'
}
driver_crashed() {
  journalctl -k -b --no-pager -o cat 2>/dev/null | oops_in || dmesg 2>/dev/null | oops_in
}
# Only the code the dead driver gives. -16 (busy) is an ordinary driver
# turning down a scan while another runs.
scan_failures() {
  journalctl -b --since="-${SCAN_WINDOW}min" --no-pager -o cat 2>/dev/null | grep -c 'CTRL-EVENT-SCAN-FAILED ret=-22'
}

# A dead driver can make the probes fail outright instead of going
# unanswered, so after a crash a network it cannot check counts as down.
case "$NETWORK" in
  unknown*)
    if { injected "${NIGHTSTAND_NETWATCH_OOPS:-}" && [ "$NIGHTSTAND_NETWATCH_OOPS" = yes ]; } \
      || { ! injected "${NIGHTSTAND_NETWATCH_OOPS:-}" && driver_crashed; }; then
      DETAIL=${NETWORK#unknown (}
      NETWORK="down (${DETAIL%)}, after a Wi-Fi driver crash this boot)"
    fi
    ;;
esac

case "$NETWORK" in
  up* | unknown*)
    if [ "$DRY" = no ]; then
      if [ -n "$S_DOWN" ]; then
        case "$NETWORK" in up*) say "the network is back after $(((UP - S_DOWN) / 60)) minutes" ;; esac
        write_state "" "" "$S_RESTARTS" "$S_LAST" ""
      fi
      exit 0
    fi
    ;;
esac

OOPS=no
SCANS=0
if injected "${NIGHTSTAND_NETWATCH_OOPS:-}"; then
  OOPS="$NIGHTSTAND_NETWATCH_OOPS"
elif driver_crashed; then
  OOPS=yes
fi
SCANS=$(scan_failures)
number "$SCANS" || SCANS=0

DOWN_SINCE=
SCAN_SINCE=
DOWN_FOR=0
SCAN_FOR=0
case "$NETWORK" in
  down*)
    DOWN_SINCE=${S_DOWN:-$UP}
    [ "$SCANS" -lt "$SCAN_FAILURES" ] || SCAN_SINCE=${S_SCAN:-$UP}
    if [ "$DRY" = no ] && { [ "$DOWN_SINCE" != "$S_DOWN" ] || [ "$SCAN_SINCE" != "$S_SCAN" ]; }; then
      [ -n "$S_DOWN" ] || say "the network is $NETWORK"
      write_state "$DOWN_SINCE" "$SCAN_SINCE" "$S_RESTARTS" "$S_LAST" "$S_WAIT"
    fi
    DOWN_FOR=$((UP - DOWN_SINCE))
    [ -z "$SCAN_SINCE" ] || SCAN_FOR=$((UP - SCAN_SINCE))
    ;;
esac
if injected "${NIGHTSTAND_NETWATCH_DOWN_FOR:-}"; then DOWN_FOR=$NIGHTSTAND_NETWATCH_DOWN_FOR; fi
if injected "${NIGHTSTAND_NETWATCH_SCAN_FAILING_FOR:-}"; then SCAN_FOR=$NIGHTSTAND_NETWATCH_SCAN_FAILING_FOR; fi
number "$DOWN_FOR" || DOWN_FOR=0
number "$SCAN_FOR" || SCAN_FOR=0

# On when systemd pets the hardware watchdog while running, the setting
# setup_watchdog.sh turns on.
watchdog_setting() {
  systemctl show -p RuntimeWatchdogUSec 2>/dev/null | sed -n 's/^RuntimeWatchdogUSec=//p'
}
WATCHDOG=
watchdog_on() {
  WATCHDOG=$(watchdog_setting)
  case "$WATCHDOG" in '' | 0 | 0s | infinity) return 1 ;; esac
}

show "driver: $DRIVER loaded"
show "uptime: $UP s"
show "network: $NETWORK"
show "driver crash this boot: $OOPS"
show "scan failures in the last $SCAN_WINDOW minutes: $SCANS"
show "down for: $DOWN_FOR s; scans failing for: $SCAN_FOR s"
if [ "$DRY" = yes ]; then
  if watchdog_on; then
    echo "hardware watchdog: on ($WATCHDOG)"
  else
    echo "hardware watchdog: off${WATCHDOG:+ ($WATCHDOG)}"
  fi
fi

REASON=
RULE=
case "$NETWORK" in
  down*)
    if [ "$OOPS" = yes ] && [ "$DOWN_FOR" -ge "$OOPS_DOWN" ]; then
      RULE=crash
      REASON="the Wi-Fi driver crashed this boot and the network has been down for $((DOWN_FOR / 60)) minutes"
    elif [ "$DOWN_FOR" -ge "$SCAN_DOWN" ] && [ "$SCAN_FOR" -ge "$SCAN_DOWN" ]; then
      RULE=scans
      REASON="Wi-Fi scans have failed and the network has been down for $((DOWN_FOR / 60)) minutes"
    fi
    ;;
esac
if [ -z "$REASON" ]; then
  show "decision: no action"
  exit 0
fi

# Reads /proc/locks rather than taking the lock, which for that moment would
# make an update starting at the same time refuse to run. Keep in step with
# health_check.sh.
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

# Prints the first operation unit that is running.
busy_unit() {
  local unit active
  for unit in $OPERATION_UNITS; do
    active=$(systemctl is-active "$unit" 2>/dev/null)
    case "$active" in active | activating | deactivating | reloading) echo "$unit"; return ;; esac
  done
}

# Matched in bash, since a grep for the pattern would find its own command line.
operation_process() {
  local file line
  for file in "$PROC"/[0-9]*/cmdline; do
    [ -r "$file" ] || continue
    line=$(tr '\000\n' '  ' < "$file" 2>/dev/null)
    [[ $line =~ $OPERATION_SCRIPTS ]] && return 0
  done
  return 1
}

NOW=$(date +%s)
number "$NOW" || NOW=0
# Seconds since a restart saved as epoch,boot. One from an earlier boot came
# before this boot began, so at least the uptime has passed, even while the
# clock still reads years behind after a restart.
since() {
  local s=$((NOW - ${1%%,*}))
  if [ "${1#*,}" != "$BOOT" ] && [ "$s" -lt "$UP" ]; then s=$UP; fi
  [ "$s" -ge 0 ] || s=0
  echo "$s"
}

RATE=
RATE_KEY=
KEPT=
COUNT=0
for entry in $S_RESTARTS; do
  number "${entry%%,*}" || continue
  AGO=$(since "$entry")
  [ "$AGO" -lt "$DAY" ] || continue
  KEPT="${KEPT:+$KEPT }$entry"
  COUNT=$((COUNT + 1))
  if [ -z "$RATE" ] && [ "$AGO" -lt "$MIN_GAP" ]; then
    RATE="the Pod was restarted for this $((AGO / 60)) minutes ago"
    RATE_KEY=gap
  fi
done
if [ -z "$RATE" ] && [ "$COUNT" -ge "$DAY_LIMIT" ]; then
  RATE="the Pod was already restarted for this $COUNT times in 24 hours"
  RATE_KEY=day
fi

BLOCK=
KEY=
UNIT=$(busy_unit)
if lock_held; then
  BLOCK="an update, rollback or switch is running"; KEY=lock
elif [ -n "$UNIT" ]; then
  BLOCK="$UNIT is running"; KEY="unit $UNIT"
elif operation_process; then
  BLOCK="an install, reset or biometrics install is running"; KEY=process
elif ! watchdog_on; then
  BLOCK="the hardware watchdog is off"; KEY=watchdog
elif [ -n "$RATE" ]; then
  BLOCK=$RATE; KEY=$RATE_KEY
fi

if [ -n "$BLOCK" ]; then
  if [ "$DRY" = yes ]; then
    echo "decision: would wait: $REASON, but $BLOCK"
    exit 0
  fi
  # Logged when the wait starts, when its rule or blocker changes and every
  # WAIT_LOG seconds, not every minute.
  KEY="$RULE $KEY"
  WAIT_AT=${S_WAIT%% *}
  if [ "${S_WAIT#* }" != "$KEY" ] || ! number "$WAIT_AT" || [ $((UP - WAIT_AT)) -ge "$WAIT_LOG" ]; then
    say "would restart the Pod ($REASON), but $BLOCK; waiting"
    write_state "$DOWN_SINCE" "$SCAN_SINCE" "$S_RESTARTS" "$S_LAST" "$UP $KEY"
  fi
  exit 0
fi

if [ "$DRY" = yes ]; then
  echo "decision: would restart the Pod: $REASON"
  exit 0
fi

# A restart that cannot be recorded is not made, so a full or read-only
# data folder cannot turn this into a restart loop.
if ! write_state "$DOWN_SINCE" "$SCAN_SINCE" "${KEPT:+$KEPT }$NOW,$BOOT" "$NOW $REASON" ""; then
  say "would restart the Pod ($REASON), but $STATE could not be written; waiting"
  exit 1
fi
# The line reaches the disk before the restart, in case the shutdown hangs
# and the hardware watchdog resets the Pod.
say "restarting the Pod: $REASON"
journalctl --sync >/dev/null 2>&1
sync
# On systemd, reboot sends this same request, so there is no other path to try.
systemctl --no-block reboot || { say "the restart request failed"; exit 1; }
