#!/bin/bash
# Check for credentials reported in a prebuilt free-sleep SD image.
set -euo pipefail

confirm() {
  # Piped input must never authorize a credential or network change.
  [ -t 0 ] && [ -t 1 ] || return 1
  local answer
  printf '%s [y/N] ' "$1"
  IFS= read -r answer || return 1
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

is_image_profile() {
  [ -f "$1" ] || return 1
  python3 - "$1" <<'PY'
import configparser
import sys
profile = configparser.ConfigParser(interpolation=None)
try:
    with open(sys.argv[1]) as handle:
        profile.read_file(handle)
    matches = (profile.get('connection', 'id', fallback='') == 'EyePhone'
               and profile.get('connection', 'type', fallback='') in ('wifi', '802-11-wireless')
               and (profile.get('wifi', 'ssid', fallback='') == 'EyePhone'
                    or profile.get('802-11-wireless', 'ssid', fallback='') == 'EyePhone'))
except (OSError, configparser.Error):
    matches = False
sys.exit(0 if matches else 1)
PY
}

has_shared_password() {
  python3 - "$1" <<'PY'
import sys
try:
    with open('/etc/shadow') as handle:
        matches = any(fields[0] == sys.argv[1] and len(fields) > 1
                      and fields[1].lstrip('!').startswith('$6$TuDO46rILr$')
                      for fields in (line.rstrip('\n').split(':') for line in handle))
except OSError:
    matches = False
sys.exit(0 if matches else 1)
PY
}

for profile in /etc/NetworkManager/system-connections/EyePhone.nmconnection \
               /persistent/system-connections/EyePhone.nmconnection; do
  if is_image_profile "$profile"; then
    echo "WARNING: found a possibly inherited EyePhone Wi-Fi profile at $profile. The name and SSID match a prebuilt-image profile, but this check does not compare its key or autoconnect setting."
    if confirm "Remove this possibly inherited EyePhone profile? Make sure your own Wi-Fi is configured first."; then
      if rm -- "$profile"; then
        nmcli connection reload || echo "WARNING: could not reload Wi-Fi profiles; reload them before the next connection"
      else
        echo "WARNING: could not remove the EyePhone profile"
      fi
    else
      echo "EyePhone profile kept. To review this check interactively, run bash /usr/local/lib/nightstand/live/scripts/check_image_credentials.sh"
    fi
  fi
done

if [ ! -r /etc/shadow ]; then
  echo "WARNING: could not read /etc/shadow to check prebuilt-image passwords; run this check as root"
else
  for account in root rewt; do
    if has_shared_password "$account"; then
      echo "WARNING: $account has the password salt reported in a shared prebuilt image. Choose a new password for this account."
      if confirm "Set a new $account password now?"; then
        passwd "$account" || echo "WARNING: could not change the $account password; run passwd $account to try again"
      else
        echo "Password kept. Run passwd $account to choose a new one."
      fi
    fi
  done
fi
