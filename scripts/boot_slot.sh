#!/bin/bash
# The hub keeps two copies of its system, slot a and slot b. U-Boot gives a
# slot that is not marked good a few boots, counting down, and then starts the
# other slot, which still holds Eight Sleep's system with its updates on and
# no internet block. Eight Sleep's defibrillator service marks a slot good,
# and the install switches that service off, so a slot installed straight
# after a firmware update would never be marked. This marks the running slot,
# which has booted, and changes nothing when it is already marked.
#
#   boot_slot.sh status    say which slot is running and whether it is marked
#   boot_slot.sh confirm   mark the running slot good if it is not
#
# Exit codes: 0 marked (or now marked), 1 not marked or marking failed,
# 2 cannot tell (no fw_printenv, unknown slot).
set -u
export PATH="/usr/sbin:/sbin:/usr/bin:/bin"

CMDLINE="${NIGHTSTAND_PROC_CMDLINE:-/proc/cmdline}"
FW_PRINTENV="${NIGHTSTAND_FW_PRINTENV:-fw_printenv}"
FW_SETENV="${NIGHTSTAND_FW_SETENV:-fw_setenv}"

running_slot() {
  sed -n 's/.*root=PARTLABEL=rootfs_\([ab]\)\([[:space:]].*\)\{0,1\}$/\1/p' "$CMDLINE" 2>/dev/null | head -n 1
}

setting() {
  "$FW_PRINTENV" -n "$1" 2>/dev/null
}

status() {
  command -v "$FW_PRINTENV" >/dev/null 2>&1 || { echo "Boot slot: fw_printenv is missing, so the slots cannot be read."; return 2; }
  SLOT=$(running_slot)
  [ -n "$SLOT" ] || { echo "Boot slot: could not tell which slot is running."; return 2; }
  local marked retries
  marked=$(setting "boot_${SLOT}_success")
  retries=$(setting "retry_boot_${SLOT}")
  if [ "$marked" = 1 ]; then
    echo "Boot slot: running slot $SLOT, marked good."
    return 0
  fi
  echo "Boot slot: running slot $SLOT, not marked good (boot_${SLOT}_success=${marked:-unset}, ${retries:-unknown} boots left)."
  return 1
}

confirm() {
  status
  local result=$?
  [ "$result" = 1 ] || return "$result"
  if "$FW_SETENV" "boot_${SLOT}_success" 1 && [ "$(setting "boot_${SLOT}_success")" = 1 ]; then
    echo "Boot slot: slot $SLOT is now marked good."
    return 0
  fi
  echo "Boot slot: could not mark slot $SLOT good. Avoid extra reboots and open an issue."
  return 1
}

case "${1:-}" in
  status) status ;;
  confirm) confirm ;;
  *) echo "Usage: boot_slot.sh status | confirm" >&2; exit 2 ;;
esac
