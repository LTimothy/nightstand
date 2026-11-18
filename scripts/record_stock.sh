#!/bin/bash
# Saves the Pod's original system files the first time Nightstand changes
# them, so they can be put back by hand. Never overwrites a saved copy and
# never fails its caller.
# Usage: record_stock.sh ssh|firewall|units|journald
set -u
STOCK="${NIGHTSTAND_STOCK_DIR:-/persistent/nightstand-stock}"
ROOT="${NIGHTSTAND_ROOT:-}"
STEP11_UNITS="swupdate-progress swupdate defibrillator eight-kernel telegraf vector frankenfirmware dac swupdate.socket"

mkdir -p "$STOCK" 2>/dev/null && chmod 700 "$STOCK" 2>/dev/null || exit 0
# Each run works in its own directory, so runs at the same time never share
# a temporary file.
WORK=$(mktemp -d "$STOCK/.run.XXXXXX" 2>/dev/null) || exit 0
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM

# An item counts as saved as a copy, as NAME.absent or as NAME.link.
saved() { [ -e "$STOCK/$1" ] || [ -e "$STOCK/$1.absent" ] || [ -e "$STOCK/$1.link" ]; }
# An item's line in recorded.txt is written once, by the run that claims it.
# Stop signals are ignored between the claim and the line, so a stopped run
# leaves no claim without its line.
note() {
  trap '' HUP INT TERM
  if ( set -C; : > "$STOCK/.noted.$1" ) 2>/dev/null; then
    echo "$1 $(date -u +%Y-%m-%dT%H:%M:%SZ) $2" >> "$STOCK/recorded.txt" 2>/dev/null || rm -f "$STOCK/.noted.$1"
  fi
  trap 'exit 1' HUP INT TERM
  return 0
}
# place FILE NAME: moves FILE in as NAME unless NAME is already there. A hard
# link fails if NAME exists, so only one of two runs at once can place it.
# The run that places an item is the only one that notes it, so a claim
# left from before is stale and is dropped.
place() {
  saved "$2" && return 1
  if ! ln "$1" "$STOCK/$2" 2>/dev/null; then
    # A file system without hard links.
    [ -e "$STOCK/$2" ] || [ -L "$STOCK/$2" ] && return 1
    mv -n "$1" "$STOCK/$2" 2>/dev/null && [ ! -e "$1" ] || return 1
  fi
  rm -f "$STOCK/.noted.$2"
}
# Prints after-nightstand when any of the files matches the pattern.
state_of() {
  local pattern=$1
  shift
  if grep -qE -- "$pattern" "$@" 2>/dev/null; then echo after-nightstand; else echo original; fi
}
# keep PATH NAME STATE: saves PATH (under ROOT) once. A symlink is saved as
# its target's content, or as NAME.link holding the target when that is gone.
keep() {
  local source="$ROOT$1" name=$2 state=$3 tmp="$WORK/$2"
  saved "$name" && return 0
  if [ -e "$source" ]; then
    cp -pL "$source" "$tmp" 2>/dev/null && place "$tmp" "$name" && note "$name" "$state"
  elif [ -L "$source" ]; then
    readlink "$source" > "$tmp" 2>/dev/null && place "$tmp" "$name.link" && note "$name.link" "$state"
  else
    : > "$tmp" 2>/dev/null && place "$tmp" "$name.absent" && note "$name.absent" "$state"
  fi
  return 0
}
# adopt FILE NAME STATE: saves an already written FILE once.
adopt() {
  [ -f "$1" ] && place "$1" "$2" && note "$2" "$3"
  return 0
}

case "${1:-}" in
  ssh)
    SSH_STATE=$(state_of '^AllowUsers root rewt$' "$ROOT/etc/ssh/sshd_config" "$ROOT/etc/ssh/ssh_config")
    keep /etc/ssh/sshd_config sshd_config "$SSH_STATE"
    keep /etc/ssh/ssh_config ssh_config "$SSH_STATE"
    keep /etc/ssh/authorized_keys authorized_keys "$SSH_STATE"
    keep /etc/systemd/system/sshd.service sshd.service "$SSH_STATE"
    ;;
  firewall)
    live4="$WORK/iptables.live" live6="$WORK/ip6tables.live"
    saved iptables.rules || iptables-save > "$live4" 2>/dev/null || rm -f "$live4"
    saved ip6tables.rules || ip6tables-save > "$live6" 2>/dev/null || rm -f "$live6"
    # The live rules or the saved rules files carry the block script's marks
    # once it has run. An update's download window rejects HTTPS over IPv6.
    FW_STATE=$(state_of '--dport 1337|^-A OUTPUT -j DROP$|--dport 443 -j REJECT' "$live4" "$live6" \
      "$ROOT/etc/iptables/iptables.rules" "$ROOT/etc/iptables/ip6tables.rules")
    adopt "$live4" iptables.rules "$FW_STATE"
    adopt "$live6" ip6tables.rules "$FW_STATE"
    keep /etc/iptables/iptables.rules iptables.rules.file "$FW_STATE"
    keep /etc/iptables/ip6tables.rules ip6tables.rules.file "$FW_STATE"
    # The NTP line the block script writes. Systemd's stock file names the
    # same fallback servers, commented out.
    keep /etc/systemd/timesyncd.conf timesyncd.conf \
      "$(state_of '^NTP=pool\.ntp\.org 0\.pool\.ntp\.org ' "$ROOT/etc/systemd/timesyncd.conf")"
    ;;
  units)
    # Step 11 has disabled these by the time Nightstand is installed. Its
    # own command saves them first, and that copy is the original. .ours
    # marks a copy this script took; it is written before the copy is placed.
    if ! saved unit-states.txt; then
      tmp="$WORK/unit-states.txt"
      for unit in $STEP11_UNITS; do
        state=$(systemctl is-enabled "$unit" 2>/dev/null | head -n 1)
        echo "$unit ${state:-unknown}"
      done > "$tmp" 2>/dev/null && : > "$STOCK/.ours.unit-states.txt" 2>/dev/null \
        && place "$tmp" unit-states.txt && note unit-states.txt after-nightstand
    elif [ ! -e "$STOCK/.ours.unit-states.txt" ]; then
      note unit-states.txt original
    fi
    ;;
  journald)
    # Nightstand only adds this drop-in; the Pod ships without it.
    keep /etc/systemd/journald.conf.d/10-nightstand-memory.conf journald-10-nightstand-memory.conf original
    ;;
esac
exit 0
