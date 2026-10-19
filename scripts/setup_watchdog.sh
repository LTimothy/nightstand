#!/bin/bash
#
# Turns on the Pod's hardware watchdog, so a frozen kernel or PID 1 resets the
# Pod instead of leaving it with no server and no cooling. install.sh,
# update.sh and pod-installer.sh run it with --auto once they have succeeded;
# safe to run again.
#
# Background: a kernel fault (for example in the Wi-Fi driver) can leave
# processes stuck and PID 1 frozen during a reboot. systemd arms its reboot
# watchdog only at the final reboot handoff, which a hung shutdown never
# reaches, so nothing resets the board. RuntimeWatchdogSec covers that case:
# PID 1 pets /dev/watchdog at half the timeout.
#
# 30 seconds stays inside mtk-wdt's 31 second hardware maximum. A longer value
# depends on the kernel extending the timeout in software, and where it cannot,
# the hardware keeps its own timeout while PID 1 pets at half the longer one,
# which resets the Pod over and over.
#
# It is turned on only for the Pod 5 it was checked on: the mtk-wdt driver
# with a 31 second maximum, on a hub whose device label shows revision G53 or
# later (the rule the server uses for "Pod 5"). The first arming can reset
# the Pod, so callers run it only after they succeed. It is also left off where
# there is no watchdog device, where systemd is older than 230, where
# something else already set RuntimeWatchdogSec, where another program holds
# the device, or where the driver's timeout limits do not allow 30 seconds.
# A Pod left off for any of these reasons looks again at the next update.
#
# The first time, the setting goes in /run, which a reset clears, and stays
# there for two full timeouts before it is copied to /etc. A watchdog that
# does not take PID 1's pets therefore resets the Pod once rather than at
# every boot. The trial file in the data folder, kept after a reset or a
# failed attempt, stops it from trying again. The drop-in in /etc is the
# record of what this did: "--remove" deletes it and the trial copy in /run,
# and nothing else.
#
# "--remove" by hand also leaves a note in the trial file, so --auto runs
# leave the watchdog off; running this script by hand without arguments
# clears the note and turns it on again. Rollback to another fork and the
# switch to upstream use "--remove --switching", which records no choice.
#
# Usage: setup_watchdog.sh [--auto | --remove [--switching]]   (run as root)
set -u

CONF_DIR="${NIGHTSTAND_SYSTEM_CONF_DIR:-/etc/systemd/system.conf.d}"
TRIAL_DIR="${NIGHTSTAND_RUNTIME_CONF_DIR:-/run/systemd/system.conf.d}"
NAME=10-nightstand-watchdog.conf
DROPIN="$CONF_DIR/$NAME"
TRIAL_DROPIN="$TRIAL_DIR/$NAME"
TRIAL_MARK="${NIGHTSTAND_WATCHDOG_TRIAL_MARK:-/persistent/free-sleep-data/watchdog-trial}"
TRIAL_SECONDS="${NIGHTSTAND_WATCHDOG_TRIAL:-60}"
DEVICE="${NIGHTSTAND_WATCHDOG_DEVICE:-/dev/watchdog}"
SYSFS="${NIGHTSTAND_WATCHDOG_SYSFS:-/sys/class/watchdog/watchdog0}"
SYSFS_DEVICE="$SYSFS/device"
PROC="${NIGHTSTAND_PROC:-/proc}"
WAIT="${NIGHTSTAND_WATCHDOG_WAIT:-10}"
MARKER="# Managed by scripts/setup_watchdog.sh."
OWNER_NOTE="turned off by the owner with --remove"
RUNTIME=30
POD5_IDENTITY=mtk-wdt
POD5_MAX_TIMEOUT=31
POD5_REVISION=G53

skip() { echo "Hardware watchdog left off: $*."; exit 0; }
ours() { [ -f "$DROPIN" ] && head -n 1 "$DROPIN" | grep -qF "$MARKER"; }
number() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac; }
sysfs() { tr -d '[:space:]' < "$SYSFS/$1" 2>/dev/null; }
# Checks NUL-terminated records and prints them for skip messages.
compatible_records() {
  local record='' matched=0 invalid=0
  while IFS= read -r -d '' record; do
    printf '%s\n' "$record"
    case "$record" in *$'\n'*) invalid=1 ;; esac
    [ "$record" != 'mediatek,mt8365-wdt' ] || matched=1
  done
  printf '%s' "$record"
  [ -z "$record" ] && [ "$invalid" = 0 ] && [ "$matched" = 1 ]
}
runtime_setting() {
  systemctl show -p RuntimeWatchdogUSec 2>/dev/null | sed -n 's/^RuntimeWatchdogUSec=//p'
}

# Prints the PIDs that hold a watchdog device open.
holders() {
  local fd pid
  for fd in "$PROC"/[0-9]*/fd/*; do
    case "$(readlink "$fd" 2>/dev/null)" in
      /dev/watchdog*)
        pid=${fd#"$PROC"/}
        echo "${pid%%/*}"
        ;;
    esac
  done | sort -u
}
pid1_holds() { holders | grep -qx 1; }

# The hub revision from the Pod's device label: the third "-" field of the
# whole file, as the server splits it, up to any whitespace. Empty when the
# label has fewer than two dashes or the field is not a letter and two digits.
hub_revision() {
  local file field
  for file in ${NIGHTSTAND_DEVICE_LABEL:-/deviceinfo/device-label /persistent/deviceinfo/device-label}; do
    if [ -f "$file" ]; then
      field=$(tr '\n' ' ' < "$file" | cut -s -d- -f3)
      field=${field%%[[:space:]]*}
      case "$field" in [A-Z][0-9][0-9]) echo "$field" ;; esac
      return
    fi
  done
}
# True when revision $1 sorts at or after POD5_REVISION, as the server compares.
pod5_revision() {
  [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$POD5_REVISION" "$1" | LC_ALL=C sort | head -n 1)" = "$POD5_REVISION" ]
}

# The trial file sits in the server user's folder, so root replaces it with
# a new file rather than writing through a link left at its name.
write_mark() {
  python3 -I - "$TRIAL_MARK" "${1:-}" 2>/dev/null <<'PY'
import os, sys, tempfile
path, text = sys.argv[1:]
descriptor, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=os.path.basename(path) + ".")
try:
    with os.fdopen(descriptor, "w") as handle:
        handle.write(text + "\n" if text else "")
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), 0o644)
    os.replace(tmp, path)
except BaseException:
    os.unlink(tmp)
    raise
PY
}
# Prints the trial file's first line, or nothing for a link or anything but a
# plain file, so root never shows what another file holds.
read_mark() {
  python3 -I - "$TRIAL_MARK" 2>/dev/null <<'PY'
import os, stat, sys
try:
    descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(0)
with os.fdopen(descriptor) as handle:
    if stat.S_ISREG(os.fstat(descriptor).st_mode):
        print(handle.readline(500).rstrip("\n"))
PY
}

# Writes the drop-in into directory $1, replacing any earlier copy at once.
write_dropin() {
  mkdir -p "$1" || return 1
  cat > "$1/$NAME.tmp" <<EOF || { rm -f "$1/$NAME.tmp"; return 1; }
$MARKER See that script for why this exists.
[Manager]
RuntimeWatchdogSec=${RUNTIME}s
EOF
  mv "$1/$NAME.tmp" "$1/$NAME" || { rm -f "$1/$NAME.tmp"; return 1; }
}

# Takes the setting back out after a failed trial and records why, so later
# runs do not try again. A re-exec closes the device, which on a kernel that
# cannot stop a running watchdog resets the Pod, so PID 1 lets go of an open
# device only at the next restart.
abandon() {
  rm -f "$TRIAL_DROPIN"
  write_mark "$*"
  if pid1_holds; then
    echo "WARNING: the hardware watchdog is NOT active as set up: $*. Nightstand's setting was removed, and PID 1 lets go of the device at the next restart." >&2
  else
    systemctl daemon-reexec >/dev/null 2>&1 || true
    echo "WARNING: the hardware watchdog is NOT active: $*. Nightstand's setting was removed." >&2
  fi
  exit 1
}

MODE=hand
case "${1:-}" in
  '') ;;
  --auto) MODE=auto ;;
  --remove) MODE=remove; [ "${2:-}" != --switching ] || MODE=switching ;;
  *) echo "Usage: setup_watchdog.sh [--auto | --remove [--switching]]" >&2; exit 2 ;;
esac

# Says whether later installs and updates leave the watchdog off.
removed() {
  [ "$MODE" = remove ] || exit 0
  if [ "$NOTE" = failed ]; then
    echo "WARNING: could not write $TRIAL_MARK, so the next install or update turns the watchdog on again" >&2
    exit 1
  fi
  if [ "$(read_mark)" = "$OWNER_NOTE" ]; then
    echo "Hardware watchdog: installs and updates leave it off; run this script without arguments to turn it on again."
  else
    echo "Hardware watchdog: installs and updates leave it off after the earlier trial; delete $TRIAL_MARK to try again."
  fi
  exit 0
}

if [ "$MODE" = remove ] || [ "$MODE" = switching ]; then
  # An earlier failed trial already keeps it off, and its reason is kept.
  NOTE=kept
  if [ "$MODE" = remove ] && [ ! -e "$TRIAL_MARK" ]; then
    write_mark "$OWNER_NOTE" || NOTE=failed
  fi
  if ! ours && [ ! -f "$TRIAL_DROPIN" ]; then
    echo "Hardware watchdog: no Nightstand setting to remove."
    removed
  fi
  if ours; then
    rm -f "$DROPIN" || { echo "WARNING: could not remove $DROPIN" >&2; exit 1; }
  fi
  rm -f "$TRIAL_DROPIN"
  # Same reason as in abandon: only re-exec where closing the device is safe.
  if pid1_holds && [ "$(sysfs nowayout)" != 0 ]; then
    echo "Hardware watchdog: Nightstand's setting removed; it turns off at the next restart."
  elif systemctl daemon-reexec; then
    echo "Hardware watchdog: Nightstand's setting removed and the watchdog turned off."
  else
    echo "Hardware watchdog: Nightstand's setting removed; it turns off at the next restart."
  fi
  removed
fi

if [ -f "$DROPIN" ]; then
  ours || skip "$DROPIN was not written by Nightstand"
  echo "Hardware watchdog already on (RuntimeWatchdogUSec=$(runtime_setting))."
  exit 0
fi
if [ -e "$TRIAL_MARK" ]; then
  REASON=$(read_mark)
  if [ "$REASON" = "$OWNER_NOTE" ] && [ "$MODE" = hand ]; then
    rm -f "$TRIAL_MARK" || { echo "WARNING: could not remove $TRIAL_MARK; the hardware watchdog stays off" >&2; exit 1; }
    echo "Hardware watchdog: cleared the note left by --remove."
  else
    rm -f "$TRIAL_DROPIN"
    [ "$REASON" != "$OWNER_NOTE" ] || skip "$OWNER_NOTE; run this script without arguments to turn it on again"
    skip "${REASON:-an earlier trial did not finish, so the Pod may have reset during it}; delete $TRIAL_MARK to try again"
  fi
fi

[ -e "$DEVICE" ] || skip "no watchdog device at $DEVICE"
VERSION=$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')
number "$VERSION" && [ "$VERSION" -ge 230 ] || skip "systemd ${VERSION:-unknown} is older than 230 or unknown"
CURRENT=$(runtime_setting)
[ -n "$CURRENT" ] || skip "systemd does not report RuntimeWatchdogUSec"
case "$CURRENT" in
  0 | 0s) ;;
  *) skip "RuntimeWatchdogSec is already set to $CURRENT outside Nightstand" ;;
esac
NO_SYSFS=0
[ -d "$SYSFS" ] && [ -r "$SYSFS" ] && [ -x "$SYSFS" ] \
  && ls -A "$SYSFS" >/dev/null 2>&1 || skip "cannot inspect watchdog directory at $SYSFS"
if [ ! -e "$SYSFS/identity" ] && [ ! -e "$SYSFS/timeout" ] \
  && [ ! -e "$SYSFS/max_timeout" ] && [ ! -e "$SYSFS/min_timeout" ]; then
  NO_SYSFS=1
  DRIVER=$(readlink "$SYSFS_DEVICE/driver" 2>/dev/null)
  IDENTITY=${DRIVER##*/}
  if COMPATIBLE=$(set -o pipefail; cat "$SYSFS_DEVICE/of_node/compatible" 2>/dev/null | compatible_records); then
    COMPATIBLE_MATCH=1
  else
    COMPATIBLE_MATCH=0
  fi
  REVISION=$(hub_revision)
  if [ "$IDENTITY" != "$POD5_IDENTITY" ] \
    || [ "$COMPATIBLE_MATCH" != 1 ] \
    || ! pod5_revision "$REVISION"; then
    skip "it is only turned on for the Pod 5 it was checked on (driver $POD5_IDENTITY, compatible mediatek,mt8365-wdt, hub revision $POD5_REVISION or later), and this Pod has driver ${IDENTITY:-unknown}, compatible $(printf '%s' "${COMPATIBLE:-unknown}" | tr '\n' ' '), revision ${REVISION:-unknown} (watchdog timeout attributes absent)"
  fi
  # mtk_wdt.c fixes MT8365's hardware maximum at 31 seconds.
  MAX=$POD5_MAX_TIMEOUT
  TIMEOUT=unknown
else
  # Even if the new timeout fails to set, the hardware keeps this one, and PID 1
  # petting every RUNTIME/2 seconds stays well inside it.
  TIMEOUT=$(sysfs timeout)
  number "$TIMEOUT" || skip "the driver does not report its timeout"
  [ "$TIMEOUT" -ge "$RUNTIME" ] || skip "the hardware timeout is ${TIMEOUT}s, under ${RUNTIME}s"
  MAX=$(sysfs max_timeout)
  if number "$MAX" && [ "$MAX" -gt 0 ] && [ "$MAX" -lt "$RUNTIME" ]; then
    skip "the hardware maximum is ${MAX}s, under ${RUNTIME}s"
  fi
  MIN=$(sysfs min_timeout)
  if number "$MIN" && [ "$MIN" -gt "$RUNTIME" ]; then
    skip "the hardware minimum is ${MIN}s, over ${RUNTIME}s"
  fi
  IDENTITY=$(sysfs identity)
  REVISION=$(hub_revision)
  if [ "$IDENTITY" != "$POD5_IDENTITY" ] || [ "$MAX" != "$POD5_MAX_TIMEOUT" ] || ! pod5_revision "$REVISION"; then
    skip "it is only turned on for the Pod 5 it was checked on (driver $POD5_IDENTITY, ${POD5_MAX_TIMEOUT}s maximum, hub revision $POD5_REVISION or later), and this Pod has driver ${IDENTITY:-unknown}, maximum ${MAX:-unknown}s, revision ${REVISION:-unknown}"
  fi
fi
OTHERS=$(holders | grep -vx 1 | tr '\n' ' ')
[ -z "$OTHERS" ] || skip "another program (PID ${OTHERS% }) already uses the watchdog"

write_mark || { echo "WARNING: could not write $TRIAL_MARK; the hardware watchdog stays off" >&2; exit 1; }
# On disk before the re-exec, so a reset straight after it cannot lose it.
sync
if ! write_dropin "$TRIAL_DIR"; then
  rm -f "$TRIAL_MARK"
  echo "WARNING: could not write $TRIAL_DROPIN; the hardware watchdog stays off" >&2
  exit 1
fi

# daemon-reload does not re-read Manager settings. A re-exec keeps every
# service running.
echo "Hardware watchdog: trying it for ${TRIAL_SECONDS} seconds (running services are not restarted)"
if ! systemctl daemon-reexec; then
  abandon "systemctl daemon-reexec failed"
fi

# Verify rather than assume: PID 1 holds the device, systemd reports the
# setting, and the driver took the timeout when sysfs reports it.
i=0
until pid1_holds && CURRENT=$(runtime_setting) && [ -n "$CURRENT" ] && [ "$CURRENT" != 0 ] \
  && { if [ "$NO_SYSFS" = 1 ]; then [ "$CURRENT" = "${RUNTIME}s" ];
       else TIMEOUT=$(sysfs timeout); [ "$TIMEOUT" = "$RUNTIME" ]; fi; }; do
  [ "$i" -lt "$WAIT" ] || abandon "PID 1 did not take the device with a ${RUNTIME}s timeout (RuntimeWatchdogUSec=$(runtime_setting), driver timeout ${TIMEOUT}s)"
  sleep 1
  i=$((i + 1))
done

# A Pod still running here has had its pets taken twice over.
sleep "$TRIAL_SECONDS"
pid1_holds || abandon "PID 1 let go of the device during the trial"
write_dropin "$CONF_DIR" || abandon "could not write $DROPIN"
rm -f "$TRIAL_DROPIN" "$TRIAL_MARK"
echo "Hardware watchdog on: a frozen system now restarts within about ${RUNTIME} seconds."
