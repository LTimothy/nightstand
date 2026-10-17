# Testing

This page lists how Nightstand is checked: the automated tests, what CI runs
and when, what has been tried on a real Pod, and what isn't tested. I update
it at each release.

## Automated tests

The counts are approximate and change with every release. Each release's
notes link the CI run for its tag, with the exact results.

| Suite | Tool | About | What it covers | Runs on |
| --- | --- | --- | --- | --- |
| Server | node:test | 3,200 tests | Scheduling, Rhythms and Smart Schedule, alarms and missed alarms, the firmware's own off timers, the connection to the Pod's hardware, the API, the database and its migrations, suggestions from hand changes, and the shell scripts (below) | Node 24 |
| App | Vitest | 1,900 tests | Screens and flows against the same mock data as the demo | Node 24, jsdom |
| Biometrics | pytest | 800 tests | Presence, sleep records, calibration and the vitals estimators, with fixed inputs and pinned results | Python 3.9 and 3.10 |
| Browser | Playwright | 650 tests, plus 40 screenshot comparisons (24 theme, 16 layout) | The demo build at phone, tablet and laptop sizes | Chromium; WebKit for a subset |
| Scripts | node:test, Python unittest, shellcheck | included in the server count, plus 31 Python tests | Install, update, rollback, fork switch, reset, firewall, watchdog and health-check scripts, run against throwaway copies with the Pod's commands replaced | bash, Python 3 |

Python runs on 3.9 and 3.10 because those are the versions Pods use: 3.9 on a
Pod 3 set up with an SD card, 3.10 on the others.

### What the browser tests check

They drive the demo, which has no Pod behind it, in headless Chromium (and
a phone-size subset in WebKit). The main Chromium project uses Asia/Tokyo,
a time zone other than the demo's, so a check that only passes in Pacific
time fails there. The layout sweeps and WebKit use America/Los_Angeles.

- **Bed screen states.** 13 states of the Bed screen (on, off, cooling, at
  the warmest setting, at zero, waiting for you to get up, the same with a
  stale presence report, paused, away, in Fahrenheit, a change still saving,
  the Pod not answering, loading) at seven screen sizes, from a 320 pixel phone to a 1280 pixel laptop. Each keeps its
  controls where the "on" state has them, never scrolls sideways, and keeps
  every control at least 44 pixels each way.
- **Each look.** For each of the three looks in Settings > Bed and sides >
  Theme: Bed, Schedule, Sleep and Settings at phone and desktop width fit the
  screen and keep 44 pixel targets, Bed fits a 320 pixel phone, the research
  sheet fits, and fonts load from the app's own address. A further 24
  screenshot comparisons (three looks, four screens, two sizes) run only on
  Linux, in the same Playwright image CI uses, because fonts render slightly
  differently elsewhere.
- **Privacy.** While it opens the demo's screens and dialogs, a test fails if
  the app requests anything other than its own address and two files on
  GitHub: the release list and the changelog. Another checks that fonts and
  styles load without contacting any other site.
- **Flows.** Alarms and missed alarms, schedules and Rhythms, pausing,
  temperature, the update and roll back dialogs, keyboard use, logs and
  settings.

### What the script tests check

The scripts run as root on the Pod, so the tests run them on a computer
against throwaway folders, with commands such as `systemctl` and `iptables`
replaced by fakes that record what they were asked to do. They simulate the
failures the scripts must survive: an update killed partway through, a slow
restart, a full disk, a bad download, an interrupted swap of the old and new
versions, boot recovery with an update marker, competing operations taking
one lock, and a service that won't stop. The usual check is that the Pod is
left with one working version and its services running. Shellcheck also runs
over every script and fails CI on any error.

## What CI runs and when

[CI](https://github.com/LTimothy/nightstand/actions/workflows/ci.yaml) runs
on every pull request and on every push to `main` and `dev`. It runs:

- the server, app and Python tests (Python once on 3.9 and once on 3.10),
- the browser tests against a fresh demo build,
- lint for the server and app, and shellcheck for the scripts,
- a build of the server and app, and a check that the committed bundles
  match the source. Pods install those bundles, so on `main` a mismatch
  fails the run.

After each deploy of the [demo](https://ltimothy.github.io/nightstand/), a
separate smoke test opens the published demo at phone widths.

Every release from v3.0.1 to v3.5.1 passed all of its checks; I checked each
tag's results on GitHub.

## Running the tests yourself

From the repository root, with Node 24 and Python 3.9 or newer:

```bash
(cd server && npm ci && npm run generate && npm test)
(cd app && npm ci && npm test)
pip install -r scripts/python/requirements.txt pytest
python3 -m pytest biometrics/__tests__/ -q
python3 -m unittest discover -s scripts/tests
(cd app && npx playwright install chromium webkit && npm run build:demo && npx playwright test)
```

The app tests need the server's packages installed, because some screens
use the server's data checks. The screenshot comparisons skip themselves
off Linux. None of these commands contacts a Pod.

## Upstream switch publication gate

Before publishing any `upstreamSwitchV2` target, run the Linux VM checks
below, then an explicitly authorized hardware round trip. This section is
a procedure, not a test result. The VM interruption/reboot checks and the
hardware round trip remain pending. Do not publish V2 or record a validation
date until both stages pass. The publishing step is separate from an
ordinary release, as described in
[CONTRIBUTING.md](../CONTRIBUTING.md#publishing-an-upstream-switch-target).

### Linux VM interruption and reboot checks

Use a disposable Linux VM booted with systemd as PID 1, root access and a
console that works after the network is disabled. Keep it isolated from
Pods and the local device network. Take a VM snapshot before each case.
Stage the exact candidate artifact, the Nightstand build and a subsequent
upstream update locally, with their commits and digests recorded. Prepare
Node and Python dependencies before disconnecting the VM's network.

Start with the LowDB data in
`scripts/tests/fixtures/switch_lowdb.json` and the cases in
`scripts/tests/test_switch_installation.py`. Run the existing simulations
from the repository root as a prerequisite:

```bash
python3 -B -m unittest discover -s scripts/tests -p test_switch_installation.py
python3 -B -m unittest discover -s scripts/tests -p test_switch_startup.py
python3 -B -m unittest discover -s scripts/tests -p test_switch_services.py
```

These commands mock systemd and other host operations, even on Linux. They
do not test a real reboot or satisfy the VM gate. There is no real-systemd
VM runner yet. Adapting the fixtures needs more than a wrapper around these
commands:

- Create a `dac` user and the real `/home/dac/` and `/persistent/` layout
  inside the disposable guest. Replace the fixture's text-only code,
  database and Python executables with runnable artifacts, a SQLite database
  and separate permanent Python environments. Preserve absent-file cases.
- Install the generated recovery unit and startup drop-ins with
  `scripts/setup_services.sh`, using `--recovery-only` when installing only
  recovery. Use real systemd operation units named
  `free-sleep-revert.service`, `free-sleep-migrate.service` and
  `free-sleep-rollback.service`. `System.operation()` requires their real
  `InvocationID`, active state and maintenance lock. Running a transaction
  from an ordinary shell or a differently named transient unit is not enough.
- Replace `FixtureSystem` and `offline_recover()` mocks with real service
  stops/starts, user permissions, dependency preparation, migrations,
  effective unit inspection and both firewall families. Feed recorded sensor
  input to a device-free stream and provide a loopback server for status and
  handoff. Keep sustained readiness checks active; do not replace them with
  immediate success. Record which sensor processing paths the replay covers.
- Supply staged downloads through guest loopback or a guest-only download
  adapter so the installed upstream updater guard runs without external
  access. Do not substitute a successful return code for an upstream update.
- Add guest-only pause hooks around journal publication and each destructive
  mutation, based on the fixture's `--kill-fixture` hooks. Signal the VM
  console after the hook is reached and block until termination or reboot.
  Keep the hooks outside shipped code. Persist the case and boundary on disk
  so the console can collect results after reboot.
- Retain journals, snapshots, package hashes, unit definitions, service
  identities, firewall rules and logs across reboot. Compare them against
  the stopped source snapshot, including bytes, absence, ownership and modes.

Once that runner is available, run this sequence by hand from the VM
console. Repeat with Biometrics enabled and disabled, and with both baseline
files present, unknown provenance and one baseline absent:

1. Run an uninterrupted forward switch to the exact candidate. Check the
   converted settings, isolated upstream environment, updater guard and
   sustained readiness before accepting the committed journal.
2. Restore the VM snapshot and repeat forward switching with a pause before
   and after every journal publication and mutation. Include stopping
   writers, baseline quarantine, settings conversion, both tree renames,
   saving and publishing the venv, system reconciliation, validation startup,
   readiness, retained-slot publication and durable commit.
3. At each pause, test termination and reboot separately. For termination,
   use `sudo systemctl kill --kill-whom=all --signal=SIGKILL <operation-unit>`,
   then `sudo systemctl restart free-sleep-recover-switch.service` (the
   recovery unit uses `RemainAfterExit=yes`). Also test killing only the main
   process with `--kill-whom=main` so recovery must stop surviving descendants
   that hold the lock. For reboot,
   restore and rerun the case to that pause, then use `sudo systemctl reboot`;
   let the installed boot recovery run without invoking it by hand. Also
   reset the guest from the VM console at representative boundaries to test
   recovery without orderly shutdown or shell traps.
4. Before commit, require offline restoration of the complete source tree,
   settings, calibration files, environment mapping and system configuration.
   Incompatible writers must not start first. After commit, require only
   cleanup of the validated target. Repeat recovery to check idempotence.
   Check that a corrupt journal blocks writers, and that no journal permits
   ordinary startup. Check enabled and active service states separately.
5. From a successful forward switch, run the subsequent upstream update
   through its installed update unit using the staged artifact. Exercise
   interruption and reboot during that update, including replacement of its
   rollback slot. Recalibrate using replayed empty-bed input, including
   interruption/reboot while publishing baselines. Require a complete
   calibration set or an explicit unknown provenance status, without silent
   reuse of mixed or incompatible baselines. Edit the weekly schedule and add
   sleep history. Record the newer calibration and updater.
6. Return through the migration operation, then test cross-fork rollback in
   both directions and an ordinary Nightstand rollback. Repeat the precommit
   and postcommit interruption/reboot cases, including after activation of
   companion state and venv publication. A failed return must restore the
   current upstream installation and its newer calibration, updater and data.
   A failed rollback must restore the installation that was running when it
   began, with its companion state intact. Missing companion state must
   refuse cross-fork rollback before stopping services.
7. After a successful return, check intervening histories and weekly schedule
   edits, both saved calibration sets and their provenance, Rhythms data and
   fingerprint behavior, effective units and executable paths, firewall
   closure and watchdog configuration. Confirm that the upstream updater's
   `ExecStart` override is gone. A VM checks watchdog configuration only;
   hardware behavior still needs the next stage.

For each case, save the journal and `journalctl -b` output before resetting
the snapshot. Use `systemctl cat` and `systemctl show` to capture effective
units, `iptables-save` and `ip6tables-save` for active rules, and package
hashes plus `/home/dac/venv`'s resolved path for environment comparisons.
An HTTP response alone does not establish successful sensor processing.

### Hardware round-trip checklist

Run this only with explicit authorization, during the day on an unoccupied
Pod. Finish the VM gate first. Read
[EIGHT_SLEEP_PROTOCOL.md](EIGHT_SLEEP_PROTOCOL.md) before hardware work.

1. Arrange console or SSH recovery access that will remain usable after an
   upstream update. Copy the application, data, calibration and configuration
   backups off the Pod and verify a restore before switching. Record the
   starting Nightstand build, Pod model, firmware and observed sensor format.
2. Exercise both sides' controls, scheduled power and temperature changes,
   and alarm behavior on Nightstand. Record the schedules, histories,
   calibration provenance, effective units, firewall and watchdog state for
   comparison. Test Biometrics disabled and enabled as separate cases.
3. Switch to the exact upstream 3.0.3 candidate artifact. Check both-side
   controls, schedules and alarms, including the documented conversions.
   Confirm disabled Biometrics stays disabled. With Biometrics enabled,
   verify fresh successful sensor processing beyond startup, including the
   readiness window (at least 90 seconds uninterrupted runtime within five
   minutes), unchanged service identity and advancing processing records.
4. Run a subsequent upstream update and record its exact artifact. Repeat
   the controls and processing checks. Run empty-bed recalibration, then
   controlled occupied/unoccupied presence checks on each side. Keep the
   newer upstream calibration, add sleep history and make a weekly schedule
   edit that can be checked after return.
5. At representative precommit boundaries, test termination and controlled
   reboot with recovery access ready. Include after venv publication on the
   forward switch, and during return after upstream recalibration. Confirm
   complete source restoration before writers restart. Repeat the case from
   verified backups rather than continuing from an unexplained partial state.
6. Return to Nightstand through the SSH migration tool. Recheck both-side
   controls, scheduled power/temperature and alarms, disabled and enabled
   Biometrics, fresh processing and presence. Verify the intervening histories
   and schedule edits, both saved calibration sets and matching provenance,
   effective units, firewall closure and watchdog state. Record any failed or
   unexercised check; it does not count as a pass.

Keep a test record with dates, exact commits and tree digests for every
artifact, model, firmware, and the observed RAW or NATS format (or legacy
`capSense` input). Determine format from actual records, not the model name.
Include boundary names, termination/reboot method, calibration provenance,
logs, before/after comparisons and results for each step. Record limitations
and the actual validation date only after the complete gate passes.

A Pod 5 RAW pass does not validate NATS or legacy `capSense`. Those need
corresponding hardware coverage before claiming support. VM replay and
simulated tests do not replace that coverage.

## Hardware checks

CI can't test hardware. These tables record hardware checks and their limits.

| When | Pod | Version | What was checked | Result |
| --- | --- | --- | --- | --- |
| Since July 2026 | Pod 5 | each release | Nightly use by me, with two sleepers | in use |
| September 2026 | Pod 3 (SD card) | 3.3.1, 3.3.2, 3.5.1 | Fixes from one owner's reports in [issue #1](https://github.com/LTimothy/nightstand/issues/1) | only 3.3.1 confirmed by that owner |

### Checks on my Pod 5

I ran these checks on my Pod 5. I backed up the application and database to
my computer and rehearsed the restore before changing anything. These
results cover one Pod 5 only.

| Check | What happened | Remaining gap |
| --- | --- | --- |
| Each side on and off | Both sides followed the controls, including the final check. | Controls with an empty database were not run. |
| Update, downgrade, rollback and roll forward | Each completed on the intended install with settings and schedules intact. A wrong checksum was refused. | Install in the release list was partly covered: the downgrade used the app, while some update requests used the API, as the button does. An update from 3.5.1 cannot check a release checksum. |
| Rollback while a side is on | The server refused without confirmation, and the app showed the warning and cancelled without starting. | This did not exercise every update and switch warning. |
| Free-space refusals | With the required space raised for the check, updates refused on either partition and the switch to upstream refused on the data partition. | The disks were not filled. The fork switch itself was not run. |
| Server crash and hang | A killed server restarted within 15 seconds. The health check restarted a hung server. | One Pod 5. |
| Health check during an update or a deliberate stop | It left the server alone. | One Pod 5. |
| One-time alarm while the server was stopped | After restart, Nightstand reported the alarm as missed because it had not been running. | Other missed-alarm reasons have automated tests. |
| Firmware off timers with the server stopped | A Rhythms night and a weekly night turned the side off about 5 minutes after the scheduled off time. "When I get up" turned it off about 15 minutes after the scheduled off time. | The 12-hour timer for a side turned on by hand was not observed. |
| "When I get up" with someone in bed | The side stayed on while I was in bed and turned off after I got up. | One Pod 5. |
| Pause resume | Ending a pause during the night resumed the side under Rhythms and the weekly schedule. Ending a weekly pause early also resumed it. | Pause expiry outside the night has automated tests only. |
| Change pause | Changing the end saved once, with no power-on in between. | One Pod 5. |
| Alarm taps and dismissal reading | The firmware handled double and triple taps during an alarm without changing the gesture counters, so the configured alarm tap action had no effect. In a later check, a double tap stopped a Nightstand alarm, its `dismissAlarm` counter rose, and Nightstand cleared its ringing state and logged the dismissal. | Timestamp units remain unverified. This did not check the app's separate Dismiss command. |
| Boot recovery after an interrupted update | A reboot with no marker did nothing. A hand-set marker cleared after the health check. After a power cut a few seconds after the server stopped for an update, the previous install came back healthy; recovery ran once about 40 seconds after power returned and cleared the marker. | The cut landed before the tree move. A cut during the move itself is covered only by automated tests. The interrupted update recorded no result, so the app's last result stayed at the previous run. |
| Installer operation lock | The installer refused before downloading or changing anything while a test process held the operation lock. | The holder simulated a competing operation. |
| Operation lock after reboot | Boot recreated the lock file with the expected owner and permissions. | One Pod 5. |
| Biometrics service | The stream service followed the Biometrics setting, including after a server restart and reboot. | One Pod 5. |
| Weekly power logging | Power-on was logged by name for a weekly night. | Power-off logging has automated tests only. |
| `fs-reset` and data restore | Nightstand restarted with empty settings and Biometrics off, and read temperatures from the bed. I restored the data and checked the controls afterwards. | Controls on the empty database were not run. The stream's autostart needed enabling by hand after that restore; the later service reconciliation check passed. |
| Hardware watchdog | I checked setup, removal, persistence across a reboot and recovery from a deliberate freeze. The frozen Pod reset after about 34 seconds. | Setup ran by hand using the fallback for a kernel without watchdog sysfs. An update preserved a pre-existing watchdog setting; automatic arming from an off state was not checked. |
| Overnight health after the checks | The schedules and services were healthy the next morning, with no missed alarms. | One Pod 5. |
| Network watchdog Wi-Fi recovery | Not exercised. | Whether a restart restores Wi-Fi remains unconfirmed. |
| Switch to upstream free-sleep and back | Not run. | The fork switch and migration tool still have only simulated runs for the full switch. |

The update checks used a local HTTPS test proxy serving the release
candidate and older releases. They checked the update logic, not the public
GitHub download path, redirects or caching. The proxy and its test
configuration were removed afterwards.

### Not tested on hardware by me

Pod 3, Pod 4 and Pod 6, any adjustable base, and newer firmware that writes
sensor data only to a local stream.

## How a release becomes stable

A release starts on the beta channel and runs on my own Pod 5 before I mark
it stable. A change for another model is confirmed by an owner of that model
or marked unconfirmed in the changelog.

## Known gaps

- I have no Pod 3, Pod 4 or Pod 6. Changes for them are checked only by the
  tests here and, sometimes, by an owner.
- I have no adjustable base. The app's base screen is tested against the
  demo, but the server code that talks to a base has no tests of its own.
- The [hardware checks](#checks-on-my-pod-5) cover one Pod 5 and the cases
  listed. The remaining script failure paths are checked on copies on a
  computer, with the Pod's commands replaced.
- The firewall script is checked for the rules it writes, not with real
  network traffic.
- Browser tests run in Chromium, and a phone-size subset plus the layout
  check also run in WebKit (Safari's engine). Firefox isn't tested, and the
  browser tests use the demo's mock data, not a live Pod.
- Whether a network watchdog restart brings the Pod's Wi-Fi back isn't
  confirmed. The app's separate Dismiss command for a ringing alarm has
  not been confirmed by these hardware checks.
- The Biometrics tests check that the code does what it was designed to do
  with fixed inputs. Whether its numbers are right is a separate question,
  covered in [VALIDATION.md](VALIDATION.md). The newer vitals estimators'
  memory and CPU use was measured on a computer, not on a Pod.
- Few people run Nightstand, so the lack of problem reports says little.
