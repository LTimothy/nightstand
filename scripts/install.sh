#!/bin/bash
# Exit immediately on error, on undefined variables, and on error in pipelines
set -euo pipefail

# Share admission with updates, rollbacks, switches, resets and stream
# reconciliation, and keep the descriptor until the install and any restore
# have finished.
if [ "${NIGHTSTAND_OPERATION_OWNER:-}" != "$$" ]; then
  OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
  if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
    OPERATION_LOCK=/tmp/free-sleep-operation.lock
  fi
  if [ -e "$OPERATION_LOCK" ]; then exec 9<"$OPERATION_LOCK"; else exec 9>>"$OPERATION_LOCK"; fi \
    || { echo "Cannot open the operation lock"; exit 1; }
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || { echo "Another update, rollback, switch, install or reset is already running"; exit 1; }
  else
    python3 -I -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null \
      || { echo "Another operation is already running (or lock unavailable)"; exit 1; }
  fi
  export NIGHTSTAND_OPERATION_OWNER=$$
fi

# --------------------------------------------------------------------------------
# Variables
SYSTEM_DIR="${NIGHTSTAND_SYSTEM_DIR:-/usr/local/lib/nightstand}"
REPO_DIR="/home/dac/free-sleep"
PREV_DIR="/home/dac/free-sleep-prev"
FAILED_DIR="/home/dac/free-sleep-failed"
SERVER_DIR="$REPO_DIR/server"
USERNAME="dac"

# --------------------------------------------------------------------------------
# Which release to install: the newest release on NIGHTSTAND_CHANNEL, else on
# the channel a reinstall has saved, else the newest release on its own
# channel. As in the updater, beta also includes stable releases. The channel
# is saved below so updates follow what was installed.
#
# MIN_INSTALL_VERSION is the oldest release this script can install, since
# older trees lack scripts it calls. Raise it to the coming release whenever
# this script starts to need something only that release ships. The release
# commit turns [Unreleased] in CHANGELOG.md into the version, and from then
# on installScript.test.ts fails while this is newer than the version in
# server/src/serverInfo.json.
MIN_INSTALL_VERSION="3.7.0"
WANTED_CHANNEL="${NIGHTSTAND_CHANNEL:-}"
case "$WANTED_CHANNEL" in
  ""|stable|beta) ;;
  *) echo "NIGHTSTAND_CHANNEL must be stable or beta"; exit 1 ;;
esac
if [ -z "$WANTED_CHANNEL" ]; then
  # The old settings path wins, as it is moved over the new one below.
  WANTED_CHANNEL=$(python3 -I - /home/dac/free-sleep-database/settingsDB.json /persistent/free-sleep-data/lowdb/settingsDB.json <<'PY' || true
import json, os, sys
for path in sys.argv[1:]:
    if os.path.exists(path):
        try:
            with open(path) as handle:
                channel = json.load(handle).get("updateChannel")
        except (OSError, ValueError, AttributeError):
            channel = None
        if channel in ("stable", "beta"):
            print(channel)
        break
PY
)
fi
RELEASES_URL="https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json"
RELEASES_JSON=$(curl -fsSL --max-time 20 "$RELEASES_URL") \
  || { echo "Could not choose a release from releases.json"; exit 1; }
PICK=$(printf '%s' "$RELEASES_JSON" | python3 -I -c '
import json, re, sys
wanted = sys.argv[1]
try:
    for release in json.load(sys.stdin)["releases"]:
        channel = release.get("channel")
        if channel == "stable" or (wanted != "stable" and channel == "beta"):
            version = release["version"]
            if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
                sys.exit("invalid release version")
            print(version, wanted or channel, release.get("treeSha256") or "")
            break
    else:
        sys.exit("no release on the selected channel")
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit(1)' "$WANTED_CHANNEL") \
  || { echo "Could not choose a release from releases.json"; exit 1; }
read -r VERSION CHANNEL EXPECTED_DIGEST <<< "$PICK"
EXPECTED_DIGEST="${EXPECTED_DIGEST:-}"
if ! python3 -I -c '
import sys
parse = lambda version: tuple(int(part) for part in version.split("."))
sys.exit(parse(sys.argv[1]) < parse(sys.argv[2]))' "$VERSION" "$MIN_INSTALL_VERSION"; then
  echo "v$VERSION is older than this installer supports. To install the newest release, run the command again with NIGHTSTAND_CHANNEL=beta in front of it."
  exit 1
fi
REPO_URL="https://github.com/LTimothy/nightstand/archive/refs/tags/v${VERSION}.zip"
echo "Installing Nightstand v$VERSION from the $CHANNEL channel"

# --------------------------------------------------------------------------------
# Download the repository
# Downloaded and unpacked where only root can write.
mkdir -p "$SYSTEM_DIR" && WORK=$(mktemp -d "$SYSTEM_DIR/.download.XXXXXX") \
  || { echo "Could not create a download folder in $SYSTEM_DIR. Nothing was installed."; exit 1; }
trap 'rm -rf "$WORK"' EXIT
ZIP_FILE="$WORK/release.zip"
UNZIP_DIR="$WORK/tree"

echo "Downloading the repository..."
curl -fL -o "$ZIP_FILE" "$REPO_URL" \
  || { rm -f "$ZIP_FILE"; echo "Could not download v$VERSION from GitHub. Nothing was installed."; exit 1; }

echo ""
echo "Unzipping the repository..."
rm -rf "$UNZIP_DIR"
unzip -o -q "$ZIP_FILE" -d "$UNZIP_DIR"
echo "Removing the zip file..."
rm -f "$ZIP_FILE"

# Clean up existing directory and move new code into place
echo "Setting up the installation directory..."
# GitHub names the archive's top dir after the repo and ref, so resolve it
# rather than hardcoding it.
SRC_DIR=$(find "$UNZIP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n1)
[ -d "$SRC_DIR" ] || { echo "unexpected zip layout"; exit 1; }
# Checks the download against the digest releases.json publishes. A fresh
# install has no installed copy of the digest script, so the one from this
# download does the check: that catches corruption, not tampering. The
# updater checks with the installed copy instead.
if [ -z "$EXPECTED_DIGEST" ]; then
  echo "No published checksum for v$VERSION; installing without one"
elif [ ! -f "$SRC_DIR/scripts/tree_digest.py" ]; then
  echo "v$VERSION was released before checksum checks; installing without one"
else
  ACTUAL_DIGEST=$(python3 "$SRC_DIR/scripts/tree_digest.py" "$SRC_DIR") || ACTUAL_DIGEST=""
  if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
    rm -rf "$UNZIP_DIR"
    echo "The download of v$VERSION does not match its published checksum. Nothing was installed."
    exit 1
  fi
  echo "v$VERSION matches its published checksum"
fi
# Like the updater, refuses a tree whose own version is not the one chosen.
STAGED_VERSION=$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$SRC_DIR/server/src/serverInfo.json" 2>/dev/null) \
  || { rm -rf "$UNZIP_DIR"; echo "staged tree has no readable serverInfo.json"; exit 1; }
if [ "$STAGED_VERSION" != "$VERSION" ]; then
  rm -rf "$UNZIP_DIR"
  echo "staged tree reports v$STAGED_VERSION but releases.json lists v$VERSION; refusing a mislabeled release"
  exit 1
fi
# Copied for root while only root has touched the download. Root runs this
# copy from here on, never the tree the server user will own.
COPY=$(python3 -B "$SRC_DIR/scripts/system_scripts.py" publish "$SRC_DIR") \
  || { rm -rf "$UNZIP_DIR"; echo "Could not copy the scripts root runs. Nothing was installed."; exit 1; }
# Report legacy firewall jobs without editing the root crontab.
if [ -f "$COPY/scripts/migrate/fork-artifacts.sh" ]; then
  bash "$COPY/scripts/migrate/fork-artifacts.sh" warn-cron || true
elif command -v crontab >/dev/null 2>&1; then
  # Older release trees do not carry the inspection helper.
  LEGACY_CRON=$(crontab -u root -l 2>/dev/null | awk '
    $0 !~ /^[[:space:]]*#/ && ($0 ~ /sync-time-with-internet[.]sh/ || $0 ~ /\/home\/dac\/free-sleep\/scripts\/unblock_internet_access[.]sh/) { print }
  ' || true)
  [ -z "$LEGACY_CRON" ] || echo "WARNING: root cron contains legacy jobs that open the firewall. Review them with crontab -u root -e. No cron entries were changed.
$LEGACY_CRON"
fi

# Stop both database writers before replacing any files. Missing units are
# normal on a first install; a failed stop for an existing unit is fatal.
# Restart services on any refusal after stopping writers, including set -e exits.
STOPPED_SERVICES=()
# Set while the previous install waits at PREV_DIR, until the new server
# passes its health check.
RESTORE_PREVIOUS=no
# The reinstall's health check keeps the server's answers here.
HBODY=
# Stops a service that writes the data and confirms it is not running. Kept
# identical in the update, rollback, switch, reset and install scripts.
# systemd refuses to stop a unit that is not installed or does not load, even
# one that is not running, so the unit's state decides, not the stop.
stop_writer() {
  systemctl stop "$1" 2>/dev/null
  case "$(systemctl is-active "$1" 2>/dev/null)" in
    inactive|failed|unknown) return 0 ;;
  esac
  return 1
}
restart_on_failure() {
  result=$?
  # Output can fail here, as when a dropped SSH session hung up the run, and
  # must not stop the recovery.
  set +e
  trap '' HUP INT TERM PIPE
  # Without PREV_DIR the previous install never left REPO_DIR.
  if [ "$result" -ne 0 ] && [ "$RESTORE_PREVIOUS" = yes ] && [ -d "$PREV_DIR" ]; then
    # The new install may have started the stream already. Nothing moves
    # under a writer that will not stop.
    if ! stop_writer free-sleep || ! stop_writer free-sleep-stream; then
      echo "WARNING: the previous install could not be put back. It is in $PREV_DIR."
    else
      rm -rf "$FAILED_DIR"
      if { [ ! -d "$REPO_DIR" ] || mv "$REPO_DIR" "$FAILED_DIR"; } && mv "$PREV_DIR" "$REPO_DIR"; then
        echo "The install did not finish, so the previous install was put back. The new files are in $FAILED_DIR."
      else
        echo "WARNING: the previous install could not be put back. It is in $PREV_DIR."
      fi
    fi
  fi
  if [ "$result" -ne 0 ] && [ "${#STOPPED_SERVICES[@]}" -gt 0 ]; then
    for stopped_service in "${STOPPED_SERVICES[@]}"; do
      systemctl start "$stopped_service" || true
    done
  fi
  [ -z "$HBODY" ] || rm -f "$HBODY"
  rm -rf "$WORK"
}
trap restart_on_failure EXIT
# Without these, an interrupted run reaches the trap above with status 0.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
biometrics_enabled="false"
if systemctl is-active --quiet free-sleep-stream; then
  biometrics_enabled="true"
fi
for service in free-sleep free-sleep-stream; do
  if systemctl cat "$service" >/dev/null 2>&1; then
    if [ "$service" = free-sleep ] || [ "$biometrics_enabled" = true ]; then
      STOPPED_SERVICES+=("$service")
    fi
    systemctl stop "$service"
  fi
done
SRC="/persistent/free-sleep-data/free-sleep.db"
if [ -f "$SRC" ]; then
  python3 "$COPY/scripts/sqlite-safety.py" checkpoint "$SRC"
  mkdir -p /persistent/free-sleep-database-backups
  DEST="/persistent/free-sleep-database-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$-install.db"
  python3 "$COPY/scripts/sqlite-safety.py" backup "$SRC" "$DEST"
  echo "Database backup saved to $DEST"
  bash "$COPY/scripts/prune_db_snapshots.sh" /persistent/free-sleep-database-backups "$DEST" || true
fi
# The previous install is kept until the new server passes its health check,
# and becomes the rollback slot after that.
rm -rf "$PREV_DIR"
if [ -d "$REPO_DIR" ]; then
  RESTORE_PREVIOUS=yes
  mv "$REPO_DIR" "$PREV_DIR"
fi
mv "$SRC_DIR" "$REPO_DIR"
rm -rf "$UNZIP_DIR"
rmdir "$(dirname "$UNZIP_DIR")" 2>/dev/null || true

chown -R "$USERNAME":"$USERNAME" "$REPO_DIR"
bash "$COPY/scripts/record_stock.sh" units || true

# --------------------------------------------------------------------------------
# Install or update Volta + Node (shared with the fork-switch tool's
# pod-installer.sh, see scripts/ensure-node.sh)
bash "$COPY/scripts/ensure-node.sh" "$USERNAME"

# --------------------------------------------------------------------------------
# Setup /persistent/free-sleep-data (migrate old configs, logs, etc.)
mkdir -p /persistent/free-sleep-data/logs/
mkdir -p /persistent/free-sleep-data/lowdb/

SRC_FILE="/opt/eight/bin/frank.sh"
DEST_FILE="/persistent/free-sleep-data/dac_sock_path.txt"

if [ -f "$DEST_FILE" ]; then
  echo "Destination file $DEST_FILE already exists, skipping copy."
else
  if [ -r "$SRC_FILE" ]; then
    echo "Found $SRC_FILE, searching for dac.sock path..."
    result=$(grep -oP '(?<=DAC_SOCKET=)[^ ]*dac\.sock' "$SRC_FILE" || true)
    if [ -n "$result" ]; then
      echo "$result" > "$DEST_FILE"
      echo "DAC socket path saved to $DEST_FILE"
    else
      echo "No dac.sock path found in $SRC_FILE, skipping write."
    fi
  else
    echo "File $SRC_FILE not found or not readable, skipping."
  fi
fi


# DO NOT REMOVE, OLD VERSIONS WILL LOSE settings & schedules
FILES_TO_MOVE=(
  "/home/dac/free-sleep-database/settingsDB.json:/persistent/free-sleep-data/lowdb/settingsDB.json"
  "/home/dac/free-sleep-database/schedulesDB.json:/persistent/free-sleep-data/lowdb/schedulesDB.json"
  "/home/dac/dac_sock_path.txt:/persistent/free-sleep-data/dac_sock_path.txt"
)

for entry in "${FILES_TO_MOVE[@]}"; do
  IFS=":" read -r SOURCE_FILE DESTINATION <<< "$entry"
  if [ -f "$SOURCE_FILE" ]; then
    mv "$SOURCE_FILE" "$DESTINATION"
    echo "Moved $SOURCE_FILE to $DESTINATION"
  fi
done

# Save the update channel: on a fresh install, when the settings carried over
# have none, or when NIGHTSTAND_CHANNEL was given. Otherwise an owner's
# earlier choice stands. Runs after old settings are moved into place, so
# that move cannot overwrite it.
python3 -I - /persistent/free-sleep-data/lowdb/settingsDB.json "$CHANNEL" "${NIGHTSTAND_CHANNEL:+given}" <<'PY' \
  || echo "WARNING: could not save the update channel"
import json, os, sys
path, channel, given = sys.argv[1], sys.argv[2], sys.argv[3] == "given"
tmp = path + ".tmp"
try:
    data = {}
    if os.path.exists(path):
        with open(path) as handle:
            data = json.load(handle)
        if "updateChannel" in data and not given:
            sys.exit(0)
    data["updateChannel"] = channel
    with open(tmp, "w") as handle:
        json.dump(data, handle, indent=2)
    if os.path.exists(path):
        info = os.stat(path)
        os.chown(tmp, info.st_uid, info.st_gid)
        os.chmod(tmp, info.st_mode & 0o7777)
    os.replace(tmp, path)
except Exception:
    if os.path.exists(tmp):
        os.remove(tmp)
    sys.exit(1)
PY

if [ -d /persistent/deviceinfo/ ]; then
  chown -R "$USERNAME":"$USERNAME" /persistent/deviceinfo/
fi

if [ -d /deviceinfo/ ]; then
  chown -R "$USERNAME":"$USERNAME" /deviceinfo/
fi

# Change ownership and permissions
chown -R "$USERNAME":"$USERNAME" /persistent/free-sleep-data/
chmod 770 /persistent/free-sleep-data/
chmod g+s /persistent/free-sleep-data/

# --------------------------------------------------------------------------------
# Install server dependencies

BACKUP_PATH="/home/dac/free-sleep-backup/server/package-lock.json"
NEW_PATH="/home/dac/free-sleep/server/package-lock.json"
NODE_MODULES_BACKUP="/home/dac/free-sleep-backup/server/node_modules"
NODE_MODULES_NEW="/home/dac/free-sleep/server/node_modules"

echo "Reviewing npm dependencies for changes..."
if [ -f "$BACKUP_PATH" ] && [ -f "$NEW_PATH" ]; then
  BACKUP_HASH=$(sha256sum "$BACKUP_PATH" | awk '{print $1}')
  NEW_HASH=$(sha256sum "$NEW_PATH" | awk '{print $1}')

  echo "Backup hash: $BACKUP_HASH"
  echo "New hash: $NEW_HASH"

  if [ "$BACKUP_HASH" != "$NEW_HASH" ]; then
    echo "package-lock.json changed, running npm install..."
    sudo -u "$USERNAME" bash -c "cd '$SERVER_DIR' && /home/$USERNAME/.volta/bin/npm install"
  else
    echo "package-lock.json unchanged, restoring node_modules from backup..."
    if [ -d "$NODE_MODULES_BACKUP" ]; then
      mv "$NODE_MODULES_BACKUP" "$NODE_MODULES_NEW"
      chown -R "$USERNAME:$USERNAME" "$NODE_MODULES_NEW" || true
      echo "node_modules restored from backup."
    else
      echo "Backup node_modules not found, running npm install instead..."
      sudo -u "$USERNAME" bash -c "cd '$SERVER_DIR' && /home/$USERNAME/.volta/bin/npm install"
    fi
  fi
else
  echo "One or both package-lock.json files missing, running npm install..."
  sudo -u "$USERNAME" bash -c "cd '$SERVER_DIR' && /home/$USERNAME/.volta/bin/npm install"
fi
echo ""

# --------------------------------------------------------------------------------
# Run Prisma migrations


# The database and its WAL were checkpointed and backed up before the swap.

# migrate deploy only applies the migrations in this tree; generate refreshes
# the client, since node_modules may have been carried over from before. A
# failure stops the install, which puts the previous install back.
echo "Running Prisma migrations..."
NPX="/home/$USERNAME/.volta/bin/npx"
if sudo -u "$USERNAME" bash -c "cd '$SERVER_DIR' && '$NPX' dotenv -e .env.pod -- npx prisma migrate deploy && '$NPX' dotenv -e .env.pod -- npx prisma generate"; then
  echo "Prisma migrations completed successfully."
else
  echo -e "\033[33mERROR: Prisma migrations failed! A backup of your database prior to the migration was saved to ${DEST:-/persistent/free-sleep-database-backups} \033[0m"
  exit 1
fi


# Restart free-sleep-stream if it was running before
if [ "$biometrics_enabled" = "true" ]; then
  echo "Restarting free-sleep-stream service..."
  systemctl restart free-sleep-stream
fi

echo ""

# --------------------------------------------------------------------------------
# Create systemd service

SERVICE_FILE="/etc/systemd/system/free-sleep.service"

echo "Creating systemd service file at $SERVICE_FILE..."

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Nightstand Server
After=network.target

[Service]
ExecStart=/home/$USERNAME/.volta/bin/npm run start
WorkingDirectory=$SERVER_DIR
Restart=always
User=$USERNAME
Environment=NODE_ENV=production
Environment=VOLTA_HOME=/home/$USERNAME/.volta
Environment=PATH=/home/$USERNAME/.volta/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

[Install]
WantedBy=multi-user.target
EOF

echo "Reloading systemd daemon and enabling the service..."
systemctl daemon-reload
systemctl enable free-sleep.service
bash "$COPY/scripts/setup_resource_limits.sh" || echo "WARNING: failed to install service memory limits"

say() { echo "$*"; }
# Waits up to 90 s for the server to answer as version $1, and with a sensor
# reading when $2 is "temperature", keeping each answer in $HBODY. Any other
# $2 returns 2. Kept identical in update.sh and install.sh.
serves_version() {
  local code body ok
  case "${2:-}" in ""|temperature) ;; *) return 2 ;; esac
  for _ in $(seq 1 30); do
    sleep 3
    # Log every attempt's HTTP status so a failed log shows the shape of the
    # failure on its own (000 = no/aborted response, 503 = still starting).
    code=$(curl -s -o "$HBODY" -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/api/deviceStatus" 2>/dev/null || echo 000)
    say "  health attempt: HTTP $code"
    [ "$code" = 200 ] || continue
    body=$(cat "$HBODY" 2>/dev/null) || continue
    ok=$(printf '%s' "$body" | python3 -I -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert d['freeSleep']['version'] == '$1'
    if '${2:-}' == 'temperature':
        assert isinstance(d['left']['currentTemperatureF'], (int, float))
    print('yes')
except Exception:
    print('no')" 2>/dev/null)
    if [ "$ok" = yes ]; then
      systemctl is-active free-sleep >/dev/null
      return
    fi
  done
  return 1
}

echo "Starting free-sleep.service..."
systemctl start free-sleep.service
# A first install has nothing to go back to, so only a reinstall waits.
if [ "$RESTORE_PREVIOUS" = yes ]; then
  echo "Health check (up to 90s)"
  HBODY=$(mktemp)
  HEALTHY=no
  # As in the fork switch: a reinstall is a cold connect, and a side's
  # temperature can read null for its first cycles.
  serves_version "$VERSION" && HEALTHY=yes
  rm -f "$HBODY"
  [ "$HEALTHY" = yes ] || { echo "The new version did not pass its health check."; exit 1; }
  RESTORE_PREVIOUS=no
fi

echo "Checking free-sleep service status..."
systemctl status free-sleep.service --no-pager || true
echo ""

# -----------------------------------------------------------------------------------------------------
# Install the RAW-archive retention timer
#
# Without this, frankenfirmware truncates piezo/capacitance RAW files after
# ~75 min, so calibration/analyze jobs asking for multi-hour windows find
# almost no data and crash (empty-dataframe IndexError). See
# server/README_SERVER.md for the mechanism. Idempotent: safe to re-run.

echo "Installing RAW-archive retention timer..."
cp "$COPY/scripts/systemd/free-sleep-archive-raw.service" /etc/systemd/system/
cp "$COPY/scripts/systemd/free-sleep-archive-raw.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now free-sleep-archive-raw.timer
echo ""

# -----------------------------------------------------------------------------------------------------
# Units and sudoers rules for updates, rollback, switching to upstream
# free-sleep, reboot, and biometrics controls (shared with update.sh and
# the migration installers)

echo "Installing the updater, rollback, and revert services and their sudoers rules..."
bash "$COPY/scripts/setup_services.sh" "$COPY" \
  || echo -e "\033[33mWARNING: some updater services or sudoers rules could not be installed; see above\033[0m"
echo ""

# --------------------------------------------------------------------------------
# Graceful device time update (optional)

echo "Attempting to update device time from Google..."
# If the curl fails or is blocked, skip with a warning but don't fail the entire script
# https so TLS at least authenticates the server we're asking for the time
if date_string="$(curl -s --head https://google.com | grep '^Date: ' | sed 's/Date: //g')" && [ -n "$date_string" ]; then
  date -s "$date_string" || echo "WARNING: Unable to update system time"
else
  echo -e "\033[0;33mWARNING: Unable to retrieve date from Google... Skipping time update.\033[0m"
fi

echo ""

# Optional on older releases, which do not ship this check.
if [ -f "$COPY/scripts/check_image_credentials.sh" ]; then
  bash "$COPY/scripts/check_image_credentials.sh" \
    || echo "WARNING: the prebuilt-image credential check could not finish; see INSTALLATION.md"
fi

# --------------------------------------------------------------------------------
# Finish
echo "This is your dac.sock path (if it doesn't end in dac.sock, contact support):"
cat /persistent/free-sleep-data/dac_sock_path.txt 2>/dev/null || echo "No dac.sock path found."

echo -e "\033[0;32mInstallation complete! The Nightstand server is running and will start automatically on boot.\033[0m"
echo -e "\033[0;32mSee logs with: journalctl -u free-sleep --no-pager --output=cat\033[0m"

# Last, since its first arming can reset the Pod.
if [ -f "$COPY/scripts/setup_watchdog.sh" ]; then
  bash "$COPY/scripts/setup_watchdog.sh" --auto || echo "WARNING: the hardware watchdog could not be turned on; see above"
fi
