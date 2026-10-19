#!/bin/bash
# Laptop-side half of the agent bootstrap: take a pod running upstream
# free-sleep and add the agent to it, the updater/rollback/revert machinery and
# nothing else. Rung 2 of the install ladder.
#
# This is the smaller sibling of scripts/migrate/switch-to-this-fork.sh. That
# tool moves a pod from another fork onto this whole tree; this one leaves the
# pod's upstream free-sleep code in place and overlays the agent files.
#
# The agent tree is built HERE, not on the pod. Generating it needs git, a full
# upstream clone and a node toolchain, and putting those failure modes on an
# embedded device behind a firewalled WAN is exactly where they are least
# recoverable. Once the published agent artifact exists this script fetches it
# instead, and the pod-side half does not care which happened.
#
# Usage:
#   ops/bootstrap-agent.sh --ip <addr> [--port <ssh-port>] [--dry-run]
#   ops/bootstrap-agent.sh --help
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POD_IP=""
SSH_PORT=8822
DRY_RUN=0
WORK=""

say()  { echo "[bootstrap-agent] $*"; }
fail() { echo "[bootstrap-agent] FATAL: $*" >&2; exit 1; }

cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) POD_IP="${2:-}"; shift 2 ;;
    --port) SSH_PORT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      sed -n '1,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$POD_IP" ] || fail "need --ip <addr>"

ssh_pod() { ssh -o ConnectTimeout=10 -o BatchMode=no -p "$SSH_PORT" "root@$POD_IP" "$@"; }

# ==============================================================================
# Stage 1: confirm the target is upstream free-sleep, before building anything
# ==============================================================================
say "Checking $POD_IP is running upstream free-sleep"
if ! ssh_pod "true" >/dev/null 2>&1; then
  # A dry run is worth something without a pod: it still builds the payload and
  # proves the generator and manifest agree. Only a real run needs the target.
  [ "$DRY_RUN" = "1" ] || fail "cannot reach the pod over ssh on port $SSH_PORT"
  say "Pod unreachable; dry run continues without the target check"
  REMOTE_STATE=skipped
fi

[ "${REMOTE_STATE:-}" = "skipped" ] || REMOTE_STATE=$(ssh_pod "
  [ -d /home/dac/free-sleep ] || { echo 'no-install'; exit 0; }
  [ -f /home/dac/free-sleep/server/package.json ] || { echo 'unrecognized'; exit 0; }
  if [ -d /home/dac/free-sleep/server/src/agent ] || [ -f /home/dac/free-sleep/server/src/routes/update/update.ts ]; then
    echo 'already-agent'; exit 0
  fi
  if grep -q \"routes/update/update.js\" /home/dac/free-sleep/server/src/setup/routes.ts 2>/dev/null; then
    echo 'already-agent'; exit 0
  fi
  echo 'stock'
" 2>/dev/null | tr -d '\r')

case "$REMOTE_STATE" in
  skipped) ;;
  stock) say "Target looks like upstream free-sleep" ;;
  no-install)   fail "no free-sleep install at /home/dac/free-sleep. The agent overlays an existing install; use the project's own install.sh first." ;;
  unrecognized) fail "the install at /home/dac/free-sleep is not recognizable. Refusing to overlay something this tool does not understand." ;;
  already-agent) fail "this pod already carries the agent. Use the in-app updater rather than bootstrapping again." ;;
  *) fail "could not determine what the pod is running (got '$REMOTE_STATE')" ;;
esac

# ==============================================================================
# Stage 2: build the agent tree here, and reduce it to a payload
# ==============================================================================
WORK=$(mktemp -d)
AGENT_TREE="$WORK/agent-tree"
PAYLOAD="$WORK/payload"

say "Generating the agent tree from upstream free-sleep at the pinned base"
"$REPO_ROOT/ops/build-agent.sh" --out "$AGENT_TREE" --skip-validate \
  || fail "the generator failed; nothing was sent to the pod"

say "Reducing it to the manifest's files"
mkdir -p "$PAYLOAD/files"
node --experimental-strip-types -e "
  import('$REPO_ROOT/server/src/agent/agentManifest.ts').then((m) => {
    for (const e of m.AGENT_MANIFEST) console.log(e.mode + '|' + e.path);
  });
" 2>/dev/null > "$PAYLOAD/MANIFEST" || fail "could not read the agent manifest"
[ -s "$PAYLOAD/MANIFEST" ] || fail "the agent manifest came back empty"

while IFS='|' read -r mode path; do
  [ -n "${path:-}" ] || continue
  [ "$mode" = "patch" ] && continue
  mkdir -p "$PAYLOAD/files/$(dirname "$path")"
  cp "$AGENT_TREE/$path" "$PAYLOAD/files/$path" \
    || fail "the generated tree is missing $path"
done < "$PAYLOAD/MANIFEST"

# The pod applies the two patches to its OWN files, so it needs the value
# rather than the file. Read it from this repo so it cannot drift.
node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_ROOT/server/package.json','utf8')).scripts.test || '')" \
  > "$PAYLOAD/test-script" || fail "could not read the test script to carry over"
[ -s "$PAYLOAD/test-script" ] || fail "server/package.json has no test script to carry over"

FILE_COUNT=$(find "$PAYLOAD/files" -type f | wc -l | tr -d ' ')
say "Payload: $FILE_COUNT files plus 2 patches"

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run: built the payload and verified the target, sending nothing."
  exit 0
fi

# ==============================================================================
# Stage 3: ship it and run the pod-side half detached
# ==============================================================================
say "Sending the payload"
ssh_pod "rm -rf /usr/local/lib/nightstand/migrate/agent-payload && mkdir -p /usr/local/lib/nightstand/migrate/agent-payload && chmod 755 /usr/local/lib/nightstand /usr/local/lib/nightstand/migrate" \
  || fail "could not prepare the payload directory on the pod"
scp -q -P "$SSH_PORT" -r "$PAYLOAD/." "root@$POD_IP:/usr/local/lib/nightstand/migrate/agent-payload/" \
  || fail "could not send the payload"
scp -q -P "$SSH_PORT" \
  "$REPO_ROOT/scripts/migrate/agent-bootstrap-installer.sh" \
  "$REPO_ROOT/scripts/migrate/restore-original-fork.sh" \
  "$REPO_ROOT/scripts/restore_helpers.sh" \
  "root@$POD_IP:/usr/local/lib/nightstand/migrate/" || fail "could not send the installer"

say "Starting the installer detached (a dropped connection from here changes nothing)"
ssh_pod "chmod +x /usr/local/lib/nightstand/migrate/agent-bootstrap-installer.sh /usr/local/lib/nightstand/migrate/restore-original-fork.sh && \
  (systemd-run --unit=free-sleep-agent-bootstrap --same-dir /bin/bash /usr/local/lib/nightstand/migrate/agent-bootstrap-installer.sh \
   || nohup /bin/bash /usr/local/lib/nightstand/migrate/agent-bootstrap-installer.sh >/dev/null 2>&1 &)" \
  || fail "could not start the installer on the pod"

say "Started. It stages, swaps, health-checks and restores on failure by itself."
say "Watch: ssh -p $SSH_PORT root@$POD_IP 'tail -f /persistent/nightstand-logs/agent-bootstrap-*.log'"
