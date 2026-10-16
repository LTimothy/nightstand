# Server notes

Notes for working on the Express server that runs on the Pod: how to run it
during development, how the code is organized, and the changes that are made
on the Pod by hand. [API.md](./API.md) documents every route and the
WebSocket. [AGENTS.md](../AGENTS.md) maps the scheduling and hardware code,
and [ops/ANTIBRICK.md](../ops/ANTIBRICK.md) covers deploying and recovery.

The server listens on port 3000. It serves the REST API under `/api/`, a
WebSocket at `/ws/events`, and the built React app from `public/`.

## Running the server

### Prerequisites

- [Volta](https://volta.sh/), which installs the Node version pinned in
  `package.json` (currently 24.11.0), or the version in the repository's
  `.nvmrc`.

### On the Pod

`scripts/install.sh` installs dependencies, applies database migrations, and
creates the `free-sleep` systemd service, which runs `npm start` (see
[INSTALLATION.md](../INSTALLATION.md)). `npm start` loads `.env.pod`, which
points at `/persistent/free-sleep-data/`, so it only works on a Pod.

### On your computer

Running locally is useful for work on routes, the database, and the job
scheduler. With `ENV="local"` the server does not connect to the Pod's
Franken socket, so anything that talks to the hardware will not work. For
work on the UI alone, the app's demo mode needs no server at all (see
[app/README_APP.md](../app/README_APP.md#developing)).

1. Install dependencies:
   ```bash
   cd server
   npm ci
   npm run generate
   ```
2. Edit `.env.local`. Replace the example paths with paths on your computer.
   - `DATA_FOLDER` is an absolute path ending in `/`. The server appends
     `lowdb/` to it. The git-ignored `server/free-sleep-data/` folder works
     for this.
   - `DATABASE_URL` is `file:` followed by the SQLite file path, for example
     `file:<DATA_FOLDER>free-sleep.db`.
3. Create the `lowdb/` folder inside `DATA_FOLDER`. The server writes its JSON
   files there on startup but does not create the folder. With the in-repo
   folder:
   ```bash
   mkdir -p free-sleep-data/lowdb
   ```
4. Create the SQLite database. The server never applies migrations itself:
   ```bash
   npx dotenv -e .env.local npx prisma migrate deploy
   ```
5. Start the server. nodemon restarts it when a file in `src/` changes:
   ```bash
   npm run dev:local
   ```

After changing `prisma/schema.prisma`, create a migration with
`npm run migrate:local <migration_name>`, then read the migration rules in
[CONTRIBUTING.md](../CONTRIBUTING.md#release-cadence-and-promotion).

Typecheck, lint, and test commands are in
[CONTRIBUTING.md](../CONTRIBUTING.md#before-a-pull-request).

### Hot reloading on the Pod

This is a development workflow on an idle test Pod. It has no automatic
backup or rollback step, and schedules and alarms stop while the service is
stopped. For committed development deployments use
[ops/deploy.sh](../ops/ANTIBRICK.md); for published releases use the in-app
updater.

`npm run dev` runs the TypeScript source with nodemon and restarts on changes
to `src/`. It reads `.env.pod`, so it runs on the Pod.

1. SSH into the Pod. Stop the service so it releases port 3000 and the
   `dac.sock` connection, then start the dev server as the `dac` user:
   ```bash
   systemctl stop free-sleep
   su - dac -c "cd /home/dac/free-sleep/server && /home/dac/.volta/bin/npm run dev"

   # When you're done, press Ctrl+C and start the service again:
   systemctl start free-sleep
   ```
   Running it as `dac` matches the service and keeps files it writes under
   `/persistent/free-sleep-data/` owned by that user. The `fs-dev-server`
   shortcut, which `scripts/add_shortcuts.sh` installs, runs the first two
   commands.
2. Because nodemon watches `src/` on the Pod, edits have to land there. An
   editor that uploads on save does this, for example VS Code's
   [Remote - SSH](https://code.visualstudio.com/docs/remote/ssh) or a JetBrains
   [deployment configuration](https://www.jetbrains.com/help/idea/tutorial-deployment-in-product.html#downloading).
   `scripts/deploy-dev.sh` is a different workflow: it builds on your computer
   and copies `dist/` and `public/` to the Pod.
3. To run the app with hot reload against the same Pod, see
   [app/README_APP.md](../app/README_APP.md#developing).

While the dev server runs, the health check sees the `free-sleep` service
stopped and leaves it alone.

### Units a deploy does not install

`ops/deploy.sh` and `scripts/deploy-dev.sh` copy code, not systemd units or
sudoers rules. Install and update set those up, so a Pod that was installed
or updated to a recent release already has them. When a change adds or
changes one, or on a Pod that only ever received deploys, install them by
hand once.

The update, rollback and switch services, their sudoers rules, the
Biometrics switch rule, and the health check and network watchdog timers
come from `scripts/setup_services.sh`. Run `ops/deploy.sh` once: it
publishes the root-owned copy of the scripts and runs `setup_services.sh`
on it. Running the script by hand on the server user's folder is refused.

The RAW archive timer is installed separately. Its service runs
`archive-raw.sh` from the root-owned copy, so only the units need copying:

```bash
# From your computer, in the repo root:
scp -P 8822 scripts/systemd/free-sleep-archive-raw.{service,timer} root@<POD_IP>:/etc/systemd/system/
ssh -p 8822 root@<POD_IP> 'systemctl daemon-reload \
  && systemctl enable --now free-sleep-archive-raw.timer'
```

Check it with `systemctl status free-sleep-archive-raw.timer`, which should
show `active (waiting)` with the next run less than a minute away. Undo it
with `systemctl disable --now free-sleep-archive-raw.timer`; the archive
itself is in `/persistent/free-sleep-data/raw-archive/`.
[biometrics/DEVELOPER.md](../biometrics/DEVELOPER.md#where-the-data-comes-from)
explains what the archive is for.

A deploy never turns on the hardware watchdog. Install, update and the fork
switch do, or `scripts/setup_watchdog.sh` run by hand
([ops/ANTIBRICK.md](../ops/ANTIBRICK.md#health-check-and-watchdogs)).

---

## Architecture

### Entry point (`src/server.ts`)

Registers middleware and routes, starts listening, attaches the WebSocket
server, and connects to Franken (skipped when `ENV="local"`). On `SIGTERM` or
`SIGINT` it sends any power-off that was waiting for an alarm, stops
scheduled jobs, disconnects the database, and closes the WebSocket, HTTP and
Franken connections before exiting.

### Routes

Each route group lives in its own folder under `src/routes/` and is
registered in `src/setup/routes.ts`. `src/setup/middleware.ts` holds the
Origin filter, the JSON body checks and request logging, and
`src/setup/errorHandlers.ts` turns errors into responses. The groups are
device control (`deviceStatus`, `settings`, `schedules`, `rhythms`,
`execute`, `alarm`, `baseControl`, `jobs`), sleep data (`metrics`), and
operations (`serverStatus`, `services`, `logs`, `metricsServer`, `storage`,
`memory`, `calibration`, `changelog`, `update`). [API.md](./API.md) has the
request and response formats.

### WebSocket (`src/ws/`, path `/ws/events`)

`src/events/eventBus.ts` carries three channels, `device-status`,
`service-health` and `job-event`, and the WebSocket server sends each event
to every client. A new client first receives a `hello` message. The server
pings each client every 15 seconds and closes any client that did not answer
the previous ping. See [API.md](./API.md#websocket-wsevents).

### Franken socket (`src/8sleep/`)

The server talks to the Pod's "Franken" process over a Unix socket, the
`dac.sock` the original Pod software in `/home/dac/app/` uses. The server
listens on the socket and the firmware connects to it. Its path differs
between Pod models and firmware versions. `install.sh` detects it and writes
it to `/persistent/free-sleep-data/dac_sock_path.txt`; without that file the
server reads it from the firmware's `/opt/eight/bin/frank.sh`, and failing
that uses `/deviceinfo/dac.sock`.

Commands run one at a time through a queue. Each is limited to
`FRANKEN_COMMAND_TIMEOUT_MS` (default 5000). On a timeout the caller receives
an error and the connection is closed, so the next command opens a new one.
A request waits up to 10 seconds for a missing connection; scheduled power
and temperature changes wait until it returns.

`FrankenMonitor` reads the device every 2 seconds whether or not a client is
connected, because the same loop detects tap gestures and watches the water
tank. Adjustable-base actions triggered by those gestures need compatible
base hardware.

### Job scheduler (`src/jobs/`)

Uses `node-schedule` for power, temperature, alarm, priming, reboot and the
daily analysis jobs, and for Rhythms when they are on. It watches the LowDB
folder and rebuilds the jobs when settings, schedules or `rhythmsDB.json`
change; other files there, such as `servicesDB.json`, never affect the
schedule. [AGENTS.md](../AGENTS.md#scheduling-code) describes both schedule
engines.

### Storage (`src/db/`)

- **LowDB**, JSON files in `/persistent/free-sleep-data/lowdb/`, for
  configuration:
  - `schedulesDB.json`: the weekly schedule
  - `settingsDB.json`: settings
  - `servicesDB.json`: the Biometrics switch and job status
  - `rhythmsDB.json`: Rhythms, once they have been turned on

  The first three are validated with `zod` and written with defaults on
  startup if missing.
- **Files in the data folder**: `alarm-ledger.json` (alarms that were due,
  for missed-alarm reports) and `rhythms-history.jsonl` (one line per
  finished Smart Schedule sleep, kept 90 days).
- **SQLite through Prisma**, at `/persistent/free-sleep-data/free-sleep.db`,
  for sensor data and calibration. Tables: `vitals`, `movement`,
  `sleep_records`, `calibration_profiles`, `calibration_runs`,
  `analysis_runs` and `water_level_events` (see `prisma/schema.prisma`).
  - The server does not apply migrations. `scripts/install.sh` applies them
    on install, and `scripts/update.sh` runs `prisma migrate deploy` during
    an update when any are pending (with retries; skipped on a downgrade).
    `/api/serverStatus` lists migrations that have not been applied.
  - Read helpers: `loadSleepRecords.ts` and `movement.ts`. The vitals route
    queries Prisma directly.

---

## File structure

```text
server/
├── API.md                  # Route and WebSocket reference
├── free-sleep-data/        # Git-ignored local DATA_FOLDER (mirrors /persistent/free-sleep-data/)
├── prisma/
│   ├── schema.prisma       # SQLite schema
│   ├── shipped-migrations.json  # Checksums of released migrations
│   └── migrations/         # Applied by scripts/install.sh and scripts/update.sh
├── public/                 # Built React app, served as static files (output of the app build)
├── dist/                   # Compiled server (tsc); committed, run by npm start
├── src/
│   ├── 8sleep/             # Franken socket, command queue, monitor, base control, water tank
│   ├── agent/              # File list for the updater overlay for stock installs (not used at runtime)
│   ├── db/                 # LowDB stores, Prisma client, schemas, read helpers
│   ├── events/             # In-process event bus
│   ├── features/           # Feature manifest, and the New sleep tracking switch
│   ├── jobs/               # Scheduled jobs, Rhythms, alarm record, update and reboot starters
│   ├── metrics/            # In-process metrics
│   ├── routes/             # One folder per route group
│   ├── setup/              # Middleware, error handlers and route registration
│   ├── ws/                 # WebSocket server
│   ├── config.ts           # Reads DATA_FOLDER and ENV, finds dac.sock
│   ├── logger.ts           # Winston logger
│   ├── serverInfo.json     # Version, branch and upstream base
│   ├── serverStatus.ts     # Health state reported by /api/serverStatus
│   └── server.ts           # Entry point
├── .env.pod                # Pod environment (used by npm start and npm run dev)
├── .env.local              # Local environment (used by npm run dev:local)
├── package.json
└── tsconfig.json
```

Tests sit next to the code they cover as `*.test.ts`. The tests for the shell
scripts are at the top of `src/`.

---

## Changes made on the Pod

The first three changes concern the Pod's own system, outside this repo, and are done by
hand to save memory, CPU and disk. The figures were measured on one Pod 5
and are not the same on every model or firmware. Each can be undone. The last
two are in the repo.

### 1. Cap journald at 100 MB (frees about 700 MB on `/persistent`)

`/var/log/journal` is a link to `/persistent/journal`, so systemd's logs use
space on the persistent partition with no limit.

```bash
# On the Pod (as root):
sed -i.bak 's/^SystemMaxUse=.*/SystemMaxUse=100M/' /etc/systemd/journald.conf
systemctl restart systemd-journald
journalctl --vacuum-size=100M
```

The `sed` command only changes an uncommented `SystemMaxUse=` line. Confirm
the change with `grep '^SystemMaxUse' /etc/systemd/journald.conf`.

Undo: `cp /etc/systemd/journald.conf.bak /etc/systemd/journald.conf && systemctl restart systemd-journald`.

### 2. Leave `Eight.Capybara` running (it makes the quad-tap buzz)

Capybara is Eight Sleep's cloud-telemetry agent. It uses about 180 MB of
memory and 11% CPU, and this server does not use its `capybara-dac` socket,
so it looks safe to turn off. It is not: Capybara makes the confirmation buzz
for the quad-tap gesture. The firmware buzzes on its own for double and
triple taps, but with Capybara off the quad tap gives no buzz and no error.
If it has been turned off, turn it back on with
`systemctl enable --now capybara`.

### 3. Run node directly in `free-sleep.service` (frees about 30 MB)

The unit written by `install.sh` starts the server with `npm run start`,
which leaves the npm and dotenv-cli wrapper processes running above the node
process that serves requests. Pointing `ExecStart` at the node binary
directly leaves one process.

`npm start` is what normally loads `.env.pod`, so the pinned command passes
it to node with `--env-file`. Without it the server exits at startup with
`Missing DATA_FOLDER || ENV in env`.

```bash
# On the Pod:
NEW_NODE_PATH=$(sudo -u dac /home/dac/.volta/bin/volta which node)
SVC=/etc/systemd/system/free-sleep.service
cp "$SVC" "${SVC}.bak"
sed -i "s|^ExecStart=.*|ExecStart=${NEW_NODE_PATH} --env-file=.env.pod dist/server.js|" "$SVC"
systemctl daemon-reload
systemctl restart free-sleep
```

Check with `pstree -p $(systemctl show -p MainPID --value free-sleep)`. It
should show a single node process.

Undo: `cp ${SVC}.bak ${SVC} && systemctl daemon-reload && systemctl restart free-sleep`.

The pinned path includes the node version. If the version pinned in
`package.json` changes, run the snippet again to pick up the new binary.
Running `scripts/install.sh` again rewrites the unit with `npm run start`,
which removes the change.

### 4. Quieter access logging (in the repo)

Responses that succeed in under 250 ms are logged at `debug` rather than
`info`. The service runs with `NODE_ENV=production`, where the default
`LOG_LEVEL` is `info`, so only responses with status 400 or above and slow
responses are logged. See
[setup/requestLogging.ts](src/setup/requestLogging.ts). For verbose access
logs, set `LOG_LEVEL=debug` in `/home/dac/free-sleep/server/.env.pod` and
restart the service. The next update replaces that file.

### 5. Throttled presence-debug log (in the repo)

[`biometric_processor.py`](../biometrics/stream/biometric_processor.py) logs
`[presence-debug]` once a minute per side. `PRESENCE_DEBUG_LOG_INTERVAL_S`
changes the interval.

### Checking the results

```bash
# Available memory:
ssh -p 8822 root@<POD_IP> 'free -h | head -2'

# /persistent usage (journald capped at 100 MB; the RAW archive also lives here):
ssh -p 8822 root@<POD_IP> 'df -h /persistent | tail -1'

# Capybara should still be active (see change 2):
ssh -p 8822 root@<POD_IP> 'systemctl status capybara || true'

# Single-process node:
ssh -p 8822 root@<POD_IP> 'pstree -p $(systemctl show -p MainPID --value free-sleep)'
```
