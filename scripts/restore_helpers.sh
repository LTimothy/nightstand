#!/bin/bash
# Shared restore steps, sourced before either application tree moves.

# The root-owned scripts this run started from. The install trees belong to
# the server user, so root runs nothing from them.
NIGHTSTAND_SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

# Makes the copy that matches the tree now at LIVE the one root runs. A tree
# without one, from a release before copies or edited since, keeps the
# current copy.
follow_scripts() {
  python3 -B "$NIGHTSTAND_SCRIPTS/system_scripts.py" follow "$LIVE" \
    || say "WARNING: could not check which scripts root runs for $LIVE"
}

# Moves tree $1 to $2 in the server user's folder without following anything
# planted at $2: mv -T where mv has it, else only onto a free name. Fails
# unless $1 is a real folder and $2 is then the moved tree.
move_tree() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  move_mark=$(mktemp "$1/.moving.XXXXXX") || return 1
  mv -T "$1" "$2" 2>/dev/null \
    || { [ -d "$1" ] && [ ! -e "$2" ] && [ ! -L "$2" ] && mv "$1" "$2"; } \
    || { [ -d "$1" ] && [ ! -L "$1" ] && rm -f "$1/${move_mark##*/}"; return 1; }
  [ -d "$2" ] && [ ! -L "$2" ] && [ -f "$2/${move_mark##*/}" ] && rm -f "$2/${move_mark##*/}"
}

has_switch_journal() {
  local root="${1:-${NIGHTSTAND_TRANSACTION_ROOT:-/persistent/free-sleep-maintenance/nightstand-transactions}}" journal
  for journal in "$root"/*/journal.json; do
    if [ -e "$journal" ] || [ -L "$journal" ]; then return 0; fi
  done
  return 1
}

restore_stop_writer() {
  systemctl stop "$1" 2>/dev/null
  case "$(systemctl is-active "$1" 2>/dev/null)" in
    inactive|failed|unknown) return 0 ;;
  esac
  return 1
}

# Switch recovery restores offline and queues starts without waiting for the
# boot recovery unit itself to exit.
restore_switch_offline() {
  python3 -E -s -B "$1/recover_switch.py" --root "$2" restore --helper "$1/restore_helpers.sh"
}

restore_dependencies() {
  local source=$1
  if [ -d "$source/server/node_modules" ] && [ ! -d "$LIVE/server/node_modules" ] \
    && cmp -s "$LIVE/server/package-lock.json" "$source/server/package-lock.json"; then
    if move_tree "$source/server/node_modules" "$LIVE/server/node_modules"; then
      chown -hR dac:dac "$LIVE/server/node_modules"
    else
      echo "WARNING: could not move dependencies back from $source"
    fi
  fi
}

restore_restart_services() {
  local stream_errors=$1
  shift
  if [ "${ARCHIVE_WAS_ACTIVE:-inactive}" = active ] && [ -f "$LIVE/scripts/archive-raw.sh" ]; then
    systemctl start free-sleep-archive-raw.timer >/dev/null 2>&1 || true
  fi
  if [ -f "$NIGHTSTAND_SCRIPTS/block_internet_access.sh" ]; then
    if [ "$#" -gt 0 ]; then
      "$@" || say "WARNING: restored firewall could not be applied"
    else
      sh "$NIGHTSTAND_SCRIPTS/block_internet_access.sh" || say "WARNING: restored firewall could not be applied"
    fi
  fi
  systemctl start free-sleep || {
    RESTORE_SERVICE_ERROR="start free-sleep failed"
    return 1
  }
  if [ "$STREAM_WAS_ACTIVE" = active ]; then
    if [ "$stream_errors" = strict ]; then
      systemctl restart free-sleep-stream || {
        RESTORE_SERVICE_ERROR="restart free-sleep-stream failed"
        return 1
      }
    else
      systemctl restart free-sleep-stream 2>/dev/null || true
    fi
  fi
}

# Cross-fork swaps require the retained installation's companion state.
restore_cross_fork_rollback() {
  local runner="$NIGHTSTAND_SCRIPTS/switch_installation.py"
  [ -f "$runner" ] || return 1
  python3 -B "$runner" companion --stage "$PREV" >/dev/null || return 1
  python3 -B "$runner" rollback --stage "$PREV" --recheck-in-use "${RECHECK_IN_USE:-no}"
}

init_update_firewall() {
  # iptables 1.6.0 added "-w SECONDS"; older builds take a bare -w or no flag.
  IPT_W=(-w 5)
  if ! iptables "${IPT_W[@]}" -S OUTPUT >/dev/null 2>&1; then
    IPT_W=(-w)
    if ! iptables "${IPT_W[@]}" -S OUTPUT >/dev/null 2>&1; then
      IPT_W=()
    fi
  fi
}

fw4() { iptables ${IPT_W[@]+"${IPT_W[@]}"} "$@"; }
fw6() { ip6tables ${IPT_W[@]+"${IPT_W[@]}"} "$@"; }
# Clear an emergency policy only after both families have terminal blocks.
restore_output_policy() {
  if { fw4 -C OUTPUT -j REJECT 2>/dev/null || fw4 -C OUTPUT -j DROP 2>/dev/null; } &&
     { fw6 -C OUTPUT -j REJECT 2>/dev/null || fw6 -C OUTPUT -j DROP 2>/dev/null; }; then
    local policy_failed=no
    fw4 -P OUTPUT ACCEPT || { echo "WARNING: could not restore IPv4 OUTPUT policy"; policy_failed=yes; }
    fw6 -P OUTPUT ACCEPT || { echo "WARNING: could not restore IPv6 OUTPUT policy"; policy_failed=yes; }
    # Download windows change live policies only.
    if [ "${1:-}" = save ] && [ "${WAN_OPEN:-no}" = no ] && [ "$policy_failed" = no ] &&
       fw4 -C INPUT -j DROP 2>/dev/null && fw6 -C INPUT -j DROP 2>/dev/null; then
      if ! iptables-save > /etc/iptables/iptables.rules ||
         ! ip6tables-save > /etc/iptables/ip6tables.rules; then
        echo "WARNING: could not save recovered firewall rules"
      fi
    fi
  fi
}

# The download window. Only HTTPS and name lookups go out, above the rest of
# the firewall. Nothing is flushed, so the inbound rules, the reset on the
# firmware's upload port and anything Tailscale added stay in place. IPv6
# stays blocked, with HTTPS refused rather than dropped so clients move to
# IPv4 at once. Callers set WAN_OPEN=no, define say, and run
# init_update_firewall first.
WAN_RULES=("-p tcp --dport 443 -j ACCEPT" "-p udp --dport 53 -j ACCEPT" "-p tcp --dport 53 -j ACCEPT")
WAN_RULE6="-p tcp --dport 443 -j REJECT --reject-with tcp-reset"
# Removes the given rules only while one of them is the first rule in OUTPUT,
# where the window puts them, so the same rule further down (Tailscale's
# HTTPS allow) is left alone. Rules are compared with whitespace and the
# implicit -m tcp/-m udp normalized.
strip_top() {
  local tool=$1 first spec match removed=0
  shift
  while [ "$removed" -lt 10 ]; do
    first=$("$tool" -S OUTPUT 2>/dev/null | awk '$1 == "-A" && $2 == "OUTPUT" { $1 = $2 = ""; $0 = $0; $1 = $1; print; exit }')
    first=${first// -m tcp/}
    first=${first// -m udp/}
    match=
    for spec in "$@"; do
      [ "$first" = "$spec" ] && match=$spec
    done
    [ -n "$match" ] || break
    # shellcheck disable=SC2086
    "$tool" -D OUTPUT $match || break
    removed=$((removed + 1))
  done
  echo "$removed"
}
open_wan() {
  say "Allowing HTTPS and DNS out for the download (temporary)"
  WAN_OPEN=yes
  local rule
  for rule in "${WAN_RULES[@]}"; do
    # shellcheck disable=SC2086
    fw4 -I OUTPUT 1 $rule || say "WARNING: could not allow $rule out"
  done
  # shellcheck disable=SC2086
  fw6 -I OUTPUT 1 $WAN_RULE6 2>/dev/null || true
  restore_output_policy
}
close_wan() {
  [ "$WAN_OPEN" = yes ] || return 0
  say "Closing internet access again"
  strip_top fw4 "${WAN_RULES[@]}" >/dev/null
  strip_top fw6 "$WAN_RULE6" >/dev/null
  sh "$NIGHTSTAND_SCRIPTS/block_internet_access.sh" >/dev/null 2>&1 || true
  restore_output_policy
  WAN_OPEN=no
}
# A stalled step must not hold the window open. Busybox builds that only
# take "timeout -t SECS" fail the probe and get the watchdog instead.
run_limited() {
  local seconds=$1 pid watchdog status
  shift
  if timeout 1 true 2>/dev/null; then
    timeout "$seconds" "$@"
    return
  fi
  "$@" &
  pid=$!
  (
    i=0
    while [ "$i" -lt "$seconds" ]; do sleep 1; i=$((i + 1)); done
    kill -TERM "$pid" 2>/dev/null
  ) &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return "$status"
}

# The lock updates, rollbacks, switches and the Biometrics install share, on
# fd 9. The owner variable keeps it across the updater's exec handoff.
# Returns 1 when the lock cannot be opened, 2 while another run holds it.
take_operation_lock() {
  [ "${NIGHTSTAND_OPERATION_OWNER:-}" != "$$" ] || return 0
  local lock="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
  if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
    lock=/tmp/free-sleep-operation.lock
  fi
  if [ -e "$lock" ]; then exec 9<"$lock"; else exec 9>>"$lock"; fi || return 1
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || return 2
  else
    python3 -I -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null || return 2
  fi
  export NIGHTSTAND_OPERATION_OWNER=$$
}

# How an update, rollback or switch ended, for the app to show. The caller
# sets the RESULT_* variables.
record_result() {
  local status=$1 outcome
  if [ "$status" -eq 0 ]; then
    if [ "$UP_TO_DATE" = yes ]; then outcome=up-to-date; else outcome=success; fi
  else
    case "$RESULT_PHASE" in
      preflight) outcome=stopped ;;
      restored) outcome=rolled-back ;;
      *) outcome=failed ;;
    esac
    if [ -z "$RESULT_REASON" ]; then
      case "$status" in
        129|130|143) RESULT_REASON="it was interrupted before it finished" ;;
        *) RESULT_REASON="it ended without giving a reason (exit status $status). See the update log." ;;
      esac
    fi
  fi
  python3 -I -c "$RESULT_PY" "$RESULT_FILE" "$RESULT_OPERATION" "$outcome" \
    "${CUR_VERSION:-}" "${EXPECTED_VERSION:-${TARGET_VERSION:-${STAGED_VERSION:-}}}" "$RESULT_REASON" >/dev/null 2>&1 || true
}

# Bed-in-use helpers for the updater, the rollback and the switch. The app
# writes REQUEST_FILE as it starts one of them.
# A request the owner did not confirm while the bed was in use is checked
# again just before the services stop, as the bed may have come into use
# since. Without the file or its field, as from an older server, an older
# updater or SSH, nothing is checked again. A file older than ten minutes
# was left by a request whose run never started, so it is ignored too.
REQUEST_FILE=/persistent/free-sleep-data/operation-request.json
RECHECK_IN_USE=no
IN_USE_REASON="the bed came into use while it was getting ready"
read_request() {
  [ -f "$REQUEST_FILE" ] || return 0
  RECHECK_IN_USE=$(python3 -I -c '
import json, os, sys, time
try:
    if time.time() - os.path.getmtime(sys.argv[1]) > 600:
        raise ValueError("stale")
    with open(sys.argv[1]) as handle:
        request = json.load(handle)
    print("yes" if request.get("source") == "app" and request.get("confirmInUse") is False else "no")
except Exception:
    print("no")' "$REQUEST_FILE" 2>/dev/null) || RECHECK_IN_USE=no
  rm -f "$REQUEST_FILE"
}
recheck_in_use() {
  [ "$RECHECK_IN_USE" = yes ] || return 0
  local reasons
  reasons=$(curl -fsS --max-time 20 http://127.0.0.1:3000/api/update/in-use 2>/dev/null | python3 -I -c '
import json, sys
reasons = json.load(sys.stdin)["reasons"]
assert isinstance(reasons, list)
print(" ".join(str(reason) for reason in reasons))' 2>/dev/null) || reasons=status-unknown
  [ -n "$reasons" ] || return 0
  RESULT_REASON=$IN_USE_REASON
  fail "the bed may be in use ($reasons); live install untouched"
}

# Until the server has stopped, its Biometrics switch can start the stream
# again, so the stream is checked once more after the server stops. A stream
# started meanwhile is stopped for the swap and started again after it.
stop_late_stream() {
  case "$(systemctl is-active free-sleep-stream 2>/dev/null)" in
    inactive|failed|unknown) return 0 ;;
  esac
  STREAM_WAS_ACTIVE=active
  stop_writer free-sleep-stream
}
