#!/bin/bash
# Installs the systemd units and sudoers rules for updates, rollback,
# switching to upstream free-sleep, reboot, and biometrics controls.
# Shared by install.sh, update.sh, and the fork-switch and agent installers
# so every install path sets up the same controls. Idempotent.
#
# Usage: setup_services.sh COPY [--recovery-only]   (run as root)
# COPY is a root-owned copy under /usr/local/lib/nightstand/copies, or that
# folder's live link; see system_scripts.py.
# Exits non-zero if any piece could not be installed; callers treat that as a
# warning, since a pod without these still controls the bed.
#
# The rollback and revert units are on-demand oneshots. This only installs
# them; starting either one runs the action. The health and network watchdog
# timers are the units this starts. The boot recovery timer is enabled without starting it.
set -u

GIVEN="${1:-}"
USERNAME=dac
SYSTEMD_DIR="${NIGHTSTAND_SYSTEMD_DIR:-/etc/systemd/system}"
SUDOERS_FILE="${NIGHTSTAND_SUDOERS_FILE:-/etc/sudoers.d/$USERNAME}"
TMPFILES_DIR="${NIGHTSTAND_TMPFILES_DIR:-/etc/tmpfiles.d}"
STATUS=0
SYSTEM_DIR="${NIGHTSTAND_SYSTEM_DIR:-/usr/local/lib/nightstand}"
TOOL="$(dirname "${BASH_SOURCE[0]}")/system_scripts.py"
RECOVERY_DIR="${NIGHTSTAND_RECOVERY_DIR:-$SYSTEM_DIR/recovery}"

warn() { echo "WARNING: $*"; STATUS=1; }

# Root runs only root-owned copies, never an install tree.
COPY=$(cd "$GIVEN" 2>/dev/null && pwd -P) || COPY=
COPIES=$(cd "$SYSTEM_DIR/copies" 2>/dev/null && pwd -P) || COPIES=
NAME=$(basename "$COPY")
if [ -z "$COPIES" ] || [ "$(dirname "$COPY")" != "$COPIES" ] || [ "${#NAME}" != 64 ] \
  || [ -n "${NAME//[0-9a-f]/}" ] || [ ! -d "$COPY/scripts" ]; then
  echo "WARNING: $GIVEN is not a root-owned copy in $SYSTEM_DIR/copies; nothing installed"
  exit 1
fi

SWAP_MARKER="${NIGHTSTAND_SWAP_MARKER:-/persistent/free-sleep-data/update-swap.json}"

# Armed recovery files remain unchanged until the swap is settled.
if [ -f "$SWAP_MARKER" ]; then
  for file in "$RECOVERY_DIR/recover_update.sh" "$RECOVERY_DIR/restore_helpers.sh" \
    "$SYSTEMD_DIR/free-sleep-recover-update.service" "$SYSTEMD_DIR/free-sleep-recover-update.timer"; do
    [ -s "$file" ] || warn "armed recovery file is missing: $file"
  done
elif [ -f "$COPY/scripts/recover_update.sh" ]; then
  if python3 -I - "$COPY" "$RECOVERY_DIR" "$SYSTEMD_DIR" <<'PYRECOVERY'
import os, sys, tempfile
repo, recovery, systemd = sys.argv[1:]
os.makedirs(recovery, exist_ok=True)
files = [("recover_update.sh", recovery, 0o755), ("restore_helpers.sh", recovery, 0o644),
         ("write_result.py", recovery, 0o644),
         ("system_scripts.py", recovery, 0o644), ("block_internet_access.sh", recovery, 0o755),
         ("systemd/free-sleep-recover-update.service", systemd, 0o644),
         ("systemd/free-sleep-recover-update.timer", systemd, 0o644)]
for source, directory, mode in files:
    with open(repo + "/scripts/" + source) as handle:
        content = handle.read().replace("/usr/local/lib/nightstand/recovery", recovery)
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".recovery-")
    try:
        with os.fdopen(descriptor, "w") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, directory + "/" + os.path.basename(source))
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
PYRECOVERY
  then
    systemctl disable free-sleep-recover-update.service >/dev/null 2>&1 || true
    systemctl daemon-reload || warn "could not reload the recovery unit"
    systemctl enable free-sleep-recover-update.timer || warn "could not enable boot recovery"
  else
    warn "could not install boot recovery"
  fi
elif [ "${2:-}" = --recovery-only ]; then
  warn "the updater has no recovery script"
fi
SWITCH_RECOVERY_DIR="${NIGHTSTAND_SWITCH_RECOVERY_DIR:-$SYSTEM_DIR/switch-recovery}"
if [ -n "${NIGHTSTAND_RECOVERY_DIR:-}" ] && [ -z "${NIGHTSTAND_SWITCH_RECOVERY_DIR:-}" ]; then
  SWITCH_RECOVERY_DIR="$RECOVERY_DIR-switch"
fi
TRANSACTION_ROOT="${NIGHTSTAND_TRANSACTION_ROOT:-/persistent/free-sleep-maintenance/nightstand-transactions}"
if [ -f "$COPY/scripts/recover_switch.sh" ] && [ ! -f "$SWAP_MARKER" ]; then
  if python3 -I - "$COPY" "$SWITCH_RECOVERY_DIR" "$SYSTEMD_DIR" "$TRANSACTION_ROOT" <<'PYSWITCHRECOVERY'
import os, shlex, sys, time
from pathlib import Path
repo, recovery, systemd, root = sys.argv[1:]
sys.path.insert(0, repo + '/scripts')
from switch_transaction import publish, durable_directory, TransactionStore
from recover_switch import journals, TERMINAL, WRITERS, OPERATIONS
files = [(name, Path(recovery) / name, 0o755 if name.endswith('.sh') else 0o644)
         for name in ('recover_switch.sh', 'recover_switch.py', 'switch_transaction.py', 'switch_services.py', 'restore_helpers.sh',
                      'system_scripts.py')]
files.append(('systemd/free-sleep-recover-switch.service', Path(systemd) / 'free-sleep-recover-switch.service', 0o644))
gates = [(Path(systemd) / (unit + '.d') / 'nightstand-switch-recovery.conf')
         for unit in WRITERS + OPERATIONS]
try:
    armed = any(journal['phase'] not in TERMINAL for journal in journals(TransactionStore(root)))
except ValueError:
    # A corrupt or incomplete journal also pins the installed recovery code.
    armed = True
if armed:
    for path in [item[1] for item in files] + gates:
        if not path.is_file() or not path.stat().st_size:
            sys.exit('Armed switch recovery file is missing: ' + str(path))
else:
    for source, destination, mode in files:
        durable_directory(destination.parent)
        content = ((Path(repo) / 'scripts' / source).read_text()
                   .replace('/usr/local/lib/nightstand/switch-recovery', recovery)
                   .replace('/persistent/free-sleep-maintenance/nightstand-transactions', root))
        stamp = time.time_ns()
        metadata = dict(uid=os.geteuid(), gid=os.getegid(), mode=mode, atimeNs=stamp, mtimeNs=stamp)
        publish(destination, content.encode(), metadata)
    for path in gates:
        durable_directory(path.parent)
        stamp = time.time_ns()
        metadata = dict(uid=os.geteuid(), gid=os.getegid(), mode=0o644, atimeNs=stamp, mtimeNs=stamp)
        unit = path.parent.name[:-2]
        # A broken helper may block only a known transaction, never ordinary startup.
        check = ('for journal in ' + shlex.quote(root) + '/*/journal.json; do '
                 'if [ -e "$journal" ] || [ -L "$journal" ]; then exec /bin/bash '
                 + shlex.quote(recovery + '/recover_switch.sh') + ' --startup-check ' + unit
                 + '; fi; done; exit 0')
        check = check.replace('$', '$$').replace('%', '%%')
        argument = '"' + check.replace('\\', '\\\\').replace('"', '\\"') + '"'
        content = ('[Unit]\nWants=free-sleep-recover-switch.service\nAfter=free-sleep-recover-switch.service\n'
                   '[Service]\nExecStartPre=+/bin/bash -c ' + argument + '\n')
        publish(path, content.encode(), metadata)
PYSWITCHRECOVERY
  then
    systemctl daemon-reload || warn "could not reload switch recovery"
    systemctl enable free-sleep-recover-switch.service || warn "could not enable switch recovery"
  else
    warn "could not install switch recovery and startup gates"
  fi
fi
if [ "${2:-}" = --recovery-only ]; then
  exit "$STATUS"
fi

python3 -B "$TOOL" point "$COPY" || warn "root still runs the scripts it ran before; the next update retries"
python3 -B "$TOOL" prune || warn "could not remove old copies of the scripts"
if [ -f "$COPY/scripts/add_shortcuts.sh" ]; then
  bash "$COPY/scripts/add_shortcuts.sh" >/dev/null 2>&1 || warn "could not update the fs-* shell shortcuts"
fi

# Upstream's persistent guard overrides the updater restored below.
rm -f "$SYSTEMD_DIR/free-sleep-update.service.d/sqlite-maintenance.conf" \
  || warn "could not remove the upstream updater override"

# Create the same readable lock after every boot, keeping any held inode.
OPERATION_LOCK="${NIGHTSTAND_OPERATION_LOCK:-/run/lock/free-sleep-operation.lock}"
if [ -z "${NIGHTSTAND_OPERATION_LOCK:-}" ] && [ ! -d /run/lock ]; then
  OPERATION_LOCK=/tmp/free-sleep-operation.lock
fi
if mkdir -p "$TMPFILES_DIR" && printf 'f %s 0644 root root -\n' "$OPERATION_LOCK" > "$TMPFILES_DIR/free-sleep-operation.conf"; then
  systemd-tmpfiles --create "$TMPFILES_DIR/free-sleep-operation.conf" || warn "could not provision the operation lock"
else
  warn "could not install the operation lock tmpfiles rule"
fi

# Units exec these directly on older installs, and a missing exec bit fails a
# unit with 203/EXEC before it can log anything.
for script in update.sh update_service.sh rollback_pod.sh switch-to-upstream.sh revert-to-stock.sh; do
  [ -f "$COPY/scripts/$script" ] && chmod 755 "$COPY/scripts/$script"
done

cat > "$SYSTEMD_DIR/free-sleep-update.service" <<EOF || warn "could not write free-sleep-update.service"
[Unit]
Description=Nightstand Updater
After=free-sleep.service

[Service]
Type=oneshot
# Run via bash so the updater still works if the script's exec bit is lost
# (systemd fails with 203/EXEC before writing anything to the log otherwise).
ExecStart=/bin/bash /usr/local/lib/nightstand/live/scripts/update_service.sh
# Closes the download window even when the updater was killed outright.
ExecStopPost=-/bin/bash /usr/local/lib/nightstand/live/scripts/close_update_window.sh
User=root
Group=root
KillMode=process
# Also capture logs at the unit level (append so your file grows)
StandardOutput=append:/persistent/free-sleep-data/logs/free-sleep-update.log
StandardError=append:/persistent/free-sleep-data/logs/free-sleep-update.log

EOF

for unit in free-sleep-rollback.service free-sleep-revert.service; do
  cp "$COPY/scripts/systemd/$unit" "$SYSTEMD_DIR/" || warn "could not install $unit"
done

# The health check restarts a server that is running but not answering. The
# agent overlay does not carry it, so a tree without the script skips it.
HEALTH=no
if [ -f "$COPY/scripts/health_check.sh" ]; then
  HEALTH=yes
  for unit in free-sleep-health.service free-sleep-health.timer; do
    cp "$COPY/scripts/systemd/$unit" "$SYSTEMD_DIR/" || { warn "could not install $unit"; HEALTH=no; }
  done
fi

# The network watchdog restarts the Pod when its Wi-Fi driver has died.
NETWATCH=no
if [ -f "$COPY/scripts/network_watchdog.sh" ]; then
  NETWATCH=yes
  for unit in free-sleep-network-watchdog.service free-sleep-network-watchdog.timer; do
    cp "$COPY/scripts/systemd/$unit" "$SYSTEMD_DIR/" || { warn "could not install $unit"; NETWATCH=no; }
  done
fi

systemctl daemon-reload || warn "systemctl daemon-reload failed"
if [ "$HEALTH" = yes ]; then
  systemctl enable --now free-sleep-health.timer >/dev/null 2>&1 || warn "could not start free-sleep-health.timer"
fi
if [ "$NETWATCH" = yes ]; then
  systemctl enable --now free-sleep-network-watchdog.timer >/dev/null 2>&1 || warn "could not start free-sleep-network-watchdog.timer"
fi

RULES=(
  "$USERNAME ALL=(ALL) NOPASSWD: /sbin/reboot"
  "$USERNAME ALL=(root) NOPASSWD: /bin/systemctl start free-sleep-update.service --no-block"
  "$USERNAME ALL=(root) NOPASSWD: /bin/systemctl start free-sleep-rollback.service --no-block"
  "$USERNAME ALL=(root) NOPASSWD: /bin/systemctl start free-sleep-revert.service --no-block"
  "$USERNAME ALL=(ALL) NOPASSWD: /bin/sh /usr/local/lib/nightstand/live/scripts/disable_biometrics.sh"
  # The app's Biometrics switch turns the stream on with exactly this command.
  "$USERNAME ALL=(root) NOPASSWD: /bin/systemctl enable --now free-sleep-stream.service"
)

# Build the new file beside the old one and check it before it goes live: a
# sudoers file with a syntax error disables sudo for every rule in it.
CANDIDATE=$(mktemp)
CHANGED=no
# Older releases granted these, naming files in the server user's own tree.
OLD_SCRIPTS=/home/dac/free-sleep/scripts
DROPPED=(
  "$USERNAME ALL=(ALL) NOPASSWD: /bin/sh $OLD_SCRIPTS/enable_biometrics.sh"
  "$USERNAME ALL=(ALL) NOPASSWD: /bin/sh $OLD_SCRIPTS/disable_biometrics.sh"
)
if [ -f "$SUDOERS_FILE" ]; then
  grep -Fxv -f <(printf '%s\n' "${DROPPED[@]}") "$SUDOERS_FILE" > "$CANDIDATE"
  cmp -s "$SUDOERS_FILE" "$CANDIDATE" || CHANGED=yes
fi
for rule in "${RULES[@]}"; do
  if ! grep -Fxq "$rule" "$CANDIDATE"; then
    echo "$rule" >> "$CANDIDATE"
    CHANGED=yes
  fi
done

if [ "$CHANGED" = yes ]; then
  if command -v visudo >/dev/null 2>&1 && ! visudo -cf "$CANDIDATE" >/dev/null; then
    warn "the updated sudoers rules failed visudo's check; $SUDOERS_FILE was left as it was"
  elif ! install -m 440 "$CANDIDATE" "$SUDOERS_FILE"; then
    warn "could not write $SUDOERS_FILE"
  else
    echo "Sudoers rules for '$USERNAME' updated."
  fi
else
  echo "Sudoers rules for '$USERNAME' already present."
fi
rm -f "$CANDIDATE"

exit "$STATUS"
