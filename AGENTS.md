# Notes for working in this repository

These notes are a map of the code for anyone changing it, whether a person
or a coding agent. Read [CONTRIBUTING.md](CONTRIBUTING.md) as well, and read
[docs/EIGHT_SLEEP_PROTOCOL.md](docs/EIGHT_SLEEP_PROTOCOL.md) before changing
anything that talks to the hardware.

## Contributions written with coding tools

Contributions written with AI coding tools are welcome and reviewed like any
other. The person who opens the pull request is its author: they have read,
tested and understood it, and they answer for review feedback and for
anything it breaks. Saying in the pull request that a tool wrote part of it
helps the review of hardware-facing changes, but it does not change whether
the change is accepted.

The bar is the same however the code was written. This software controls a
bed that someone is sleeping on, so nothing should land that its author
could not explain line by line.

## Rules for every change

- Base work on `dev` and open pull requests against `dev`. Do not commit to
  or push `main`; it moves only when a release is cut.
- Add or update tests for the logic you change (see "Tests" in
  CONTRIBUTING.md).
- Before you report a change as done, run the checks in
  [Commands](#commands) for every package you touched, and say which ones you
  ran.
- `server/dist/` and `server/public/` are committed build output. Never edit
  them by hand. Rebuild them once at the end of a batch of changes, and as the
  last step of a release: `npm ci && npm run build:pr` in `server/` and `app/`,
  then remove the files `scripts/check-bundles.sh` lists, and commit.
- Commit messages follow Conventional Commits as described in
  CONTRIBUTING.md, with no trailers.
- Prisma migrations must be additive. Never drop or rename a column or table
  that an older, still-installable release reads; rollbacks run the older
  server against the newer schema.
- Do not run commands against a live Pod (SSH, deploy scripts, API calls that
  change state) unless the person you are working for asks for that specific
  action.

## What this repo is

- Nightstand is a local controller for Eight Sleep Pods. The server runs on
  the Pod's embedded Linux system and serves a local REST API and WebSocket.
  The app is a React and MUI web app served by the same server.
- The Pod hardware is controlled through a Unix socket called `dac.sock`.
  This repo calls that integration "Franken" or "Franken sock".
- Persistent user data lives under `/persistent/free-sleep-data/` on the
  Pod. Local development mirrors parts of it under `server/free-sleep-data/`.

## Layout

- `app/`: Vite React frontend using MUI, Zustand, React Query and Axios.
  Unit tests sit next to components; Playwright tests are in `app/e2e/`.
  Themes are in `app/src/design/themes/`.
- `server/`: Express TypeScript backend with LowDB JSON settings and
  schedules, Prisma SQLite for sensor data, node-schedule jobs, and Franken
  socket control. `server/prisma/` holds the schema and migrations.
  [server/API.md](server/API.md) documents every route.
- `biometrics/`: Python stream processing, sleep detection, vitals
  estimation and SQLite writes. Tests are in `biometrics/__tests__/`; see
  [biometrics/DEVELOPER.md](biometrics/DEVELOPER.md).
- `scripts/`: Pod install, update, rollback, reset, firewall and service
  scripts, the health check and watchdog scripts, and maintainer tools such
  as `promote_release.sh`, `release_digest.sh`, `check-bundles.sh` and
  `deploy-dev.sh`. `scripts/migrate/` holds the tool that switches a Pod from
  another free-sleep fork.
- `ops/`: LAN deployment (`deploy.sh`, `rollback.sh`) and the deployment and
  recovery notes in [ops/ANTIBRICK.md](ops/ANTIBRICK.md).
- `docs/`: screenshots, hardware teardown and install docs,
  [EIGHT_SLEEP_PROTOCOL.md](docs/EIGHT_SLEEP_PROTOCOL.md) (the
  reverse-engineered hardware protocol reference, see below),
  [CALIBRATION.md](docs/CALIBRATION.md) (the numeric constants behind
  presence, sleep detection and vitals, and why each has its value) and
  [TESTING.md](docs/TESTING.md) (what is tested and what is not).
- `releases.json` and `CHANGELOG.md`: the release list that installed Pods
  read, and the changelog. Both change only as part of a release, except for
  notes under `## [Unreleased]` in the changelog.

## Commands

Setup (the app imports schemas from `server/src`, so it needs the server's
dependencies too):

- `cd server && npm ci && npm run generate` (the Prisma client is needed for
  the server's build and tests)
- `cd app && npm ci`

Server, from `server/`:

- Typecheck without writing `dist`: `npx tsc --noEmit`
- Lint: `npm run lint`
- Test: `npm test` (`node:test`, files matching `src/**/*.test.ts`; one of
  them also runs the Python tests in `scripts/tests/`, so `python3` must be
  on the path)
- Build into `server/dist/`: `npm run build:pr`
- Local dev: `npm run dev:local`, after pointing `DATA_FOLDER` and
  `DATABASE_URL` in `server/.env.local` at your machine
- Hot reload on a Pod: `fs-dev-server`, per
  [server/README_SERVER.md](server/README_SERVER.md#hot-reloading-on-the-pod)

App, from `app/`:

- Typecheck: `npx tsc -b`
- Lint: `npm run lint`
- Test: `npm test` (Vitest)
- Build into `server/public/`: `npm run build:pr`
- Dev server against a Pod: `VITE_POD_IP=<pod-ip> npm run dev`
- Dev server with mock data and no Pod: `VITE_ENV=demo npx vite`
- End-to-end: `npx playwright install chromium`, then
  `npm run build:demo && npx playwright test`

Biometrics, from the repository root (CI runs Python 3.9 and 3.10):

- `pip install -r scripts/python/requirements.txt pytest`
- `python -m pytest biometrics/__tests__/`

## Runtime notes

- `server/src/config.ts` requires `DATA_FOLDER` and `ENV`. On the Pod,
  `npm start` supplies them from `server/.env.pod`.
- `server/src/jobs/jobScheduler.ts` schedules jobs at import time, once the
  system clock is valid, and watches the LowDB folder. A write to settings,
  schedules or `rhythmsDB.json` cancels and recreates every job; writes to
  other files there, such as `servicesDB.json`, are ignored.
- Schedules are stored in `schedulesDB.json`, settings in `settingsDB.json`,
  and service health in `servicesDB.json`, all in the LowDB folder.
  `alarm-ledger.json` in the data folder records which alarms were due, so
  one that could not ring is reported as missed.
- The app imports schemas directly from `server/src/db/*Schema.ts`, so schema
  changes must compile under both the app's and the server's TypeScript
  settings.
- The server does not apply Prisma migrations. `scripts/install.sh` and
  `scripts/update.sh` apply them with `prisma migrate deploy`.

## Scheduling code

There are two schedule engines, and only one runs at a time. `rebuildJobs`
in `server/src/jobs/jobScheduler.ts` picks one on every rebuild. Priming, the
daily restart, alarm overrides, one-time alarms and the end of a pause are
scheduled under either engine.

The weekly engine is the default:

- Client schedule state: `app/src/pages/SchedulePage/scheduleStore.tsx`.
- Schedule save payloads are assembled in
  `app/src/pages/SchedulePage/SchedulePage.tsx`.
- Server schedule writes: `server/src/routes/schedules/schedules.ts`.
- Scheduled jobs are created in:
  - `server/src/jobs/powerScheduler.ts`
  - `server/src/jobs/temperatureScheduler.ts`
  - `server/src/jobs/alarmScheduler.ts`
  - `server/src/jobs/primeScheduler.ts`
- Each scheduled power-on also gives the firmware an off time
  (`firmwareTimer.ts`): the scheduled off plus 5 minutes, or plus 8 minutes
  when an alarm is due just before it. The firmware turns the side off at
  that time even if the server is gone.
- Sleep analysis runs once a day at noon for each side.

The Rhythms engine runs named sleep plans (rhythms), a week that picks one
for each day, and date changes:

- Data: `rhythmsDB.json` in the LowDB folder, read and written through
  `server/src/db/rhythms.ts`, with its schema in
  `server/src/db/rhythmsSchema.ts`. The job watcher rebuilds on writes to it.
- Routes: `server/src/routes/rhythms/rhythms.ts`. App:
  `app/src/pages/SchedulePage/rhythms/` and `app/src/api/rhythms.ts`.
- Activation: `activation()` in `server/src/jobs/rhythms/activation.ts`. The
  engine is active only when `features.rhythms` is on, `rhythmsDB.json`
  exists, can be read and has a version this server knows, and its
  `legacyFingerprint` matches a hash of the weekly schedule
  (`fingerprint.ts`). Otherwise the weekly engine runs and
  `GET /api/rhythms` gives the reason. A fingerprint mismatch means
  something that does not know Rhythms, such as an older version after a
  rollback, changed the weekly schedule. The flag stays on and the app asks
  whether to go back to Rhythms or use the weekly schedule.
- Only `POST /api/rhythms/enable` and `POST /api/rhythms/disable` change the
  flag; `POST /api/settings` refuses that change with 409. The first enable
  converts the weekly schedule into rhythms (`convert.ts`) and creates the
  file. Later enables keep the saved rhythms and rewrite the fingerprint to
  the weekly schedule as it is now.
- A new install starts on Rhythms: `server/src/db/settings.ts` converts the
  default weekly schedule into `rhythmsDB.json` at the first start. A settings
  file without the `rhythms` key keeps it off, so existing Pods keep their
  engine.
- Jobs: `scheduleRhythms.ts` resolves sleeps (`resolve.ts`) 48 hours ahead
  as one-shot jobs named `rhythm-<side>-<date>-<kind>-<HHmm>-<n>`, and an
  hourly `rhythms-horizon` job extends that window. Each job runs through
  `runEvent.ts`, which applies the same away mode, pause, alarms-off and
  alarm override rules as the weekly jobs. Every power-on also sets
  `secondsRemaining`, so the firmware turns the side off 5 minutes after the
  sleep's end even if the server is gone.
- Each sleep is analyzed 15 minutes and 2 hours after it ends. A side keeps
  the noon analysis only when none of its sleeps ended in the 24 hours
  before that noon.
- Smart Schedule: the curve is in `server/src/db/smartCurve.ts`, shared with
  the app. `curveController.ts` and `curveRuntime.ts` follow it each minute
  and keep presence-confirmed cool-down starts and manual holds in memory
  only. Each finished Smart Schedule sleep adds a line to
  `rhythms-history.jsonl` next to the LowDB folder, kept for 90 days.
- "When I get up" (`smart.offWhenUp`): the rules are in `offWhenUp.ts` and
  `server/src/db/smartOff.ts`, and `smartOffRuntime.ts` runs them. A side
  turns off after 10 minutes out of bed, and no later than 3 hours past the
  set off time.

Turning Rhythms off and leaving this version both go through
`server/src/jobs/rhythms/handoff.ts`:

- `POST /api/rhythms/disable` plans each side from the running engine, then
  writes the flag off and any alarm override in one settings write, rebuilds
  the jobs and sends the device commands. A side running a Rhythms sleep is
  handed to the weekly night that covers now (the firmware timer is re-armed
  to that night's end), or kept on until the rhythm sleep's end with its
  remaining alarms held in memory (`keptAlarms.ts`), or powered off when the
  request asks for it. When the sleep's alarm already rang and the weekly
  night still has one ahead, that side's weekly alarms are switched off
  until the weekly night ends.
- Pre-stop handoff: `scripts/update.sh` (downgrades only),
  `scripts/rollback_pod.sh` and `scripts/switch-to-upstream.sh` call
  `POST /api/update/prepare-to-stop` just before they stop the server, after
  every check that could still abort them. The update and rollback scripts
  skip the Rhythms part when the version they switch to has that route, and
  skip the call entirely when that version also keeps the alarm record. The
  call runs the same plan without touching the flag. Older versions ignore a
  pause, so it also switches off a paused side's alarms for its coming
  weekly night when the last of them would still be paused. A failed call
  never stops the script; the firmware off time set at power-on is the
  backstop.
- `server/src/routes/update/update.ts` also ships in the updater overlay for
  stock installs, so it imports no Rhythms code. `server/src/setup/routes.ts`
  registers the handoff with `setLeaveHook` and the bed-in-use check with
  `setInUseCheck`.

Revert rules, so that an older version or upstream free-sleep keeps working
on data this version wrote:

- Never write new keys or objects into `schedulesDB.json`. Rhythms code
  never writes it at all, so turning Rhythms off brings back the weekly
  schedule as it was, with nothing copied back.
- Never delete or rename `rhythmsDB.json`. No script in `scripts/` names
  it (`server/src/rhythmsFileSafety.test.ts`), so backups and the switch to
  upstream leave it as it is.
- Keep runtime state out of watched files: use memory, the log or
  `rhythms-history.jsonl`.
- Readers of stored data ignore unknown keys; request bodies are strict.
- Never add a value to an enum field that older versions already read. New
  concepts go in new optional keys or in `rhythmsDB.json`.
- With `features.rhythms` off, the weekly engine, its jobs and their names
  behave exactly as before.

## Franken code

- Socket lifecycle: `server/src/8sleep/frankenServer.ts`
- Socket server wrapper: `server/src/8sleep/unixSocketServer.ts`
- Message parsing: `server/src/8sleep/messageStream.ts`
- Hardware command map: `server/src/8sleep/deviceApi.ts`
- Device status parsing: `server/src/8sleep/loadDeviceStatus.ts`
- `server/src/server.ts` connects Franken at startup; its health is reported
  through `server/src/serverStatus.ts`.

## Other subsystems

- Live updates to the app: `server/src/ws/wsServer.ts` (WebSocket at
  `/ws/events`), fed by `server/src/events/eventBus.ts`.
- Adjustable base control over Bluetooth:
  `server/src/8sleep/trimixBaseControl.ts`. It has not been tested with a
  base.
- Presence-based auto-off: `server/src/8sleep/presenceAutoOffMonitor.ts`.
- Missed alarms: `server/src/jobs/alarmLedger.ts`, read through
  `/api/alarms/missed`.
- Calibration status: `server/src/routes/calibration/`.
- In-app updates: `server/src/routes/update/`, which starts `scripts/update.sh`
  on the Pod through a systemd service. Update, rollback and the switch to
  upstream are refused while a side is on, an alarm is due within 15
  minutes, or the bed's state cannot be read, unless the request confirms
  it (`server/src/jobs/bedInUse.ts`).
- The systemd units and sudoers rules behind Update, Roll back, Switch to
  upstream, Reboot and the Biometrics switch, plus the health check and
  network watchdog timers, all come from `scripts/setup_services.sh`, which
  install, update and the fork switch run. A new control that needs sudo
  gets its rule there. `server/src/setupServicesScript.test.ts` fails if a
  `sudo` call in `server/src/jobs/` has no matching rule.
- Health check: `scripts/health_check.sh`, run every minute by
  `free-sleep-health.timer`, restarts a server that is running but has not
  answered three checks in a row.
- Watchdogs: `scripts/setup_watchdog.sh` turns on the hardware watchdog,
  only on a Pod 5 that matches the one it was checked on, and install,
  update and the fork switch run it once they succeed.
  `scripts/network_watchdog.sh`, run every minute by
  `free-sleep-network-watchdog.timer`, restarts the Pod when the stock Wi-Fi
  driver has died, and only while the hardware watchdog is on.
  [ops/ANTIBRICK.md](ops/ANTIBRICK.md) describes both.

## Hardware protocol and safety

- [docs/EIGHT_SLEEP_PROTOCOL.md](docs/EIGHT_SLEEP_PROTOCOL.md) is the
  reference for the `dac.sock` command table, `DEVICE_STATUS` fields, and the
  RAW biometrics record types (`frzHealth`, `frzTemp`, `bedTemp2`, and
  others). It is cross-checked against other independent reverse-engineering
  projects (8rp, sleepypod/core, opensleep, ninesleep), and each entry says
  whether it was verified on this project's hardware or taken from a source.
  Check it before assuming a command does what its name suggests.
- Read-only commands (`DEVICE_STATUS`/14, `HELLO`/0) are safe. State-changing
  commands are not: the Pod is a physical device that may have someone
  asleep on it. A command documented elsewhere is not verified until it has
  been tested on real hardware. For example, `STOP_PRIME`/17 is documented by
  8rp, but it did not interrupt an active prime when tested on a Pod 5, and a
  UI feature built on it was reverted. If you cannot test a hardware
  assumption safely, say so rather than shipping it unverified.
- Never open your own connection to `dac.sock`. The server is the listener
  on that socket and the Pod's firmware connects to it as a client, so an
  extra connection can be taken for the firmware's or can replace a pending
  firmware connection (see `handleConnection` in `unixSocketServer.ts`). Read
  state with `GET /api/deviceStatus` and send commands through the API
  (`/api/deviceStatus` or `/api/execute`), which use the server's managed
  connection.

## Review cautions

- Check timezone behavior with `moment-timezone`. The app sets a default
  timezone after settings load, and server jobs set `RecurrenceRule.tz`.
- Add tests or small reproductions around scheduling time math before
  changing job timing.
- Install and update scripts run as root or through sudo on an embedded
  Yocto-based system. Review them with that in mind.

## Code style

Carried over from free-sleep's own agent notes:

- Give complicated functions a short comment explaining what they do.
- Avoid obscure code and variable names of two characters or fewer.
- Avoid one-off hacks, and put new files and code where they belong in the
  existing structure.
