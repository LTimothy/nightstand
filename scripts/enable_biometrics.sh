#!/bin/bash
# Started as "sh enable_biometrics.sh" too; the rest needs bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
SCRIPTS=/usr/local/lib/nightstand/live/scripts

python3 "$SCRIPTS/is_biometrics_installed.py"
result=$?

# The live stream uses an installed nats-py first, else the copy bundled in
# biometrics/vendor, so nothing is downloaded for it.
check_nats_python_package() {
  if [ ! -x /home/dac/venv/bin/python ]; then
    echo "Python venv not found; full biometrics installation will create it."
    return 0
  fi

  if /home/dac/venv/bin/python -I -c 'import sys; sys.path.append(sys.argv[1]); import vendored, nats' \
    /home/dac/free-sleep/biometrics >/dev/null 2>&1; then
    echo "nats-py is available."
  else
    echo "WARNING: nats-py does not import; the live stream reads the RAW files instead."
  fi
}

if [ $result -eq 0 ]; then
  echo "Biometrics environment not setup, continuing with installation..."
elif [ $result -eq 1 ]; then
  echo "Biometrics environment setup already, enabling service..."
  check_nats_python_package
  systemctl enable free-sleep-stream.service
  systemctl restart free-sleep-stream.service
  # The installation status goes first, on its own, so it is kept even if the
  # server cannot turn the switch on.
  curl -s -X POST http://127.0.0.1:3000/api/services \
    -H "Content-Type: application/json" \
    -d '{
      "biometrics": {
        "jobs": {
          "installation": {
            "status": "healthy",
            "message": ""
          }
        }
      }
    }'
  curl -sf -X POST http://127.0.0.1:3000/api/services \
    -H "Content-Type: application/json" \
    -d '{"biometrics": {"enabled": true}}' >/dev/null \
    || echo "Biometrics is installed. Turn it on in Settings > Features."
  exit 0
else
  echo "Unable to check if biometrics installed, exiting..."
  exit 1
fi


set -e  # Exit immediately if any command fails
set -o pipefail  # Catch errors in piped commands
set -u  # Treat unset variables as errors

RED='\033[0;31m'
NC='\033[0m' # No Color

WAN_OPEN=no
say() { echo "$*"; }
source "$SCRIPTS/restore_helpers.sh"
if ! take_operation_lock; then
  echo "An update, rollback, switch or install is running. Run this again when it has finished."
  exit 1
fi
init_update_firewall

# Catch any errors
trap '
  rc=$?;
  set +e
  if [ "$rc" -ne 0 ]; then
    echo ""
    echo -e "${RED}Error enabling biometrics!${NC}"
    echo -e "${RED}Command that failed: $BASH_COMMAND - Exit code $rc ${NC}"
    echo ""
    curl -s -X POST http://127.0.0.1:3000/api/services \
      -H "Content-Type: application/json" \
      -d "{
        \"biometrics\": {
          \"jobs\": {
            \"installation\": {
              \"status\": \"failed\"
            }
          }
        }
      }"
  fi
  close_wan
  exit $rc
' EXIT

# Only HTTPS and DNS go out, and only while Python and its packages download.
open_wan || true
run_limited 900 bash "$SCRIPTS/setup_python.sh" || exit 1
run_limited 900 bash "$SCRIPTS/install_python_packages.sh" || exit 1
close_wan || true
bash "$SCRIPTS/setup_streamer_service.sh"

# Mark the installation status as healthy
curl -X POST http://127.0.0.1:3000/api/services \
  -H "Content-Type: application/json" \
  -d '{
    "biometrics": {
      "jobs": {
        "installation": {
          "status": "healthy"
        }
      }
    }
  }'

cd /home/dac/free-sleep/biometrics/sleep_detection && /home/dac/venv/bin/python calibrate_sensor_thresholds.py


# Installed: turn Biometrics on in the app too. The server enables and starts
# the stream, which is already running, and only then saves the switch.
curl -sf -X POST http://127.0.0.1:3000/api/services \
  -H "Content-Type: application/json" \
  -d '{"biometrics": {"enabled": true}}' >/dev/null \
  || echo "Biometrics is installed. Turn it on in Settings > Features."
