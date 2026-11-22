#!/bin/bash
export PATH="/usr/sbin:/sbin:/usr/bin:/bin"
SYSTEMCTL="${NIGHTSTAND_SYSTEMCTL:-systemctl}"

# systemd refuses to stop a unit that does not load, even one that is not
# running, so the stream's state decides.
"$SYSTEMCTL" stop free-sleep-stream
case "$("$SYSTEMCTL" is-active free-sleep-stream 2>/dev/null)" in
  inactive|failed|unknown) ;;
  *) exit 1 ;;
esac
"$SYSTEMCTL" disable free-sleep-stream
