#!/bin/bash
#
# Bound Nightstand's own services so they cannot starve the pod's firmware.
#
# The pod has about 1.9 GB of RAM, no swap, and earlyoom. The Eight Sleep
# firmware that runs heating and cooling shares that memory with the server,
# the sleep analysis and calibration jobs the server starts, and the
# biometrics stream. If one of ours runs away, the process that dies should
# be ours, not the firmware.
#
# OOMScoreAdjust makes the kernel and earlyoom prefer our processes as the
# victim, and the analysis jobs inherit it from the server. MemoryMax caps
# each service's cgroup where the kernel supports it; the caps sit well
# above normal use (about 190 MB for the server, 135 MB for the stream), so
# they only matter to a runaway. systemd ignores a setting it cannot apply
# rather than failing the unit.
#
# Run as root. Safe to re-run. Limits apply the next time each service starts.
#
# The server also gets a restart drop-in: restart five seconds after any
# exit and never give up. systemd's default start limit (five starts in ten
# seconds) would otherwise leave a crash-looping server stopped until the
# next reboot, and schedules and alarms run in it. StartLimitIntervalSec is
# the spelling for systemd 230 and newer, and goes under [Unit]. The older
# StartLimitInterval under [Service] covers systemd before 230, which would
# ignore the new name; newer systemd still accepts it as an alias with the
# same value.
#
# On systemd 254 and newer the wait after each automatic restart grows from
# 5 s to 60 s, so a server that keeps crashing restarts about once a minute
# instead of filling the journal every few seconds. Manual starts are never
# delayed. systemd counts automatic restarts until a manual start, so a
# server that crashed often since its last update waits up to 60 s.
#
# To undo: rm the three drop-ins below, then systemctl daemon-reload.

set -euo pipefail

SYSTEMD_DIR="${NIGHTSTAND_SYSTEMD_DIR:-/etc/systemd/system}"

write_dropin() {
  local unit="$1" memory_max="$2"
  local dir="${SYSTEMD_DIR}/${unit}.d"
  mkdir -p "$dir"
  cat > "${dir}/10-nightstand-limits.conf" <<EOF
# Managed by scripts/setup_resource_limits.sh. See that script for why.
[Service]
MemoryAccounting=yes
MemoryMax=${memory_max}
OOMScoreAdjust=300
EOF
}

write_dropin free-sleep.service 1200M
write_dropin free-sleep-stream.service 512M

SYSTEMD_VERSION=$(systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p' || true)
BACKOFF=
if [ -n "$SYSTEMD_VERSION" ] && [ "$SYSTEMD_VERSION" -ge 254 ]; then
  BACKOFF=$'\nRestartSteps=4\nRestartMaxDelaySec=60'
fi

cat > "${SYSTEMD_DIR}/free-sleep.service.d/20-nightstand-restart.conf" <<EOF
# Managed by scripts/setup_resource_limits.sh. See that script for why.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
StartLimitInterval=0${BACKOFF}
EOF

systemctl daemon-reload
