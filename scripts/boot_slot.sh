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
# Opt-in, for a way back in if the hub ever starts its other slot. They keep
# that slot's system stock apart from three files, saved first so undo puts
# them back exactly:
#   boot_slot.sh other-access   let this slot's SSH keys log in there as rewt,
#                               give rewt the same password, and switch off
#                               its updater so it cannot overwrite this slot
#   boot_slot.sh other-undo     put those files back
#   boot_slot.sh other-status   say whether the other slot is prepared
#
# Exit codes: 0 done or fine, 1 not marked or a step failed, 2 cannot tell
# or refused (no fw_printenv, unknown slot, not root, nothing to copy).
set -u
export PATH="/usr/sbin:/sbin:/usr/bin:/bin"

CMDLINE="${NIGHTSTAND_PROC_CMDLINE:-/proc/cmdline}"
FW_PRINTENV="${NIGHTSTAND_FW_PRINTENV:-fw_printenv}"
FW_SETENV="${NIGHTSTAND_FW_SETENV:-fw_setenv}"
# Tests point these at plain folders; on a Pod the other slot is mounted here.
THIS_ROOT="${NIGHTSTAND_THIS_ROOT:-}"
OTHER_ROOT="${NIGHTSTAND_OTHER_ROOT:-}"
SAVED="${NIGHTSTAND_OTHER_SLOT_SAVED:-/persistent/nightstand-other-slot}"
MASKS="swupdate.service swupdate.socket swupdate-progress.service"

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

# Mounts the slot that is not running at OTHER_ROOT, read-write only when asked.
open_other() {
  [ -n "$OTHER_ROOT" ] && return 0
  [ "$(id -u)" = 0 ] || { echo "Run this as root."; return 2; }
  local slot other dev
  slot=$(running_slot)
  case "$slot" in a) other=b ;; b) other=a ;; *) echo "Boot slot: could not tell which slot is running."; return 2 ;; esac
  dev=$(readlink -f "/dev/disk/by-partlabel/rootfs_$other") || return 2
  [ -b "$dev" ] || { echo "Other slot: no partition for slot $other."; return 2; }
  grep -q "^$dev " /proc/mounts && { echo "Other slot: slot $other is mounted; refusing."; return 2; }
  OTHER_ROOT=/run/nightstand-other-slot
  mkdir -p "$OTHER_ROOT"
  if [ "$1" = rw ]; then mount -t ext4 -o rw,noatime "$dev" "$OTHER_ROOT"; else mount -t ext4 -o ro,noload "$dev" "$OTHER_ROOT"; fi \
    || { rmdir "$OTHER_ROOT"; echo "Other slot: could not mount slot $other."; return 1; }
  # shellcheck disable=SC2064
  trap "sync; umount '$OTHER_ROOT'; rmdir '$OTHER_ROOT'" EXIT
  echo "Other slot: slot $other."
}

keys_file() {
  local file
  file=$(sed -n 's/^AuthorizedKeysFile[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$THIS_ROOT/etc/ssh/sshd_config" 2>/dev/null | head -n 1)
  printf '%s' "$THIS_ROOT${file:-/home/root/ssh/authorized_keys}"
}

rewt_hash() {
  awk -F: '$1 == "rewt" { print $2 }' "$1"
}

other_status() {
  open_other ro || return $?
  local masked=yes unit
  for unit in $MASKS; do [ "$(readlink "$OTHER_ROOT/etc/systemd/system/$unit")" = /dev/null ] || masked=no; done
  echo "Other slot: SSH keys $([ -s "$OTHER_ROOT/etc/ssh/authorized_keys" ] && echo present || echo absent);" \
    "rewt password $([ "$(rewt_hash "$OTHER_ROOT/etc/shadow")" = "$(rewt_hash "$THIS_ROOT/etc/shadow")" ] && echo same || echo different);" \
    "updater $([ "$masked" = yes ] && echo off || echo on)."
  [ -s "$OTHER_ROOT/etc/ssh/authorized_keys" ] && [ "$masked" = yes ]
}

other_access() {
  local keys hash unit
  keys=$(keys_file)
  [ -s "$keys" ] || { echo "No SSH keys in $keys to copy, so there would be no way in. Refusing."; return 2; }
  hash=$(rewt_hash "$THIS_ROOT/etc/shadow")
  [ -n "$hash" ] || { echo "No rewt password on this slot. Refusing."; return 2; }
  open_other rw || return $?
  [ -n "$(rewt_hash "$OTHER_ROOT/etc/shadow")" ] || { echo "The other slot has no rewt user. Refusing."; return 2; }
  # Saved once, so running this again never overwrites the stock originals.
  if [ ! -d "$SAVED" ]; then
    mkdir -p "$SAVED" && chmod 700 "$SAVED" || return 1
    cp -p "$OTHER_ROOT/etc/shadow" "$SAVED/shadow" || return 1
    if [ -e "$OTHER_ROOT/etc/ssh/authorized_keys" ]; then cp -p "$OTHER_ROOT/etc/ssh/authorized_keys" "$SAVED/authorized_keys" || return 1; fi
    for unit in $MASKS; do [ -e "$OTHER_ROOT/etc/systemd/system/$unit" ] || [ -L "$OTHER_ROOT/etc/systemd/system/$unit" ] || echo "$unit"; done > "$SAVED/added-masks"
  fi
  # sshd reads the file as the user logging in, so it stays world readable.
  install -m 644 "$keys" "$OTHER_ROOT/etc/ssh/authorized_keys" || return 1
  awk -F: -v OFS=: -v h="$hash" '$1 == "rewt" { $2 = h } { print }' "$OTHER_ROOT/etc/shadow" > "$OTHER_ROOT/etc/shadow.nightstand" \
    && cat "$OTHER_ROOT/etc/shadow.nightstand" > "$OTHER_ROOT/etc/shadow" && rm -f "$OTHER_ROOT/etc/shadow.nightstand" || return 1
  for unit in $MASKS; do ln -sfn /dev/null "$OTHER_ROOT/etc/systemd/system/$unit" || return 1; done
  echo "Other slot: prepared. If the hub starts it, log in as rewt on port 8822 with your SSH key; its updater is off."
}

other_undo() {
  local unit
  [ -f "$SAVED/shadow" ] || { echo "Nothing saved, so nothing to put back."; return 0; }
  open_other rw || return $?
  cat "$SAVED/shadow" > "$OTHER_ROOT/etc/shadow" || return 1
  if [ -f "$SAVED/authorized_keys" ]; then cp -p "$SAVED/authorized_keys" "$OTHER_ROOT/etc/ssh/authorized_keys"; else rm -f "$OTHER_ROOT/etc/ssh/authorized_keys"; fi || return 1
  while read -r unit; do
    [ -n "$unit" ] && [ "$(readlink "$OTHER_ROOT/etc/systemd/system/$unit")" = /dev/null ] && rm -f "$OTHER_ROOT/etc/systemd/system/$unit"
  done < "$SAVED/added-masks"
  rm -rf "$SAVED"
  echo "Other slot: put back as it was."
}

case "${1:-}" in
  status) status ;;
  confirm) confirm ;;
  other-access) other_access ;;
  other-undo) other_undo ;;
  other-status) other_status ;;
  *) echo "Usage: boot_slot.sh status | confirm | other-access | other-undo | other-status" >&2; exit 2 ;;
esac
