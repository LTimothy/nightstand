#!/bin/bash
# Keeps the systemd journal in RAM (memory) or on flash as the Pod shipped
# (disk), for the Features switch "Keep the system log in memory". It takes
# effect at the next restart of the Pod; journald is not restarted.
# Usage: journal_storage.sh memory|disk|tidy   (run as root)
# tidy removes the old journal files left on flash once the log is in memory.
# Removed files cannot be restored; the folders stay, so journald can write
# there again if the switch is turned off.
# To undo, turn the switch off; if Nightstand is no longer running, run
# bash /usr/local/lib/nightstand/live/scripts/journal_storage.sh disk
# (the server rewrites the drop-in at startup while the switch is on).
set -u
DIR="${NIGHTSTAND_JOURNALD_DIR:-/etc/systemd/journald.conf.d}"
DROPIN="$DIR/10-nightstand-memory.conf"
JOURNAL="${NIGHTSTAND_JOURNAL_DIR:-/var/log/journal}"
RUNTIME="${NIGHTSTAND_RUNTIME_JOURNAL_DIR:-/run/log/journal}"
OWNER="${NIGHTSTAND_JOURNAL_OWNER:-root}"
[ $# -eq 1 ] || set -- usage

case "$1" in
  memory)
    [ -f "$DROPIN" ] && exit 0
    bash "$(dirname "${BASH_SOURCE[0]}")/record_stock.sh" journald
    mkdir -p "$DIR" || exit 1
    tmp=$(mktemp "$DROPIN.XXXXXX") || exit 1
    if printf '%s\n' '# Written by Nightstand. "journal_storage.sh disk" removes it.' \
      '[Journal]' 'Storage=volatile' 'RuntimeMaxUse=64M' > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$DROPIN"; then
      echo "The system log moves to memory at the next restart of the Pod."
    else
      rm -f "$tmp"
      exit 1
    fi
    ;;
  disk)
    rm -f "$DROPIN" || exit 1
    echo "The system log is kept on flash from the next restart of the Pod."
    ;;
  tidy)
    # Only once journald writes to memory and nothing on flash changed for an hour.
    [ -f "$DROPIN" ] || exit 0
    [ -n "$(find "$RUNTIME" -name '*.journal' -type f -print -quit 2>/dev/null)" ] || exit 0
    # The stock Pod links /var/log/journal to /persistent/journal. Follow a link
    # only when its owner alone could have made it, in a folder no one else can write.
    if [ -L "$JOURNAL" ]; then
      parent=$(cd -P "$(dirname "$JOURNAL")" 2>/dev/null && pwd) || exit 0
      [ -n "$(find "$JOURNAL" -maxdepth 0 -user "$OWNER" -print)" ] || exit 0
      [ -n "$(find "$parent" -maxdepth 0 -user "$OWNER" ! -perm -g+w ! -perm -o+w -print)" ] || exit 0
      JOURNAL=$(readlink -f "$JOURNAL") || exit 0
    fi
    [ -d "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || exit 0
    [ -n "$(find "$JOURNAL" -maxdepth 0 -user "$OWNER" -print)" ] || exit 0
    [ -z "$(find "$JOURNAL" -xdev -type f -mmin -60 -print -quit)" ] || exit 0
    count=$(find "$JOURNAL" -xdev -type f \( -name '*.journal' -o -name '*.journal~' \) -print -delete | wc -l)
    echo "Removed $((count)) old system log files from flash."
    ;;
  *)
    echo "Usage: journal_storage.sh memory|disk|tidy" >&2
    exit 2
    ;;
esac
