#!/bin/bash
# Inspect legacy firewall cron and units before a fork switch.
set -uo pipefail

fail() { echo "Refusing switch: $*" >&2; exit 1; }

# Root restores these as its crontab, so they live where only root can write.
BACKUP_ROOT=/persistent/nightstand-migrate-artifacts
# Older releases kept them in the server user's home; trusted only as root's.
LEGACY_ROOT=/home/dac/free-sleep-migrate-artifacts
AMBIENT_UNIT=/etc/systemd/system/free-sleep-ambient-light.service
SYNC_SCRIPT=/usr/local/bin/sync-time-with-internet.sh
MODE=${1:-inspect}

# Enters folder $1 if it is a real folder this user owns that nobody else can
# write, so the paths used after it cannot be swapped through a link.
enter_own() {
  [ -d "$1" ] && [ ! -L "$1" ] && cd "$1" && [ -O . ] && [ "$(LC_ALL=C ls -ld . | cut -c6,9)" = -- ]
}

if [ "$MODE" = restore ]; then
  ROOT_DIR=$BACKUP_ROOT
  if [ ! -f "$BACKUP_ROOT/pending" ]; then
    [ -f "$LEGACY_ROOT/pending" ] || exit 0
    ROOT_DIR=$LEGACY_ROOT
  fi
  if ! enter_own "$ROOT_DIR"; then
    [ "$ROOT_DIR" = "$LEGACY_ROOT" ] || fail "$ROOT_DIR is not a folder only root can write"
    echo "WARNING: skipped the artifact backups in $LEGACY_ROOT, which root does not own alone" >&2
    exit 0
  fi
  BACKUP_DIR=$(cat pending) || fail "could not read artifact backup path"
  case "$BACKUP_DIR" in "$ROOT_DIR"/backup.*) ;; *) fail "invalid artifact backup path" ;; esac
  BACKUP_DIR=./${BACKUP_DIR#"$ROOT_DIR"/}
  case "$BACKUP_DIR" in */*/*) fail "invalid artifact backup path" ;; esac
  if [ -f "$BACKUP_DIR/root.crontab" ]; then
    crontab -u root "$BACKUP_DIR/root.crontab" || fail "could not restore root cron"
  fi
  if [ -f "$BACKUP_DIR/sync-time-with-internet.sh" ]; then
    cp -p "$BACKUP_DIR/sync-time-with-internet.sh" "$SYNC_SCRIPT" || fail "could not restore time sync script"
  fi
  if [ -e "$BACKUP_DIR/free-sleep-ambient-light.service" ]; then
    cp -a "$BACKUP_DIR/free-sleep-ambient-light.service" "$AMBIENT_UNIT" || fail "could not restore ambient-light unit file"
    systemctl daemon-reload || fail "could not reload restored unit file"
  fi
  # Foreign units stay stopped. The owner can review and enable them separately.
  rm -f pending || fail "could not clear artifact restore marker"
  exit 0
fi
if [ "$MODE" = finish ]; then
  rm -f "$BACKUP_ROOT/pending" || fail "could not retire artifact restore marker"
  exit 0
fi

read_root_cron() {
  ROOT_CRON=""
  command -v crontab >/dev/null 2>&1 || return 0
  local errors
  errors=$(mktemp) || return 1
  if ! ROOT_CRON=$(LC_ALL=C crontab -u root -l 2>"$errors"); then
    if ! grep -qi 'no crontab for root' "$errors"; then
      cat "$errors" >&2
      rm -f "$errors"
      return 1
    fi
    ROOT_CRON=""
  fi
  rm -f "$errors"
}

# Comments and unrelated jobs are retained, including jobs with other schedules.
filter_cron() {
  awk -v keep="$1" '
    { risky = $0 !~ /^[[:space:]]*#/ && ($0 ~ /sync-time-with-internet[.]sh/ || $0 ~ /\/home\/dac\/free-sleep\/scripts\/unblock_internet_access[.]sh/)
      if ((keep == "safe" && !risky) || (keep == "risky" && risky)) print }
  '
}

owned_unit() {
  case "$1" in
    free-sleep.service|free-sleep-stream.service|free-sleep-update.service|free-sleep-rollback.service|free-sleep-revert.service|free-sleep-archive-raw.service|free-sleep-archive-raw.timer|free-sleep-health.service|free-sleep-health.timer|free-sleep-network-watchdog.service|free-sleep-network-watchdog.timer|free-sleep-recover-switch.service|free-sleep-recover-update.service|free-sleep-recover-update.timer|free-sleep-migrate.service|free-sleep-migrate-sentinel.service|free-sleep-migrate-sentinel.timer) return 0 ;;
    *) return 1 ;;
  esac
}

inspect_units() {
  local files loaded unit
  files=$(systemctl list-unit-files --no-legend --no-pager 'free-sleep*') || return 1
  loaded=$(systemctl list-units --all --plain --no-legend --no-pager 'free-sleep*') || return 1
  FOREIGN_UNITS=()
  while read -r unit; do
    case "$unit" in
      free-sleep*) ;;
      *) continue ;;
    esac
    case "$unit" in *[!a-zA-Z0-9_.@:-]*) return 1 ;; esac
    owned_unit "$unit" || FOREIGN_UNITS+=("$unit")
  done < <(printf '%s\n%s\n' "$files" "$loaded" | awk '{print $1}' | sort -u)
}

if ! read_root_cron; then
  if [ "$MODE" = warn-cron ]; then
    echo "WARNING: could not inspect root cron for jobs that open the firewall."
    exit 0
  fi
  fail "could not inspect root crontab; nothing was changed"
fi
RISKY_CRON=$(printf '%s\n' "$ROOT_CRON" | filter_cron risky)
if [ "$MODE" = warn-cron ]; then
  if [ -n "$RISKY_CRON" ]; then
    echo "WARNING: root cron contains legacy jobs that open the firewall. Review and remove them with the fork-switch tool or crontab -u root -e. No cron entries were changed."
    printf '%s\n' "$RISKY_CRON"
  fi
  exit 0
fi
inspect_units || fail "could not inspect free-sleep units; nothing was changed"
REMOVE_AMBIENT=no
for unit in ${FOREIGN_UNITS[@]+"${FOREIGN_UNITS[@]}"}; do
  [ "$unit" != free-sleep-ambient-light.service ] || REMOVE_AMBIENT=yes
  echo "unit: $unit"
done
if [ -n "$RISKY_CRON" ]; then
  printf '%s\n' "$RISKY_CRON" | sed 's/^/cron: /'
fi
if [ -f /etc/sysctl.conf ]; then
  awk '/^[[:space:]]*net[.]ipv6[.]conf[.][^[:space:]=]+[.]disable_ipv6[[:space:]]*=[[:space:]]*1([[:space:]]|$)/ {print "ipv6: " $0}' /etc/sysctl.conf
fi
case "$MODE" in
  inspect) exit 0 ;;
  check|clean) ;;
  *) fail "unknown inspection mode" ;;
esac
if { [ -n "$RISKY_CRON" ] || [ "$REMOVE_AMBIENT" = yes ]; } && [ "${2:-no}" != yes ]; then
  fail "consent is required to remove firewall cron jobs and the ambient-light unit; nothing was changed"
fi
[ ! -f "$BACKUP_ROOT/pending" ] || fail "an earlier artifact cleanup needs restoration before retrying"
if [ -f "$LEGACY_ROOT/pending" ] && ( enter_own "$LEGACY_ROOT" ); then
  fail "an earlier artifact cleanup needs restoration before retrying"
fi
[ "$MODE" = clean ] || exit 0

# Retain copies before stopping units or editing cron, including on a failed switch.
if [ -n "$RISKY_CRON" ] || [ "$REMOVE_AMBIENT" = yes ]; then
  mkdir -p "$BACKUP_ROOT" || fail "could not create artifact backup directory"
  [ ! -L "$BACKUP_ROOT" ] && [ -O "$BACKUP_ROOT" ] || fail "$BACKUP_ROOT is not a folder only root can write"
  chmod 700 "$BACKUP_ROOT" || fail "could not protect artifact backups"
  BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/backup.XXXXXX") || fail "could not create artifact backup"
  if [ -n "$RISKY_CRON" ]; then
    printf '%s\n' "$ROOT_CRON" > "$BACKUP_DIR/root.crontab" || fail "could not back up root cron"
    if [ -f "$SYNC_SCRIPT" ]; then
      cp -p "$SYNC_SCRIPT" "$BACKUP_DIR/sync-time-with-internet.sh" || fail "could not back up time sync script"
    fi
  fi
  if [ "$REMOVE_AMBIENT" = yes ] && [ -e "$AMBIENT_UNIT" ]; then
    cp -a "$AMBIENT_UNIT" "$BACKUP_DIR/free-sleep-ambient-light.service" || fail "could not back up ambient-light unit"
  fi
  printf '%s\n' "$BACKUP_DIR" > "$BACKUP_ROOT/pending.tmp" || fail "could not write artifact restore marker"
  mv "$BACKUP_ROOT/pending.tmp" "$BACKUP_ROOT/pending" || fail "could not arm artifact restore"
  sync
  echo "Legacy artifact backup: $BACKUP_DIR"
fi

# Stop timers first so they cannot start another writer during the checkpoint.
for phase in timers others; do
  for unit in ${FOREIGN_UNITS[@]+"${FOREIGN_UNITS[@]}"}; do
    case "$phase:$unit" in timers:*.timer|others:*.timer) [ "$phase" = timers ] || continue ;; timers:*) continue ;; esac
    systemctl stop "$unit" || fail "could not stop $unit; database checkpoint was not attempted"
    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    case "$state" in inactive|failed|unknown) ;; *) fail "$unit is still running; database checkpoint was not attempted" ;; esac
  done
done
if [ -n "$RISKY_CRON" ]; then
  printf '%s\n' "$ROOT_CRON" | filter_cron safe | crontab -u root - \
    || fail "could not remove firewall cron jobs; switch was not attempted"
  read_root_cron || fail "could not verify root cron after cleanup"
  [ -z "$(printf '%s\n' "$ROOT_CRON" | filter_cron risky)" ] || fail "firewall cron jobs remain after cleanup"
  rm -f "$SYNC_SCRIPT" || fail "could not remove legacy time sync script"
fi
if [ "$REMOVE_AMBIENT" = yes ]; then
  systemctl disable free-sleep-ambient-light.service || fail "could not disable the ambient-light unit"
  rm -f "$AMBIENT_UNIT" || fail "could not remove the ambient-light unit"
  systemctl daemon-reload || fail "could not reload units after removing ambient-light"
fi
