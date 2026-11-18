#!/bin/bash
# Keeps the systemd journal in RAM (memory) or on flash as the Pod shipped
# (disk), for the Features switch "Keep the system log in memory". It takes
# effect at the next restart of the Pod; journald is not restarted.
# Usage: journal_storage.sh memory|disk   (run as root)
# To undo, turn the switch off; if Nightstand is no longer running, run
# bash /usr/local/lib/nightstand/live/scripts/journal_storage.sh disk
# (the server rewrites the drop-in at startup while the switch is on).
set -u
DIR="${NIGHTSTAND_JOURNALD_DIR:-/etc/systemd/journald.conf.d}"
DROPIN="$DIR/10-nightstand-memory.conf"
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
  *)
    echo "Usage: journal_storage.sh memory|disk" >&2
    exit 2
    ;;
esac
