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
# that slot's system stock apart from a few files, saved first so undo puts
# them back exactly:
#   boot_slot.sh other-access   let this slot's SSH keys log in there as rewt,
#                               give rewt the same password, switch off its
#                               updater so it cannot overwrite this slot, and
#                               keep it off the internet but on the home network
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
FIREWALL_MARK="# nightstand other slot: home network only"
# Loaded by the stock slot's iptables.service before the network starts.
# Everything outbound that is not the home network is refused at once.
RULES_V4="$FIREWALL_MARK
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A OUTPUT -d 10.0.0.0/8 -j ACCEPT
-A OUTPUT -d 172.16.0.0/12 -j ACCEPT
-A OUTPUT -d 192.168.0.0/16 -j ACCEPT
-A OUTPUT -d 169.254.0.0/16 -j ACCEPT
-A OUTPUT -d 224.0.0.0/4 -j ACCEPT
-A OUTPUT -d 255.255.255.255/32 -j ACCEPT
-A OUTPUT -j REJECT
COMMIT"
RULES_V6="$FIREWALL_MARK
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A OUTPUT -p ipv6-icmp -j ACCEPT
-A OUTPUT -d fe80::/10 -j ACCEPT
-A OUTPUT -d fc00::/7 -j ACCEPT
-A OUTPUT -d ff00::/8 -j ACCEPT
-A OUTPUT -j REJECT
COMMIT"

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
  local walled=no
  grep -qxF "$FIREWALL_MARK" "$OTHER_ROOT/etc/iptables/iptables.rules" 2>/dev/null \
    && grep -qxF "$FIREWALL_MARK" "$OTHER_ROOT/etc/iptables/ip6tables.rules" 2>/dev/null && walled=yes
  echo "Other slot: SSH keys $([ -s "$OTHER_ROOT/etc/ssh/authorized_keys" ] && echo present || echo absent);" \
    "internet $([ "$walled" = yes ] && echo blocked || echo open);" \
    "rewt password $([ "$(rewt_hash "$OTHER_ROOT/etc/shadow")" = "$(rewt_hash "$THIS_ROOT/etc/shadow")" ] && echo same || echo different);" \
    "updater $([ "$masked" = yes ] && echo off || echo on)."
  local hash
  hash=$(rewt_hash "$THIS_ROOT/etc/shadow")
  [ -s "$OTHER_ROOT/etc/ssh/authorized_keys" ] && [ "$masked" = yes ] && [ "$walled" = yes ] && [ -n "$hash" ] && [ "$(rewt_hash "$OTHER_ROOT/etc/shadow")" = "$hash" ]
}

other_access() {
  local keys hash unit rules
  keys=$(keys_file)
  [ -s "$keys" ] || { echo "No SSH keys in $keys to copy, so there would be no way in. Refusing."; return 2; }
  hash=$(rewt_hash "$THIS_ROOT/etc/shadow")
  case "$hash" in \$*) ;; *) echo "rewt has no usable password on this slot, so sudo would not work there. Refusing."; return 2 ;; esac
  open_other rw || return $?
  [ -n "$(rewt_hash "$OTHER_ROOT/etc/shadow")" ] || { echo "The other slot has no rewt user. Refusing."; return 2; }
  # A unit override that is not ours would be lost on undo, so leave such a slot alone.
  for unit in $MASKS; do
    [ ! -e "$OTHER_ROOT/etc/systemd/system/$unit" ] && [ ! -L "$OTHER_ROOT/etc/systemd/system/$unit" ] && continue
    [ "$(readlink "$OTHER_ROOT/etc/systemd/system/$unit")" = /dev/null ] \
      || { echo "The other slot already overrides $unit. Refusing."; return 2; }
  done
  # Saved once, so running this again never overwrites the stock originals. added-masks is written last.
  if [ ! -f "$SAVED/added-masks" ]; then
    mkdir -p "$SAVED" && chmod 700 "$SAVED" || return 1
    cp -p "$OTHER_ROOT/etc/shadow" "$SAVED/shadow" || return 1
    if [ -e "$OTHER_ROOT/etc/ssh/authorized_keys" ]; then cp -p "$OTHER_ROOT/etc/ssh/authorized_keys" "$SAVED/authorized_keys" || return 1; fi
    for unit in $MASKS; do [ -e "$OTHER_ROOT/etc/systemd/system/$unit" ] || [ -L "$OTHER_ROOT/etc/systemd/system/$unit" ] || echo "$unit"; done > "$SAVED/added-masks"
  fi
  # Saved separately, so a slot prepared before the firewall step still gets its stock rules saved.
  for rules in iptables.rules ip6tables.rules; do
    [ -e "$SAVED/$rules" ] || [ ! -e "$OTHER_ROOT/etc/iptables/$rules" ] && continue
    grep -qxF "$FIREWALL_MARK" "$OTHER_ROOT/etc/iptables/$rules" && continue
    cp -p "$OTHER_ROOT/etc/iptables/$rules" "$SAVED/$rules" || return 1
  done
  # sshd reads the file as the user logging in, so it stays world readable.
  install -m 644 "$keys" "$OTHER_ROOT/etc/ssh/authorized_keys" || return 1
  local tmp="$OTHER_ROOT/etc/shadow.nightstand"
  ( umask 077; awk -F: -v OFS=: -v h="$hash" '$1 == "rewt" { $2 = h } { print }' "$OTHER_ROOT/etc/shadow" > "$tmp" ) \
    && cat "$tmp" > "$OTHER_ROOT/etc/shadow" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  for unit in $MASKS; do ln -sfn /dev/null "$OTHER_ROOT/etc/systemd/system/$unit" || return 1; done
  mkdir -p "$OTHER_ROOT/etc/iptables" || return 1
  printf '%s\n' "$RULES_V4" > "$OTHER_ROOT/etc/iptables/iptables.rules" || return 1
  printf '%s\n' "$RULES_V6" > "$OTHER_ROOT/etc/iptables/ip6tables.rules" || return 1
  echo "Other slot: prepared. If the hub starts it, log in as rewt on port 8822 with your SSH key; its updater is off and it stays off the internet."
}

other_undo() {
  local unit rules
  [ -e "$SAVED" ] || { echo "Nothing saved, so nothing to put back."; return 0; }
  [ -f "$SAVED/shadow" ] && [ -f "$SAVED/added-masks" ] || { echo "The saved files in $SAVED are incomplete. Restore the slot from its image."; return 1; }
  open_other rw || return $?
  cat "$SAVED/shadow" > "$OTHER_ROOT/etc/shadow" || return 1
  if [ -f "$SAVED/authorized_keys" ]; then cp -p "$SAVED/authorized_keys" "$OTHER_ROOT/etc/ssh/authorized_keys"; else rm -f "$OTHER_ROOT/etc/ssh/authorized_keys"; fi || return 1
  for rules in iptables.rules ip6tables.rules; do
    if [ -f "$SAVED/$rules" ]; then cp -p "$SAVED/$rules" "$OTHER_ROOT/etc/iptables/$rules"; else rm -f "$OTHER_ROOT/etc/iptables/$rules"; fi || return 1
  done
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
