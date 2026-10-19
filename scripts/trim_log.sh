#!/bin/bash
# Keeps an operation log under 1 MiB by dropping its older half. Runs before
# the unit writes, and rewrites the file in place so its owner and the
# unit's append handle stay valid.
set -u
LOG=${1:?usage: trim_log.sh LOG}
# The server user owns the log folder and could swap the path between two
# lookups, so root opens it once, never through a link, and works on that
# descriptor only.
exec python3 -I -c '
import os, stat, sys
MAX_BYTES = 1048576
try:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(0)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size <= MAX_BYTES:
    sys.exit(0)
os.lseek(fd, -(MAX_BYTES // 2), os.SEEK_END)
kept = b""
while True:
    chunk = os.read(fd, MAX_BYTES)
    if not chunk:
        break
    kept += chunk
# The first line after the cut is partial, so it goes too.
kept = kept.partition(b"\n")[2]
os.lseek(fd, 0, os.SEEK_SET)
view = memoryview(kept)
while view:
    view = view[os.write(fd, view):]
os.ftruncate(fd, len(kept))
' "$LOG"
