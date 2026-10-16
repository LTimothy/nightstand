#!/bin/bash

SERVICES_DB=/persistent/free-sleep-data/lowdb/servicesDB.json

# The app's Biometrics switch, which enables and starts or stops and disables
# the stream. A restart follows it, so the stream is not back at boot either.
biometrics_on() {
  python3 -I -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1]))["biometrics"]["enabled"] is True else 1)' "$SERVICES_DB" 2>/dev/null
}
installed() { systemctl list-unit-files | grep -q "^$1.service"; }

echo "Stopping free sleep..."
for svc in free-sleep free-sleep-stream; do
  if installed "$svc"; then
    systemctl stop "$svc"
  fi
done

sleep 3
echo "Starting free sleep"
if installed free-sleep; then
  systemctl enable free-sleep
  systemctl start free-sleep
fi
if installed free-sleep-stream; then
  if biometrics_on; then
    systemctl enable free-sleep-stream
    systemctl start free-sleep-stream
  else
    systemctl disable free-sleep-stream
    echo "Biometrics is off in the app, so the biometrics stream stays stopped and disabled."
  fi
fi
