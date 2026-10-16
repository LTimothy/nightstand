#!/bin/bash

# ---------------------------------------------
# Color helper functions
# ---------------------------------------------
print_red() {
  echo -e "\033[0;31m$1\033[0m"
}

print_yellow() {
  echo -e "\033[0;33m$1\033[0m"
}

print_green() {
  echo -e "\033[0;32m$1\033[0m"
}

print_grey() {
  local text="$1"
  echo -e "\033[0;90m${text}\033[0m"
}

echo "-----------------------------------------------------------------------------------------------------"
echo "DEBUG REPORT $(date '+%Y-%m-%d %H:%M:%S') UTC"

log_if_exists() {
  local file_path="$1"
  local label="$2"

  if [ -f "$file_path" ]; then
    local content
    content=$(cat "$file_path")
    printf "$label: $content\n"
  else
    printf "$label: Not found ($file_path)\n"
  fi
}

check_service_status() {
  local service_name="$1"

  if systemctl is-active --quiet "$service_name"; then
    print_green "  - $service_name is running ✅"
  else
    print_red "  - $service_name is NOT running ❌, showing last 20 log lines:"
    journalctl -u "$service_name" -n 20 --no-pager --output=cat \
      | sed 's/^/      /' \
      | while IFS= read -r line; do
          print_grey "$line"
        done
    echo ""
  fi
}

check_free_sleep_install() {
  local base_dir="/home/dac/free-sleep"
  local node_modules_dir="$base_dir/server/node_modules"

  if [ ! -d "$base_dir" ]; then
    print_red "  - $base_dir does not exist. ❌"
    return 1
  fi

  if [ ! -d "$node_modules_dir" ] || [ -z "$(ls -A "$node_modules_dir" 2>/dev/null)" ]; then
    print_red "  - Node modules missing in $node_modules_dir. ❌"
    return 1
  fi

  print_green "  - Nightstand installation looks valid. ✅"
}

print_json_if_exists() {
  local file_path="$1"
  local label="$2"

  if [ -f "$file_path" ]; then
    print_green "- $file_path"
    python3 -I -m json.tool "$file_path" \
      | sed 's/^/      /' \
      | sed $'s/^/\033[0;90m/' \
      | sed $'s/$/\033[0m/'
  else
    print_red "File not found: $file_path ❌"
  fi
}


check_local_server() {
  local base_url="http://localhost:3000"
  local device_status_url="$base_url/api/deviceStatus"
  local server_status_url="$base_url/api/serverStatus"

  # Try to reach the base URL with a short timeout
  if curl -fs --connect-timeout 3 "$base_url" > /dev/null 2>&1; then
    print_green "  - Server reachable at $base_url ✅"
    print_green "  - Fetching $device_status_url ..."
    # Print and indent JSON nicely if python3 is available
    if command -v python3 >/dev/null 2>&1; then
      curl -fs "$device_status_url" | python3 -I -m json.tool | sed 's/^/      /' | sed 's/^/\x1b[0;90m/' | sed 's/$/\x1b[0m/'
    else
      curl -fs "$device_status_url" | sed 's/^/      /' | sed 's/^/\x1b[0;90m/' | sed 's/$/\x1b[0m/'
    fi

    print_green "  - Fetching $server_status_url ..."
    # Print and indent JSON nicely if python3 is available
    if command -v python3 >/dev/null 2>&1; then
      curl -fs "$server_status_url" | python3 -I -m json.tool | sed 's/^/      /' | sed 's/^/\x1b[0;90m/' | sed 's/$/\x1b[0m/'
    else
      curl -fs "$server_status_url" | sed 's/^/      /' | sed 's/^/\x1b[0;90m/' | sed 's/$/\x1b[0m/'
    fi
  else
    print_red "  - Server not reachable at $base_url ❌"
  fi
}


tail_if_exists() {
  local file_path="$1"
  local label="$2"

  if [ -f "$file_path" ]; then
    local content
    content=$(cat "$file_path")
    printf "$label: $content"
  else
    printf "$label: Not found ($file_path)"
  fi
}


log_if_exists "/etc/rat_version" "OS Version"
free -h | awk '/Mem:/ {printf "Memory: %s, Available: %s\n", $2, $7}'
df -h | sed $'s/^/\033[0;90m/' | sed $'s/$/\033[0m/'
echo ""
print_grey "Time & Date"
timedatectl 2>&1 | while IFS= read -r line; do
  print_grey "      $line"
done

echo ""
print_grey "DNS info - /etc/resolv.conf"
if [ -f /etc/resolv.conf ]; then
  while IFS= read -r line; do
    print_grey "      $line"
  done < /etc/resolv.conf
else
  print_grey "      (file not found)"
fi

printf "\n\nSystem Services\n"

check_service_status "free-sleep"
check_service_status "free-sleep-stream"
check_service_status "capybara"
check_service_status "frank"
check_service_status "systemd-timesyncd"

printf "\n\nNightstand Status\n"
print_json_if_exists "/home/dac/free-sleep/server/src/serverInfo.json" "Server info"
check_free_sleep_install
check_local_server

echo "--------------------------------------------- END REPORT ---------------------------------------------"

