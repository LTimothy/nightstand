#!/usr/bin/env bash
# Roll the pod back to the previous deploy (kept at /home/dac/free-sleep-prev),
# or restore a specific backup tarball from /persistent/free-sleep-backups.
#
# Usage: ops/rollback.sh            # swap back to the previous deploy
#        ops/rollback.sh --list     # list available backups
#        ops/rollback.sh --from <backup-dir-name>   # restore from tarball
set -euo pipefail

# Pod connection: same defaults as deploy.sh. By default reach the pod at its
# stock mDNS name (eight-pod.local) over the known ssh user/port; set POD_HOST to
# your own ssh target (alias or user@host) to override.
POD_USER="${POD_USER:-root}"
POD_PORT="${POD_PORT:-8822}"
if [ -n "${POD_HOST:-}" ]; then
  POD="$POD_HOST"; SSH_CONN=""
else
  POD="${POD_USER}@eight-pod.local"
  SSH_CONN="-p $POD_PORT -o StrictHostKeyChecking=accept-new"
fi
# $SSH_CONN is used unquoted so an empty value expands to nothing (bash 3.2).
POD_SSH_HINT="ssh${SSH_CONN:+ $SSH_CONN} $POD"

# Health check talks HTTP: prefer explicit POD_IP; else $POD's ssh HostName; else
# the pod's mDNS name.
if [ -z "${POD_IP:-}" ]; then
  POD_IP=$(ssh -G "$POD" 2>/dev/null | awk '/^hostname /{print $2; exit}')
  case "${POD_IP:-}" in ""|"$POD") POD_IP="eight-pod.local" ;; esac
fi
LIVE=/home/dac/free-sleep
PREV=/home/dac/free-sleep-prev
BACKUPS=/persistent/free-sleep-backups

if ssh -o BatchMode=yes -o ConnectTimeout=5 $SSH_CONN "$POD" true 2>/dev/null; then
  SSH() { ssh $SSH_CONN "$POD" "$@"; }
else
  PASS="${POD_PASSWORD:-$(cat "$HOME/.config/free-sleep/pod.pass" 2>/dev/null || true)}"
  [ -n "$PASS" ] || { echo "no key auth and no password available" >&2; exit 1; }
  SSH() { sshpass -p "$PASS" ssh $SSH_CONN "$POD" "$@"; }
fi

if [ "${1:-}" = "--list" ]; then
  SSH "ls -1dt $BACKUPS/*/ 2>/dev/null || echo 'no backups'"
  exit 0
fi

if [ "${1:-}" = "--from" ]; then
  [ -n "${2:-}" ] || { echo "usage: ops/rollback.sh --from <backup-dir-name>" >&2; exit 2; }
  BK="$BACKUPS/$2"
  echo "==> Restoring code from $BK/code.tar.gz (node_modules will be reused from current live tree)"
  SSH "set -e
    [ -f '$BK/code.tar.gz' ] || { echo 'backup not found'; exit 1; }
    STREAM_WAS_ACTIVE=\$(systemctl is-active free-sleep-stream 2>/dev/null || true)
    systemctl stop free-sleep-stream 2>/dev/null || true
    systemctl stop free-sleep
    rm -rf /home/dac/free-sleep-restore
    mkdir /home/dac/free-sleep-restore
    tar xzf '$BK/code.tar.gz' -C /home/dac/free-sleep-restore
    rm -rf $PREV; mv $LIVE $PREV
    mv /home/dac/free-sleep-restore/free-sleep $LIVE
    rmdir /home/dac/free-sleep-restore
    mv $PREV/server/node_modules $LIVE/server/node_modules
    chown -hR dac:dac $LIVE
    systemctl start free-sleep
    python3 -B /usr/local/lib/nightstand/live/scripts/system_scripts.py follow $LIVE >/dev/null 2>&1 || true
    if [ \"\$STREAM_WAS_ACTIVE\" = active ]; then
      systemctl restart free-sleep-stream 2>/dev/null || true
    fi
  "
else
  echo "==> Swapping back to previous deploy at $PREV"
  SSH "set -e
    [ -d $PREV ] || { echo 'no previous deploy present'; exit 1; }
    STREAM_WAS_ACTIVE=\$(systemctl is-active free-sleep-stream 2>/dev/null || true)
    systemctl stop free-sleep-stream 2>/dev/null || true
    systemctl stop free-sleep
    rm -rf /home/dac/free-sleep-failed
    mv $LIVE /home/dac/free-sleep-failed
    mv $PREV $LIVE
    [ -d $LIVE/server/node_modules ] || mv /home/dac/free-sleep-failed/server/node_modules $LIVE/server/node_modules
    systemctl start free-sleep
    python3 -B /usr/local/lib/nightstand/live/scripts/system_scripts.py follow $LIVE >/dev/null 2>&1 || true
    if [ \"\$STREAM_WAS_ACTIVE\" = active ]; then
      systemctl restart free-sleep-stream 2>/dev/null || true
    fi
  "
fi

sleep 8
if curl -sf --max-time 5 "http://$POD_IP:3000/api/deviceStatus" >/dev/null; then
  echo "==> Rollback complete and server is healthy"
else
  echo "==> Rollback applied but server not answering yet - check: $POD_SSH_HINT journalctl -u free-sleep -n 100" >&2
  exit 1
fi
