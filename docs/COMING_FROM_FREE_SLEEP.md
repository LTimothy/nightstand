# Coming from free-sleep

If your Pod runs upstream [throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep),
[jmew/free-sleep](https://github.com/jmew/free-sleep) (which Nightstand is
forked from) or another free-sleep fork, a migration tool can switch it to
Nightstand without reinstalling from scratch, and keeps a copy of what it
replaces.

The switch replaces application files and changes services and firewall
rules. Before swapping code it arms a timer that tries to restore your
original application if the install hasn't finished within 12 minutes. If
that fails too, recovery needs SSH. The migration tool doesn't check a
release checksum. Its backup, automatic restore
and failure checks have been tested against simulated failures, not on a
real Pod, so read the
[recovery notes](../README.md#what-happens-if-an-install-fails) first. I
haven't run this version of the tool on a Pod yet; so far it has only been
tested against simulated runs.

## What stays the same

Nightstand keeps free-sleep's on-disk layout:

- The install lives at `/home/dac/free-sleep`.
- The services are `free-sleep.service` and `free-sleep-stream.service`.
- Your data stays under `/persistent/free-sleep-data/`: the SQLite database,
  the lowdb JSON files that hold settings and schedules, and the logs.

## What changes

I test Nightstand on my own Pod 5. On a Pod 3 or Pod 4, temperature control
and scheduling are expected to work, but those models write sensor data in a
different format and sleep tracking hasn't been tested there. The tool asks
you to acknowledge this, but it doesn't test compatibility.

The switch applies the
[firewall rules](../INSTALLATION.md#19-add-firewall-rules-to-limit-internet-access),
which block most internet access (updates open what they need while they
download). Nightstand sends no error reports or analytics.

The switch asks before removing legacy root cron jobs that open the firewall,
their time sync script and the ambient-light database writer. It stops other
unknown `free-sleep*` units before the database checkpoint and never enables
them. It reports IPv6-disable settings in `/etc/sysctl.conf` without changing
them. Install and update only warn about the legacy cron jobs.

Settings > Software has Stable and Beta channels, a version picker and a way
back to the previous install. If your settings have no update channel yet,
the switch saves the installed release's channel. A failed update tries to
restore the previous application, not an earlier database or Eight Sleep's
firmware.

On a Pod 5, the switch and later updates turn on the hardware watchdog and
the network watchdog once they succeed, with the limits
[installation step 13](../INSTALLATION.md#13-install-the-nightstand-server)
describes. Other models are left as they are for now.

The switch keeps your four-tap alarm action. The app has no tap editor; to
change it, see `taps` under [`/api/settings`](../server/API.md#apisettings).

## Before you start

You need:

- A Mac or Linux computer with `curl`, `ssh`, `scp`, `tar` and `python3`, and
  more than 2 GB free on it for the backup copy.
- The Pod's root password, or an SSH key, for SSH on port 8822 or 22.
- A current install that is running normally, with its web app reachable from
  your computer. The tool stops if `free-sleep.service` isn't active.
- Enough free space on the Pod. The tool checks what it needs on `/` and
  `/persistent` and stops before changing anything if there isn't enough.
- Outbound HTTPS from the Pod, for the release and its dependencies. If you
  blocked internet access on your current install, unblock it first (upstream,
  jmew's fork and the other forks I know of all have
  `sh /home/dac/free-sleep/scripts/unblock_internet_access.sh`). The switch
  turns the block back on.

Switch while the bed is empty and no alarm is due. The server stops during
the swap, so schedules and alarms pause until it's back. If either side is
on, the tool asks for a typed confirmation before going ahead.

## Switching

1. Download the tool and the four helper files it copies to the Pod into one
   folder, so you can read them before running them:
   ```bash
   for f in switch-to-this-fork.sh pod-installer.sh restore-original-fork.sh fork-artifacts.sh; do
     curl -fO "https://raw.githubusercontent.com/LTimothy/nightstand/main/scripts/migrate/$f"
   done
   curl -fO "https://raw.githubusercontent.com/LTimothy/nightstand/main/scripts/restore_helpers.sh"
   chmod +x switch-to-this-fork.sh
   ```
2. Run it with `--dry-run`. It reports what it found and would do, without
   changing anything:
   ```bash
   ./switch-to-this-fork.sh --dry-run
   ```
   It looks for the Pod at `eight-pod.local`, offers to scan your network, or
   takes the address with `--ip <address>`. It asks for the root password;
   leave it blank if you log in with a key. The dry run skips the download
   and the database checks; the real run does them on the Pod before anything
   is swapped.
3. If the report looks right, run it again without `--dry-run`. It asks you
   to type `switch` before it changes anything. Keep the backup it saves in the
   folder you run it from for a few nights.

The tool reports root cron jobs that open the firewall and fork-specific
services before making changes. Removing those cron jobs and the ambient-light
service requires a separate typed confirmation. Declining it refuses the
switch. Other unknown `free-sleep*` units are stopped before the database
checkpoint and are not restarted by the tool. Copies of removed artifacts
stay in `/persistent/nightstand-migrate-artifacts/backup.*`; the installer prints
the exact directory. A failed switch restores the cron and removed files,
but leaves foreign units disabled or stopped for you to review.

Keep your computer awake and the terminal open until the tool prints its
result. Once the backup is on your computer, the install carries on in the
background on the Pod even if you disconnect.

You don't need the numbered installation steps, except
[step 20](../INSTALLATION.md#20-remote-access-with-tailscale-optional) if you
want remote access.

## What the tool does

`switch-to-this-fork.sh` runs on your computer and works over SSH. In order,
it:

1. Checks the Pod and prints its report without changing anything. With
   `--dry-run` it stops here.
2. Asks you to type `switch`, then offers to set the Pod's clock if it's off.
3. Backs up the application code and installed server dependencies, the
   SQLite database and the lowdb settings and schedules to
   `/persistent/free-sleep-backups/` on the Pod, copies the archive to the
   folder you ran the tool from, and checks both (the database copy passes
   SQLite's integrity check, both archives read back, their sizes match). A
   separate SQLite snapshot goes in `/persistent/free-sleep-database-backups/`.
   Logs and raw sensor archives aren't backed up.
4. Downloads the newest Nightstand release on the Pod, which may be a beta,
   checks your settings and schedules against Nightstand's formats, and tries
   Nightstand's database migrations on a copy of your database. If anything
   can't carry over, it stops with your install and data untouched. Don't
   reset the database to get past this; open an issue with the tool's output
   instead.
5. Stops your old server and its stream (if either won't stop, it stops with
   them untouched), swaps the new install in, keeps your old one at
   `/home/dac/free-sleep-prev`, checks that the server answers with the
   expected version, and applies the firewall rules. That check covers
   startup, not heating or cooling, so try your usual controls afterward.

## Going back

After a successful switch, going back restores the application tree but does
not reinstall removed cron jobs or enable foreign units. The artifact copies
remain in the directory printed by the installer. Review them before restoring
them, since the cron jobs open the firewall.

To your previous install: in Settings > Software > Recovery, use "Go back to
v{version}" under Previous installation. Right after switching, that is your
old install. Installing any other Nightstand version replaces it, and from
then on you need the backup on your computer. Rolling back doesn't roll back
the database. Pods switched with a tool older than 3.4.0 need one successful
Nightstand update first, to add permissions and services that tool missed.

From the backup on your computer, even with the web app down, as long as SSH
works:

```bash
./switch-to-this-fork.sh --restore <backup-tarball> --ip <POD_IP>
```

It checks the archive before stopping the app and keeps the replaced install
at the path it prints. Archives without `server/node_modules` are refused. It
restores code, not database rows or settings; for those, see
[manual data recovery](../ops/ANTIBRICK.md#restore-a-database-snapshot).

To an older Nightstand version: this restores that version's firewall and
features. Going from 3.3.x to 3.2.x can cut raw recording retention to 36
hours.

To upstream free-sleep: Settings > Software has "Switch to upstream
free-sleep". It installs the original throwaway31265/free-sleep, not jmew's or
another fork. It installs the upstream free-sleep version this release pins
in `releases.json`, rather than the newest upstream code. I haven't run the
full switch on hardware. To come back, run the migration tool again (there's
no button). Read
[Switching to upstream](#switching-to-upstream) first.

To Eight Sleep's software: see
[Going back to the Eight Sleep app](../INSTALLATION.md#going-back-to-the-eight-sleep-app).
On a Pod 5 there is no tested way back.

### Switching to upstream

If the browser cannot fetch `releases.json`, the legacy switch remains
available. It sends no target, so the Pod reads the legacy pin itself. A
manifest that loads but changes during confirmation requires a new
confirmation. A newer upstream target, once one is published, always needs a confirmed target.

Before the switch, code and JSON settings are backed up under
`/persistent/free-sleep-backups/<timestamp>_v<version>_prerevert-to-stock/`,
and SQLite snapshots under `/persistent/free-sleep-database-backups/`.
Upstream runs one alarm per day, so the switch keeps the first enabled alarm
per day, caps its duration at 180 seconds, shows level temperatures in
Fahrenheit, and maps base-control taps to alarm dismissal (with no action when
there is no alarm). Extra and one-time alarms don't run upstream; the backup
keeps the original settings.

Nightstand's own services, including the network watchdog, and its hardware
watchdog setting are removed (on some Pods the watchdog turns off at the next
restart). Backups and `raw-archive/` stay; the switch log prints the
archive's size so you can delete it if you no longer need it. With no published
switch journal, a successful legacy switch also removes the switch recovery
service, its startup drop-ins and external helpers.

Upstream's first update can print a "reset, all data will be lost" message
because its migration history differs. Do not follow that reset prompt. Your
data can still be intact; check the migration status and use the
[recovery steps](../ops/ANTIBRICK.md#failed-database-migrations) instead.
jmew's installer removes SQLite WAL files (recent changes not yet written into
the main database file), and both forks' database reset deletes them along
with the database. Upstream's installer and updater now save a copy of the
database and write those changes into it first, as of October 2026. Either
way, copy the switch's snapshot from
`/persistent/free-sleep-database-backups/` to your computer before using
their reinstall or reset paths
([restoring one](../ops/ANTIBRICK.md#restore-a-database-snapshot)).

Make sure you can still reach the Pod locally before switching. Upstream's
installer, which its updater also runs, rewrites the server's service file,
and that drops the Tailscale origin setting from
[remote access](REMOTE_ACCESS.md#4-allow-the-tailscale-address-in-nightstand).

## Reporting problems

[Open an issue](https://github.com/LTimothy/nightstand/issues) with your Pod
model, Nightstand version, what you expected, what happened and how to
reproduce it. For install or service problems, include the relevant `fs-debug`
output after removing personal or network details you don't want public. If
upstream free-sleep has the problem too, consider reporting it there as well.
