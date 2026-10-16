#!/bin/bash

PROFILE_FILE_PATH="/home/root/.profile"

# Ensure .profile exists
if [ ! -f "$PROFILE_FILE_PATH" ]; then
  echo "# ~/.profile created by free-sleep installer" > "$PROFILE_FILE_PATH"
fi

SHORTCUTS=(
  "alias fs-debug='bash /usr/local/lib/nightstand/live/scripts/debug.sh'"
  "alias fs-restart='bash /usr/local/lib/nightstand/live/scripts/restart.sh'"
  "alias fs-reset='bash /usr/local/lib/nightstand/live/scripts/reset.sh'"
  "alias fs-reset-db='bash /usr/local/lib/nightstand/live/scripts/reset_db.sh'"
  "alias fs-update='bash /usr/local/lib/nightstand/live/scripts/update.sh'"
  "alias fs-dev-server='systemctl stop free-sleep && su - dac -c \"cd /home/dac/free-sleep/server && /home/dac/.volta/bin/npm run dev\"'"
)

echo "Adding shortcuts to $PROFILE_FILE_PATH..."

for shortcut in "${SHORTCUTS[@]}"; do
  name=$(echo "$shortcut" | cut -d'=' -f1 | awk '{print $2}')
  # Replace an older definition, so a changed command reaches existing installs.
  if grep -q "^alias $name=" "$PROFILE_FILE_PATH" 2>/dev/null; then
    sed -i "/^alias $name=/d" "$PROFILE_FILE_PATH"
    echo "  - Updated shortcut: $name"
  else
    echo "  - Added shortcut: $name"
  fi
  echo "$shortcut" >> "$PROFILE_FILE_PATH"
done

echo ""
