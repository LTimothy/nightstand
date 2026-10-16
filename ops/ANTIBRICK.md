# Deployment and recovery notes

These notes are for deploying unpublished changes to a development Pod and
for getting a Pod back when something goes wrong. To install published
releases, use the [update instructions](../README.md#updating). The examples
use SSH on port 8822, which
[installation step 18](../INSTALLATION.md#18-add-an-ssh-config) sets up.

## Recovery scope

Nightstand runs as a userspace application. Installing and deploying it also
change services, sudoers rules, the firewall and, on a Pod 5, the hardware
watchdog. See the [recovery notes](../README.md#what-happens-if-an-install-fails)
for what to check before installing.

## Rules for every change

- Deploy unpublished changes through `ops/deploy.sh`. Never edit code live on
  the Pod. The installer and the in-app updater install published releases
  and replace a development build.
- Deploy committed code from a clean checkout. The script ships `HEAD`, even
  with `--force`; it never includes uncommitted files.
- Run package tests, lint and typechecks, rebuild `server/dist` and
  `server/public` when source changes, and commit the output. Follow
  [CONTRIBUTING.md](../CONTRIBUTING.md#before-a-pull-request).
- Deploy while the bed is idle. The script refuses when either side is on
  unless `--force` is supplied.
- Read root scripts end to end before changing them. Keep SSH access working;
  do not change SSH ports, users, firewall INPUT rules or `/opt/eight` as part
  of an application deployment. Record deliberate service and sudoers changes
  in the repository.
- Check the deployment result, then confirm the running version and the
  controls affected by the change.

## Development deployment

Run these commands on your computer, from the repository root:

```bash
ops/deploy.sh --check
ops/deploy.sh
```

The script ships committed `HEAD`, installs dependencies in a staging copy,
saves a backup and replaces the application tree. It refuses a dirty
checkout, bundles older than the source, or a side that is on, unless
`--force` is supplied; that flag still deploys `HEAD`, not uncommitted
files. Deploy while the bed is idle and verify the intended commit first.
Run the package checks and rebuild committed output as explained in
[CONTRIBUTING.md](../CONTRIBUTING.md#before-a-pull-request).

The in-app updater installs published releases. For unpublished changes, use
the workflow above. [Hot reload](../server/README_SERVER.md#hot-reloading-on-the-pod)
and `scripts/deploy-dev.sh` do not include the same backup and rollback steps.

A deploy copies code, not systemd units, sudoers rules or the hardware
watchdog setting. When a change adds or changes one, install it by hand once
([how](../server/README_SERVER.md#units-a-deploy-does-not-install)).

### What is backed up and checked

- The deploy backup contains an application archive (without server
  `node_modules`), the LowDB settings and schedules, and a plain copy of the
  SQLite file, under `/persistent/free-sleep-backups/<timestamp>_v<version>/`.
  The update script writes the same archive and settings copy there, and a
  consistent database snapshot under
  `/persistent/free-sleep-database-backups/` instead.
- The immediate previous tree is `/home/dac/free-sleep-prev`. A later deploy
  or update replaces it. Both scripts keep the five newest backup
  directories.
- The preflight sizes what the deploy will write from the install it
  replaces (the shipped tree, the dependencies when the lockfile changed, a
  Node version Volta must fetch, the backup and the database), adds a 64 MB
  margin, and refuses when `/` or `/persistent` has less free.
- The health check requires HTTP 200 from `/api/deviceStatus`, the expected
  version, a numeric left-side temperature and an active server service.
  A failed migration also fails the deployment. Test affected controls
  separately.
- A failed health check restores the previous application tree and keeps the
  failed one at `/home/dac/free-sleep-failed`. It does not reverse database
  migrations. Keep migrations additive so older code can read the newer
  schema. The saved database is a separate recovery option, not part of an
  automatic code rollback.

The installer takes the same operation lock as update, rollback and the
switch to upstream. It refuses a busy lock before downloading or changing
files, and holds it through the health check and any restore.

Before an update moves the live tree, it installs a recovery helper outside
the application trees and writes `/persistent/free-sleep-data/update-swap.json`.
The marker stays until the new version or the restored version passes its
health check, including a restore made by the updater's exit trap. While it
is armed, service setup leaves the recovery files unchanged. Otherwise setup
installs each helper and unit by flushing a temporary file, renaming it and
flushing its directory.

After a power loss, `free-sleep-recover-update.timer` schedules one recovery
attempt 45 seconds after boot. Its service runs after `multi-user.target`,
so recovery does not hold up boot completion. Systemd limits the attempt to
60 seconds, with at most 5 more seconds to kill remaining processes. It does
not retry during that boot. A timeout keeps the marker for manual recovery.

A responding new tree clears the marker only when its version, temperature
reading and server service pass the check and `/api/serverStatus` reports a
healthy database with no unapplied migrations. Missing, unfinished or failed
database checks cause recovery to restore the marked previous tree. If the
live tree is missing or fails the check, recovery uses rollback's shared
helpers to stop both database writers, return shared dependencies when the
lockfiles match, apply the restored firewall and restart the services. It
clears the marker only after the restored original tree passes its health
check. It never acts without the marker or restores database or settings
backups. An unreadable marker, a missing previous tree or a writer that will
not stop requires manual recovery; the marker and available trees are kept.

On my Pod 5, a reboot with no marker left recovery idle, and a hand-set
marker cleared after the health check. After a power cut a few seconds
after the server stopped for an update, the Pod came back healthy on the
previous install. Recovery ran once, about 40 seconds after power returned,
and cleared the marker. The cut landed before the tree move; a cut during
the move itself is covered only by automated tests. The interrupted update
recorded no result, so the app's last result stayed at the previous run.

The switch to upstream refuses while an update marker exists. A successful
switch removes the recovery timer, service, external helpers and marker,
along with Nightstand's other retired services.

Keep working SSH access before changing services or firewall rules. Read
root scripts end to end, especially SSH configuration, firewall INPUT rules,
systemd units and sudoers entries. The installer, updater and deployment
scripts do not have identical failure handling; read their output rather
than treating a responding web page as complete recovery.

## Recovery options

The following SSH examples run on your computer. Replace `<POD_IP>` with the
Pod's address. They require root SSH access:

```bash
ssh -p 8822 root@<POD_IP> 'journalctl -u free-sleep -n 100'
ssh -p 8822 root@<POD_IP> 'systemctl restart free-sleep'
```

If restarting does not resolve the problem:

1. **Roll back the application.** Run `ops/rollback.sh` on your computer to
   restore the previous tree. It checks that the device status route
   answers; check the version and controls yourself afterward.
2. **Restore older application code.** `ops/rollback.sh --list` lists backups;
   `ops/rollback.sh --from <backup-dir-name>` restores that archive and reuses
   installed dependencies. Database and LowDB restoration is a separate
   manual operation. Check compatibility before restoring data.
3. **Switch to upstream free-sleep.** Settings > Software can install
   `throwaway31265/free-sleep`, keeping the data folder and preparing
   compatible settings. It installs the upstream commit recorded in
   `releases.json` when one is recorded, otherwise upstream's `main`. It
   replaces the application and removes Nightstand's own services and
   hardware watchdog setting, but not every system change Nightstand made.
   Read the [switch limits](../docs/COMING_FROM_FREE_SLEEP.md#switching-to-upstream).
   There is no in-app route back; use the
   [migration tool](../docs/COMING_FROM_FREE_SLEEP.md) to return. If the app
   is unavailable but SSH works, the same switch starts with
   `systemctl start free-sleep-revert.service`.
4. **Restore Eight Sleep software.** Nightstand cannot do this from the app.
   On Pod 3 and Pod 4 it needs a firmware reset; follow the model-specific
   [procedure](../INSTALLATION.md#going-back-to-the-eight-sleep-app).
   On Pod 5 no reset procedure has been checked yet. It is separate from
   restoring an application backup.

Pods switched with a version of the migration tool older than 3.4.0 can lack
permissions or units for Roll back, Switch to upstream and turning
biometrics off. The app reports the missing piece. A successful update
installs the missing rules and units.

### Restore a database snapshot

In-app updates and switches save consistent SQLite snapshots, including
committed WAL data, under `/persistent/free-sleep-database-backups/`.
Code-backup rotation does not delete these snapshots. Nightstand keeps the
newest three and any from the last week, and removes the rest on every run.
Only while free space on `/persistent` is under 512 MB does it remove more,
oldest first. It never removes the newest, or files it did not name itself,
such as snapshots made by the migration tool; remove those yourself once you
have a verified recovery copy. Older code backups, and the plain copy a
deploy makes, can hold an incomplete database if data was still in the WAL;
check their contents before relying on them.

Restoring a snapshot replaces newer measurements with the saved data. Choose
a snapshot compatible with the installed code. Older and upstream trees lack
`sqlite-safety.py`; take a trusted copy from the retained Nightstand tree or
its code archive and set `SAFETY` to that path. Check it before stopping
services. Run the following as root on the Pod while the bed is idle,
replacing the example snapshot path:

```bash
set -e
DB=/persistent/free-sleep-data/free-sleep.db
SNAPSHOT=/persistent/free-sleep-database-backups/<chosen-snapshot>.db
SAFETY=/usr/local/lib/nightstand/live/scripts/sqlite-safety.py
test -f "$SNAPSHOT"
test -f "$SAFETY"
python3 -c 'import sqlite3'
systemctl stop free-sleep free-sleep-stream
python3 "$SAFETY" backup "$DB" "$DB.before-restore-$(date +%Y%m%d-%H%M%S)"
python3 "$SAFETY" checkpoint "$DB"
install -o dac -g dac -m 660 "$SNAPSHOT" "$DB.restore"
mv "$DB.restore" "$DB"
rm -f "$DB-wal" "$DB-shm"
systemctl start free-sleep
```

Restart `free-sleep-stream` only if biometrics was on before recovery.
Check the logs and the Sleep page afterward. Settings and schedules are in
the separate `lowdb/` backup; restoring code or SQLite does not restore them.
The migration tool's `--restore` also restores code only.

### Failed database migrations

A Prisma `P3009` error means a previous migration did not finish. Do not reset
the database or repeatedly mark that migration as rolled back. Older shipped
migrations were not transactional and may have left partial tables.

The updater resolves a `P3009` failure once, and only after
`sqlite-safety.py` has checked that each failed migration matches its
recorded checksum and is a single additive transaction; then it retries.
For manual recovery, stop the server and the biometrics stream, save a
database snapshot as above, and run the trusted helper (adjusting its path
if Nightstand is no longer installed):

```bash
python3 /usr/local/lib/nightstand/live/scripts/sqlite-safety.py recoverable-migrations \
  /persistent/free-sleep-data/free-sleep.db \
  /home/dac/free-sleep/server/prisma/migrations
```

If it succeeds, run Prisma from the server folder as the `dac` user, with
the database named the way `.env.pod` names it. Mark each printed migration
as rolled back, then apply and check:

```bash
cd /home/dac/free-sleep/server
export DATABASE_URL=file:/persistent/free-sleep-data/free-sleep.db
npx prisma migrate resolve --rolled-back <name>
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status
```

Run the `resolve` line once for each printed name, and restart the server
only once `migrate status` reports nothing pending. These commands target
the Nightstand migration folder; do not use an older fork's
`npm run migrate`, which may run Prisma's development workflow and reset the
database. If the check refuses recovery, inspect the failed SQL and database
together, or restore a compatible snapshot. A code rollback alone cannot
repair a partial database migration.

## Network behavior

The app checks this fork's release list on GitHub from the user's browser.
Browser internet access is separate from the Pod's firewall.

The Pod's firewall (`scripts/block_internet_access.sh`) allows the local
network ranges (10/8, 172.16/12 and 192.168/16), loopback, mDNS, replies to
connections the Pod opened, time sync, and DNS to the resolvers configured
when it last ran. Connections to the firmware's upload port, 1337, are
refused at once rather than dropped. Everything else out is dropped. If
`tailscaled` is active when the script runs, it also allows outbound UDP,
DNS and HTTPS to any host. The rules remain until the script runs again;
they are not limited to Tailscale's servers. See the
[remote-access guide](../docs/REMOTE_ACCESS.md) before changing Tailscale
setup.

While the updater downloads a release and its dependencies, it adds rules at
the top of the firewall that let HTTPS and DNS out, and nothing else; IPv6
HTTPS is refused so downloads use IPv4. Nothing else in the firewall
changes. The rules come out and the block script runs again however the
updater ends, and `close_update_window.sh` runs after the update and switch
services stop, in case the updater was killed. A deploy opens the same
window only while it downloads changed dependencies or a new Node version.

After a successful update the updater applies the installed version's
firewall and checks that its final DROP rule is there, and that port 1337
is refused when that version's script refuses it. If the rules cannot be
applied it rolls the update back. A rollback applies the restored version's
rules. Downgrading therefore brings back older firewall behavior, including
broader outbound access and older Pod 3 connection handling, until the next
update. Rollback, the fork switch and the biometrics install apply the
rules too, even if they were never set up by hand; a first install does
not.

Current downgrade and rollback paths keep the configured RAW retention when
they install an older archive script, or stop before swapping if they
cannot. Moves from 3.3.x to 3.2.x made by those older versions still revert
to 36-hour retention and can delete older sensor archives. Older versions
also do not honor features introduced later, including the presence
auto-off switch.

## Health check and watchdogs

- **Health check.** `free-sleep-health.timer` runs `scripts/health_check.sh`
  every minute, from 5 minutes after boot. When the server is running but
  has given no answer to three checks in a row, it restarts the server. It
  leaves alone a server that is stopped, that started less than 2 minutes
  ago, or that an update, rollback or switch is replacing.
- **Hardware watchdog.** Install, update and the fork switch run
  `scripts/setup_watchdog.sh --auto` once they have succeeded. It turns on
  systemd's runtime watchdog (30 seconds), so a frozen system restarts the
  Pod. It does so only on a Pod 5 like the one it was checked on: the
  `mtk-wdt` driver with a 31 second maximum and a hub revision of G53 or
  later. It first tries the setting for 60 seconds from `/run`, so a
  watchdog that does not work resets the Pod once rather than at every boot,
  and a failed trial is recorded so later runs do not try again. A deploy
  does not run it.
  `bash /usr/local/lib/nightstand/live/scripts/setup_watchdog.sh --remove` turns it
  off, and it stays off through updates and reinstalls until the script is
  run again without arguments. On some Pods it turns off only at the next
  restart. I checked setup, removal, persistence across a reboot and
  recovery from a deliberate freeze on my Pod 5.
- **Network watchdog.** `free-sleep-network-watchdog.timer` runs
  `scripts/network_watchdog.sh` every minute, only where the stock MT7663
  Wi-Fi driver is loaded. It restarts the Pod, with a normal reboot, when
  the driver has crashed this boot and the network has been down for 5
  minutes, or when the network has been down for 20 minutes and Wi-Fi scans
  have failed throughout. It does nothing while the hardware watchdog is
  off, in the first 10 minutes after boot, or while an install, update,
  rollback, switch, reset or biometrics install runs, and it restarts the
  Pod at most once in 6 hours and three times in 24. Its state is in
  `/persistent/free-sleep-data/network-watchdog`, and
  `network_watchdog.sh --dry-run` prints what it would decide. Whether a
  restart brings Wi-Fi back has not been confirmed.

The switch to upstream removes the health check, the network watchdog and
the hardware watchdog setting.

## Standing state to remember

- Live code is at `/home/dac/free-sleep`; the previous deployment is at
  `/home/dac/free-sleep-prev`, and failed deployments go to
  `/home/dac/free-sleep-failed`.
- Backups are under `/persistent/free-sleep-backups/<timestamp>_v<version>/`,
  and database snapshots under `/persistent/free-sleep-database-backups/`.
- The firewall normally blocks most of the Pod's internet access. Updates
  and deploys open HTTPS and DNS only while they download, then apply the
  rules again.
- On a Pod 5, the hardware watchdog and network watchdog may be on (see
  above). Check with `systemctl show -p RuntimeWatchdogUSec`.
- Release checks run in the browser against this fork's release list on
  GitHub and follow the saved channel. The Pod's firewall does not block
  browser requests.
- On a Pod 5 no reset procedure has been checked yet.
