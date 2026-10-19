#!/usr/bin/env bash
# Build locally, sync any new server runtime deps from local node_modules, then
# scp only the build artifacts whose CONTENT changed since the last successful
# deploy. The Pod can't `npm install` (WAN is blocked) so we use the local
# package-lock.json as the source of truth and tar+ship missing packages from
# the dev machine's server/node_modules.
#
# State kept locally:
#   .deploy-state/manifest.txt, sha256 of each file shipped last time
#   .deploy-state/pod-package-lock.json, last known Pod lockfile
#
# Usage:
#   ./scripts/deploy-dev.sh             # build + sync deps + scp changed files + restart
#   ./scripts/deploy-dev.sh --frontend  # only server/public/ (skip dep sync)
#   ./scripts/deploy-dev.sh --backend   # only server/dist/
#   ./scripts/deploy-dev.sh --biometrics  # one-shot: scp biometrics/ + restart free-sleep-stream
#   ./scripts/deploy-dev.sh --full      # ignore manifest; push every file
#   ./scripts/deploy-dev.sh --no-build  # skip build (use existing dist/public)
#   ./scripts/deploy-dev.sh --logs      # tail journalctl on the Pod

# Re-exec under bash if invoked as `sh script.sh` (macOS sh ≠ bash).
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

# --------------------------------------------------------------------------------
POD_HOST="${POD_HOST:-192.168.1.100}"
POD_PORT="${POD_PORT:-8822}"
POD_USER="${POD_USER:-root}"
POD_DIR="/home/dac/free-sleep"
STATE_DIR=".deploy-state"
MANIFEST_FILE="$STATE_DIR/manifest.txt"

# Single SSH connection across all calls below = one password prompt.
SSH_CTL="/tmp/fs-deploy-%r@%h:%p"
SSH_OPTS=(-o IdentitiesOnly=yes
          -o ControlMaster=auto
          -o ControlPath="$SSH_CTL"
          -o ControlPersist=120
          -p "$POD_PORT")
# When this host and the pod are both Wi-Fi stations on one subnet, the access
# point has to receive every frame and resend it on the same radio, so an
# upload between them collapses well below line rate and the path wedges
# instead of slowing down. Pacing the transfer keeps it under that cliff. This
# mostly ships small changed-file deltas that would stay under it anyway, but a
# dependency sync or the biometrics tarball would not. Same knob as
# ops/deploy.sh, which explains the measurements; raise it on a wired link.
SHIP_RATE_KBIT="${SHIP_RATE_KBIT:-24000}"
SCP_OPTS=(-o IdentitiesOnly=yes
          -o ControlMaster=auto
          -o ControlPath="$SSH_CTL"
          -o ControlPersist=120
          -l "$SHIP_RATE_KBIT"
          -P "$POD_PORT")
SSH_TARGET="${POD_USER}@${POD_HOST}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; GREY='\033[0;90m'; NC='\033[0m'
say()  { printf '%b==>%b %s\n' "$CYAN" "$NC" "$*"; }
ok()   { printf '%b✓%b %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%b!%b %s\n' "$YELLOW" "$NC" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$NC" "$*" >&2; exit 1; }
dim()  { printf '%b%s%b\n' "$GREY" "$*" "$NC"; }

pod() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p "$STATE_DIR"

# Wipe macOS Finder junk that gnubby-scp chokes on.
find server/dist server/public \( -name '.DS_Store' -o -name '._*' \) -delete 2>/dev/null || true

# --------------------------------------------------------------------------------
SKIP_BUILD="false"
DO_FRONTEND="true"
DO_BACKEND="true"
FORCE_FULL="false"
case "${1:-}" in
  --frontend) DO_BACKEND="false" ;;
  --backend)  DO_FRONTEND="false" ;;
  --full)     FORCE_FULL="true" ;;
  --no-build) SKIP_BUILD="true" ;;
  --logs)     exec ssh -t "${SSH_OPTS[@]}" "$SSH_TARGET" \
                "journalctl -u free-sleep -f --no-pager --output=cat" ;;
  --biometrics)
    # One-shot biometrics sync. We don't do this on every deploy because the
    # Python service rarely changes; usually only when fixing biometrics-specific
    # bugs (signal thresholds, presence detection, etc.).
    say "Syncing biometrics/ to Pod..."
    BIO_TGZ="/tmp/fs-biometrics.tgz"
    tar --exclude='__pycache__' --exclude='*.pyc' \
        -czf "$BIO_TGZ" -C "$REPO_ROOT" biometrics
    # A fresh name on the Pod, so root's copy never lands on a planted link.
    POD_TGZ=$(pod mktemp) || fail "could not create a temporary file on the Pod."
    scp "${SCP_OPTS[@]}" -q "$BIO_TGZ" "${SSH_TARGET}:$POD_TGZ" \
      || fail "scp of biometrics tarball failed."
    pod "set -e
         tar -xzf '$POD_TGZ' -C /home/dac/free-sleep/
         chown -hR dac:dac /home/dac/free-sleep/biometrics
         rm -f '$POD_TGZ'
         systemctl restart free-sleep-stream || true
         systemctl is-active free-sleep-stream" \
      && ok "Biometrics synced and free-sleep-stream restarted." \
      || fail "Biometrics sync or restart failed."
    rm -f "$BIO_TGZ"
    exit 0
    ;;
  -h|--help)  sed -n '2,13p' "$0"; exit 0 ;;
  "")         ;;
  *)          fail "Unknown argument: $1" ;;
esac

# --------------------------------------------------------------------------------
# 1. Build locally, fail fast before touching the Pod
if [ "$SKIP_BUILD" = "false" ]; then
  if [ "$DO_FRONTEND" = "true" ]; then
    say "Building app (frontend → server/public/)..."
    ( cd app && npm run build ) || fail "Frontend build failed, Pod not touched."
    ok "Frontend built."
  fi
  if [ "$DO_BACKEND" = "true" ]; then
    say "Building server (TypeScript → server/dist/)..."
    ( cd server && npm run build:pr ) || fail "Server build failed, Pod not touched."
    ok "Server built."
  fi
else
  warn "Skipping build (--no-build)."
fi

# --------------------------------------------------------------------------------
# 1.5. Sync server/node_modules diffs (Pod can't `npm install`, WAN is blocked).
#      Local package-lock.json is the source of truth; we tar+ship any package
#      dir whose version differs from the Pod's, and rm packages the Pod no
#      longer needs.
if [ "$DO_BACKEND" = "true" ]; then
  say "Checking server runtime deps for changes..."
  POD_LOCK_TMP="$STATE_DIR/pod-package-lock.json"
  : > "$POD_LOCK_TMP"
  pod "cat /home/dac/free-sleep/server/package-lock.json 2>/dev/null" > "$POD_LOCK_TMP" || true

  DIFF_OUT="$STATE_DIR/nm-diff.txt"
  if ! node "$REPO_ROOT/scripts/_diff-node-modules.mjs" \
       "$REPO_ROOT/server/package-lock.json" "$POD_LOCK_TMP" > "$DIFF_OUT" 2>&1; then
    warn "node_modules diff failed; skipping dep sync"
    : > "$DIFF_OUT"
  fi

  if [ -s "$DIFF_OUT" ]; then
    add_count=$(grep -c '^ADD ' "$DIFF_OUT" 2>/dev/null || true)
    del_count=$(grep -c '^DEL ' "$DIFF_OUT" 2>/dev/null || true)
    add_count=${add_count:-0}
    del_count=${del_count:-0}
    say "Dep diff: +${add_count}, -${del_count}"

    # Process DELs: rm -rf on Pod (one ssh, multiple paths).
    if [ "$del_count" -gt 0 ]; then
      del_cmd=""
      while IFS= read -r line; do
        path="${line#DEL }"
        del_cmd+="rm -rf '/home/dac/free-sleep/server/${path}'; "
      done < <(grep '^DEL ' "$DIFF_OUT")
      pod "$del_cmd" || warn "Some dep removals failed"
    fi

    # Process ADDs: tar paths from local, pipe through ssh, extract on Pod.
    # Single tar+ssh round trip handles N packages.
    if [ "$add_count" -gt 0 ]; then
      ADD_LIST="$STATE_DIR/nm-add-paths.txt"
      grep '^ADD ' "$DIFF_OUT" | sed 's/^ADD //' > "$ADD_LIST"

      missing=0
      while IFS= read -r path; do
        if [ ! -e "$REPO_ROOT/server/$path" ]; then
          warn "Missing locally: server/${path}, run 'cd server && npm install'"
          missing=$((missing + 1))
        fi
      done < "$ADD_LIST"
      if [ "$missing" -gt 0 ]; then
        fail "${missing} dep dir(s) missing locally; deploy aborted."
      fi

      ( cd "$REPO_ROOT/server" && tar -cf - -T "$ADD_LIST" 2>/dev/null ) | \
        ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
          "mkdir -p /home/dac/free-sleep/server && tar -xf - -C /home/dac/free-sleep/server && chown -hR dac:dac /home/dac/free-sleep/server/node_modules" \
        || fail "Dep upload failed."
      ok "Synced ${add_count} dep dir(s) to Pod."
    fi

    # Ship the lockfile + package.json so the Pod's baseline matches local for
    # the next deploy. Without this, every run thinks deps are out of sync.
    scp "${SCP_OPTS[@]}" -q \
      "$REPO_ROOT/server/package.json" \
      "$REPO_ROOT/server/package-lock.json" \
      "${SSH_TARGET}:/home/dac/free-sleep/server/" \
      || warn "Failed to ship package.json/package-lock.json"
  else
    ok "Server deps unchanged."
  fi
fi

# --------------------------------------------------------------------------------
# 2. Compute hash of every candidate file currently in dist/public.
#    Roots are filtered by --frontend/--backend.
SHASUM_BIN="shasum"
command -v shasum >/dev/null 2>&1 || SHASUM_BIN="sha256sum"

build_roots=()
[ "$DO_BACKEND"  = "true" ] && build_roots+=("server/dist")
[ "$DO_FRONTEND" = "true" ] && build_roots+=("server/public")

CURRENT_HASHES="$STATE_DIR/current.txt"
: > "$CURRENT_HASHES"
for root in "${build_roots[@]}"; do
  [ -d "$root" ] || continue
  # shasum / sha256sum output: "<hash>  <path>"
  find "$root" -type f \
    \! -name '.DS_Store' \! -name '._*' \! -name '*.map' \
    -print0 \
    | xargs -0 "$SHASUM_BIN" -a 256 2>/dev/null \
    >> "$CURRENT_HASHES"
done
# Normalize: shasum prints the path as given; ensure consistent format.
sort -k 2 -o "$CURRENT_HASHES" "$CURRENT_HASHES"

# --------------------------------------------------------------------------------
# 3. Compare against the previous manifest. Files to upload =
#    (current hash differs from manifest) OR (file not in manifest).
#    --full pretends the manifest is empty so every file gets pushed.
declare -a UPLOAD_PATHS=()

use_full_push="$FORCE_FULL"

if [ "$use_full_push" = "false" ] && [ ! -s "$MANIFEST_FILE" ]; then
  # No local manifest. Rather than push everything blindly (which would re-send
  # ~225 files on a first run), ask the Pod for its current file hashes and use
  # that as our baseline. One round-trip; subsequent runs are normal.
  say "No local manifest, bootstrapping from the Pod's current files..."
  if pod "cd '$POD_DIR' && find server/dist server/public -type f \! -name '.DS_Store' \! -name '._*' \! -name '*.map' -print0 2>/dev/null | xargs -0 sha256sum 2>/dev/null" \
       > "$MANIFEST_FILE" 2>/dev/null && [ -s "$MANIFEST_FILE" ]; then
    sort -k 2 -o "$MANIFEST_FILE" "$MANIFEST_FILE"
    ok "Bootstrapped manifest: $(wc -l < "$MANIFEST_FILE" | tr -d ' ') file hashes from Pod."
  else
    warn "Bootstrap failed (Pod unreachable or empty install); falling back to full push."
    rm -f "$MANIFEST_FILE"
    use_full_push="true"
  fi
fi

if [ "$use_full_push" = "true" ]; then
  say "Pushing every file."
  while IFS= read -r line; do
    path="${line#*  }"
    UPLOAD_PATHS+=("$path")
  done < "$CURRENT_HASHES"
elif [ -s "$MANIFEST_FILE" ]; then
  # Build an associative-style lookup using a simple grep into manifest.
  # For each current entry, find the matching path in the manifest and compare.
  while IFS= read -r line; do
    cur_hash="${line%% *}"
    # Two spaces between hash and path in shasum output.
    path="${line#*  }"
    # Look up previous hash for this exact path. Anchor with a tab/space prefix
    # to avoid partial-match collisions.
    prev_line="$(grep -F "  $path" "$MANIFEST_FILE" 2>/dev/null | head -n 1 || true)"
    if [ -z "$prev_line" ]; then
      UPLOAD_PATHS+=("$path")
      continue
    fi
    prev_hash="${prev_line%% *}"
    if [ "$cur_hash" != "$prev_hash" ]; then
      UPLOAD_PATHS+=("$path")
    fi
  done < "$CURRENT_HASHES"
fi

if [ "${#UPLOAD_PATHS[@]}" -eq 0 ]; then
  ok "All files match the last successful deploy. Nothing to push."
  exit 0
fi

say "Files to upload: ${#UPLOAD_PATHS[@]}"

# --------------------------------------------------------------------------------
# 4. Pre-create remote directories.
remote_dirs_raw=""
for path in "${UPLOAD_PATHS[@]}"; do
  remote_dirs_raw+="$(dirname "${POD_DIR}/${path}")"$'\n'
done
mkdir_cmd=""
while IFS= read -r d; do
  [ -n "$d" ] && mkdir_cmd+="mkdir -p '$d'; "
done < <(printf '%s' "$remote_dirs_raw" | sort -u)
pod "$mkdir_cmd" || fail "Failed to create remote directories."

# --------------------------------------------------------------------------------
# 5. Upload each file. gnubby-scp has random per-file failures (and sometimes
# consistently rejects certain files). Strategy: try scp up to 3x with backoff,
# then fall back to `cat | ssh "cat > target"`, then base64-over-ssh.
MAX_SCP_ATTEMPTS=3
fail_count=0
for path in "${UPLOAD_PATHS[@]}"; do
  remote_p="${POD_DIR}/${path}"
  attempt=1
  uploaded="false"
  while [ "$attempt" -le "$MAX_SCP_ATTEMPTS" ]; do
    if scp "${SCP_OPTS[@]}" -q "$path" "${SSH_TARGET}:${remote_p}" 2>/dev/null; then
      if [ "$attempt" -eq 1 ]; then
        dim "  ✓ $path"
      else
        dim "  ✓ $path (scp attempt $attempt)"
      fi
      uploaded="true"
      break
    fi
    if [ "$attempt" -lt "$MAX_SCP_ATTEMPTS" ]; then
      warn "  scp retry $attempt/$((MAX_SCP_ATTEMPTS - 1)): $path"
      sleep "$attempt"
    fi
    attempt=$((attempt + 1))
  done

  if [ "$uploaded" = "false" ]; then
    warn "  scp gave up; trying SSH cat fallback for $path"
    if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat > '$remote_p'" < "$path"; then
      dim "  ✓ $path (ssh cat fallback)"
      uploaded="true"
    fi
  fi

  if [ "$uploaded" = "false" ]; then
    warn "  ssh cat failed too; trying base64 fallback for $path"
    if base64 < "$path" | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "base64 -d > '$remote_p'"; then
      dim "  ✓ $path (base64 fallback)"
      uploaded="true"
    fi
  fi

  if [ "$uploaded" = "false" ]; then
    warn "  ✗ $path, all upload methods failed"
    fail_count=$((fail_count + 1))
  fi
done

if [ "$fail_count" -gt 0 ]; then
  fail "$fail_count file(s) failed to upload. Service NOT restarted. Re-run, or use --full."
fi

pod "chown -hR dac:dac '${POD_DIR}/server/dist' '${POD_DIR}/server/public'" || true

# --------------------------------------------------------------------------------
# 6. Restart service
say "Restarting free-sleep..."
pod "systemctl restart free-sleep"
sleep 2
if pod "systemctl is-active free-sleep" >/dev/null 2>&1; then
  ok "free-sleep is active."
else
  warn "Service is not active, check './scripts/deploy-dev.sh --logs'."
fi

# --------------------------------------------------------------------------------
# 7. Update manifest (only on success). Merge: keep entries for files we did NOT
#    consider this run (e.g., in --frontend mode the backend entries stay
#    untouched). Then overlay this run's CURRENT_HASHES on top.
if [ -f "$MANIFEST_FILE" ]; then
  # Pull entries for the OTHER side that we didn't touch this run.
  if [ "$DO_FRONTEND" = "true" ] && [ "$DO_BACKEND" = "false" ]; then
    grep -v '  server/public/' "$MANIFEST_FILE" > "$STATE_DIR/keep.txt" || true
  elif [ "$DO_BACKEND" = "true" ] && [ "$DO_FRONTEND" = "false" ]; then
    grep -v '  server/dist/' "$MANIFEST_FILE" > "$STATE_DIR/keep.txt" || true
  else
    : > "$STATE_DIR/keep.txt"
  fi
  cat "$STATE_DIR/keep.txt" "$CURRENT_HASHES" | sort -u -k 2 > "$MANIFEST_FILE"
  rm -f "$STATE_DIR/keep.txt"
else
  cp "$CURRENT_HASHES" "$MANIFEST_FILE"
fi
rm -f "$CURRENT_HASHES"

ok "Deploy complete. Manifest updated ($(wc -l < "$MANIFEST_FILE" | tr -d ' ') file hashes tracked)."
