<p align="center">
  <img src="docs/free-sleep-icon-rounded.svg" width="88" alt="Nightstand">
</p>

<h1 align="center">Nightstand</h1>

<p align="center"><b>Local control for Eight Sleep Pods, without the Eight Sleep app or membership.</b></p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/LTimothy/nightstand/releases/latest"><img src="https://img.shields.io/github/v/release/LTimothy/nightstand?label=stable" alt="Newest stable release"></a>
  <a href="https://github.com/LTimothy/nightstand/releases"><img src="https://img.shields.io/github/v/release/LTimothy/nightstand?include_prereleases&label=beta" alt="Newest release, including betas"></a>
  <a href="https://github.com/LTimothy/nightstand/actions/workflows/ci.yaml"><img src="https://github.com/LTimothy/nightstand/actions/workflows/ci.yaml/badge.svg?branch=main" alt="CI"></a>
</p>

<p align="center">
  <img src="docs/hero.png" width="800" alt="The Bed, Schedule and Sleep screens of the Nightstand app, with sample data">
</p>

Nightstand runs on the computer inside an Eight Sleep Pod and gives you
temperature control, schedules and optional sleep estimates from a browser on
your home network. It's a personal fork of free-sleep (see
[Credits](#credits)), and I run it on my own Pod 5, the only model it has
been [tested on](#what-has-been-tested).

[Try the demo](https://ltimothy.github.io/nightstand/): every screen of the
app with sample data, following the published release.

Nightstand is not affiliated with, endorsed by, or supported by Eight Sleep,
Inc. "Eight Sleep" and "Pod" are used only to identify compatible devices.

## Before you install

Nightstand comes with no warranty (see [License](#license)).

### Going back

- There is no tested way back to Eight Sleep's software on a Pod 5. Eight
  Sleep's support page gives a reset for Pod 2 through Pod 5
  ([steps](INSTALLATION.md#going-back-to-the-eight-sleep-app)). I expect it
  to work, but I haven't tried it after an install and haven't found anyone
  who has, and I haven't tried the Pod 3 and Pod 4 steps either. If the Pod
  stops booting, the serial cable gives you a root shell to repair it. That
  doesn't restore Eight Sleep's software, and neither does switching to
  free-sleep.
- INSTALLATION.md says what each step changes on the Pod. From 3.6.0 the
  installer keeps a copy of each original system file it changes, and
  [What installation changes on the Pod](INSTALLATION.md#what-installation-changes-on-the-pod)
  says how to put them back. Undoing those changes hasn't been tried on a
  Pod 5.

### What you give up

- A first install means opening the Pod's case, which Eight Sleep doesn't
  support and a firmware reset can't undo. It may affect your warranty and
  conflict with Eight Sleep's terms, so read both before you start.
- While Nightstand is installed, the Eight Sleep app, its membership
  features and firmware updates don't work on this Pod. Your account and
  membership continue until you change them with Eight Sleep. Some
  memberships include warranty coverage, so check yours first.

### What to expect

- Few Pods run Nightstand, so a lack of problem reports means little.
- Update, rollback, reset and boot recovery checks have run on my Pod 5,
  with gaps noted in the [testing guide](docs/TESTING.md#hardware-checks).
- The web app has no login. Any device that can reach the Pod can control
  it, read its sleep data, and install, roll back or replace its software.
- Eight Sleep's firmware still runs underneath and can upload raw sensor
  recordings to Eight Sleep unless you set up the optional firewall rules
  ([installation step 19](INSTALLATION.md#19-add-firewall-rules-to-limit-internet-access),
  which also says when Nightstand adds them or briefly lifts them).
- Alarms are vibration only and ring only while Nightstand is running.
  Scheduled alarms need the side on; a snoozed alarm rings even if the side
  was turned off. If Nightstand is stopped, restarting or updating, or the
  Pod doesn't answer within 3 minutes, the alarm is missed and the app shows
  which one and why. Away mode and a paused schedule skip alarms without a
  notice, so keep another alarm until you trust your setup.
- A fresh install gets the newest release, often a beta, and stays on that
  channel until you choose Stable in Settings > Software.
- Sleep data are estimates from bed sensors, not medical measurements.

## If something goes wrong

### What does the bed do if Nightstand stops?

The Pod keeps each side at its last temperature and turns it off by itself a
few minutes after the scheduled off time. A side using
["When I get up"](#smart-schedule) goes off about 15 minutes after its
scheduled off time, or within about 15 minutes of Nightstand stopping if it
is already being kept on past it (at the latest off time while its schedule
is paused). One turned on by hand goes off after 12 hours. Temperature
changes and alarms stop until Nightstand is back.

Nightstand restarts itself if it crashes or stops answering. On a Pod 5 it
also sets up watchdogs that restart the Pod if its system freezes, or if the
stock Wi-Fi driver has crashed and the network stays down
([how and how often](INSTALLATION.md#13-install-the-nightstand-server)).
Whether a restart brings Wi-Fi back isn't confirmed yet. Other models are
left as they are.

### What happens if an install fails?

Updates and fork switches keep backups and try to restore the previous
version when startup fails. After a power loss during an update swap,
Nightstand makes one recovery attempt 45 seconds after boot, keeping a
healthy live install or trying to restore the marked previous version
([details and limits](ops/ANTIBRICK.md#what-is-backed-up-and-checked)). If the app still
loads, you can go back a version in Settings > Software. If automatic
recovery fails and the app does not load, recovery needs SSH
([step 18](INSTALLATION.md#18-add-an-ssh-config)) or the serial cable. A
failed first install has no earlier version to fall back to, so it needs
SSH or the cable too. On a Pod 3 or Pod 4 a
[firmware reset](INSTALLATION.md#going-back-to-the-eight-sleep-app) is the
last resort.

Automated tests simulate interrupted updates, slow restarts, full disks and
bad downloads. On my Pod 5, a bad checksum was refused, and update,
downgrade, rollback and reset-and-restore checks passed. After a power cut
a few seconds after the server stopped for an update, it came back healthy
on the previous install and cleared the recovery marker. A cut during the
tree move itself is covered only by automated tests. Some update requests
used the API, as the Install button does. These checks cover one Pod 5,
not every simulated failure above.

### Where can I get help?

Report problems here, not to free-sleep, which isn't responsible for this
fork. [Open an issue](https://github.com/LTimothy/nightstand/issues) with
your Pod model, Nightstand version and what happened. Include
[`fs-debug`](INSTALLATION.md#nightstand-shortcuts) output if you can, minus
personal and network details.

## What has been tested

| Pod | What to expect |
| --- | --- |
| Pod 5 | I have used it nightly since July 2026. |
| Pod 3, Pod 4 | Supported by free-sleep, not tested with Nightstand. |
| Pod 1, Pod 2 | Not supported. |
| Pod 6 | Unknown. |

One Pod 3 owner's reports led to three fixes; only the first is confirmed
on that Pod. The adjustable base controls are untested, because I have no
base. Biometrics has been tested only on one Pod 5 and checked against one
public dataset.

I write much of the code with AI coding tools; each change passes the tests
below and a separate review before it lands, and I decide what ships.
Releases start on the beta channel and run on my own Pod 5 before I mark
them stable.

The automated tests run the update, rollback and reset scripts through the
simulated failures above. Roughly 2,200 server tests, 1,700 app tests and
800 Biometrics tests, plus more than 200 browser checks against the demo
build. [CI](https://github.com/LTimothy/nightstand/actions/workflows/ci.yaml)
(GitHub's automatic checks) reruns them on every pull request and push, and
its history is public. [docs/TESTING.md](docs/TESTING.md) lists the tests
and the known gaps.

## Installing

Follow **[INSTALLATION.md](INSTALLATION.md)**. You need a Mac or Linux
computer, some comfort with a terminal and, except on a Pod 3 with an SD
card, a serial cable (about $70 in parts). On another free-sleep fork
already? [Coming from free-sleep](docs/COMING_FROM_FREE_SLEEP.md) covers
switching without reinstalling, and going back.

Once installed, the app is at `http://eight-pod.local:3000` (or
`http://<POD_IP>:3000`). The origin check also accepts bare hostnames and
names ending in `.lan`, `.home.arpa` or `.internal`. A Tailscale MagicDNS
name ending in `.ts.net` is accepted when it matches the hostname used to
reach the Pod. Keep the Pod on a trusted network and do not expose it to
the internet. For access away from home, see
[remote access with Tailscale](docs/REMOTE_ACCESS.md).

For Home Assistant, Homebridge and scripts, see
[Integrations](docs/INTEGRATIONS.md) for compatibility limits, API request
shapes and how to disable Homebridge's keepAlive, which overrides the Pod's
scheduled off timer with a new 12-hour timer.

## Features

- Temperature in °F, °C or the Eight Sleep app's -10 to +10 scale, plus
  away mode, LED brightness and adjustable base control (untested)
- Schedules for power, temperature, priming and vibration alarms, with a
  one-side pause. Rhythms (beta, off by default): named plans per side, a
  week that assigns one to each day, and single-date changes
- Sleep data (see [Biometrics](#biometrics)): time in bed (measured); heart
  rate and, with New sleep tracking, breathing rate (estimates)
- Firmware target, Firmware health and Tap diagnostics show the firmware's
  thermostat targets, selected health messages and button/tap candidates
  on System status. Cooling warning reports water warming during cooling
  demand. These Settings > Features switches are all off by default, need
  Biometrics and do not send hardware commands
- Cover buttons, for a Pod 4 hub with a Pod 5 cover, whose firmware ignores
  short clicks on the cover's plus and minus buttons: each ignored click
  steps that side by 1 F, 15 to 25 s later. Off by default under
  Settings > Features and does not need Biometrics. A Pod 5 hub handles
  its buttons itself, so it does nothing there
- Three themes under Settings > Bed and sides > Theme, saved on each device:
  lamp (the default), free-sleep classic and jmew. The last two
  follow the original free-sleep app by throwaway31265 and jmew's fork of it

Presence auto-off is on by default but needs Biometrics, which is off by
default. It turns a side off after 45 minutes with nobody on it, outside its
scheduled on hours.

With daily priming on, the Pod also restarts an hour before each prime, as
free-sleep does (the switch is under Settings > Bed and sides > Priming).
System status reports when the daily prime was not confirmed and warns
when clock synchronization is unavailable or reports an unsynchronized clock.

### Smart Schedule

Smart Schedule sets a rhythm's temperatures: comfortable when you lie down,
a little cooler once you have settled in bed, and warming gently before your
wake time. It doesn't learn from your sleep or change the curve from night
to night. With Biometrics on, its only input is whether you are in bed,
which starts the cool-down once you have been in bed for 20 minutes, but not
before bedtime and never later than two hours after it.

A rhythm can also turn a side off "When I get up": about 10 minutes after
you get up, and no later than 3 hours past the scheduled off time.

Both rely on presence, which in a shared bed can mistake the other sleeper
for you. The [timings](docs/VALIDATION.md#smart-schedule) are my own
estimates, and the studies under "The research behind it" in the app didn't
test this curve. It is not medical advice.

## Biometrics

Biometrics is off by default. Install it once on the Pod with the command
below, then turn it on in Settings > Features.

```bash
sh /home/dac/free-sleep/scripts/enable_biometrics.sh
```

Nightstand keeps its sleep data on the Pod ([server/API.md](server/API.md));
the firmware's own uploads are covered under
[Before you install](#before-you-install).

Settings > Features has Low-disk protection (on by default), which deletes
old detailed vitals below 150 MiB free, and Prune detail after 30 days (off
by default). Both keep at least the last two nights of detail, nightly
summaries, sleep records, scores and movement. Pruning makes database pages
reusable; it does not shrink the file, and deleted detail cannot be restored
([metrics retention](docs/METRICS_RETENTION.md)). Sleep reads default to
90 days; the app can still browse older weeks.

### Accuracy

Upstream free-sleep compared its heart-rate estimate with reference devices,
mostly Apple Watches, over 33 nights from six people
([details](biometrics/BIOMETRICS.md#upstream-heart-rate-comparison)).
Nightstand's estimates have been checked only against a public dataset
(Li et al., 2024: 22 healthy young adults sleeping alone on a different
under-mattress sensor, with chest straps and breathing belts as the
reference). On that dataset (bpm is beats per minute):

| | Old tracking (the default) | New sleep tracking |
| --- | --- | --- |
| Heart rate | off by about 2.8 bpm on average | off by about 1.3 bpm, with a value for fewer minutes |
| Breathing rate | no better than a fixed guess, so hidden | off by about 0.4 breaths per minute |

Nobody has worn a reference device on my Pod, and in a shared bed one side
can pick up the partner's heartbeat. HRV (heart rate variability) isn't
shown because neither estimate was accurate enough on that dataset, and
deep sleep and REM aren't shown because they haven't been compared with any
reference, and time asleep isn't shown because the rule for when you fell
asleep was wrong on most nights I checked
([why](biometrics/BIOMETRICS.md#how-accurate-it-is)). The sleep score
isn't shown for now: without an estimate of time asleep it only reflected
time in bed and trips out of bed.
[docs/VALIDATION.md](docs/VALIDATION.md) has the details.

### New sleep tracking (beta)

With old tracking, the vibration sensor picks up both sleepers, so one
person getting in or out can show up on both sides. On a Pod 5 whose cover
writes the newer capacitance records, this setting reads the capacitance
sensor under each side instead, which responds mainly to the person on it.

I checked it over seven nights on one Pod 5 with two sleepers, against notes
each sleeper kept of when they got into and out of bed. Its times were
within 9 minutes of the notes on every night but one, a morning the bed was
still in use, where they were 27 minutes apart
([details](biometrics/BIOMETRICS.md#how-the-new-sleep-tracking-was-checked)).

<p align="center">
  <img src="docs/presence-before-after.png" width="720" alt="Before and after: vibration and capacitance readings for each side, and when each side read as occupied under the old and new tracking">
</p>

One of those nights, old tracking against new. The labels come from New
sleep tracking, not from the notes.

Elsewhere, including on a Pod 5 with the older records, the setting is
experimental and hasn't been checked against anyone's sleep
([details](biometrics/BIOMETRICS.md)).

## Updating

Use Settings > Software, which also has the channel picker, or `fs-update`
on the Pod.

From 3.6.0 on, the updater checks each download
against the checksum (a fingerprint of the file) published for it in the
release list, when one is published, using the installed copy; every release
I offer has one. That catches a corrupted or swapped download, but not a
compromised GitHub account. The update from 3.5.1 or earlier to 3.6.0 is not
checked, because those versions have no checksum step.

Updating from 3.5.1 or earlier also needs more than 1,500 MB free on `/`
and more than 2,000 MB on `/persistent`, because those versions' updaters
check for that before they download anything. A Pod with less room can't
take the update through the app or `fs-update`.

Schedules and alarms pause for up to 5 minutes while Nightstand restarts,
so the app asks first if a side is on or an alarm is near
([details](INSTALLATION.md#nightstand-shortcuts)). The updater's checks
after a restart are basic, so try your usual controls afterwards.

Rolling back restores the previous version's code and its firewall rules,
which may be looser, but not an earlier database or Eight Sleep's firmware.
Installing another release replaces the rollback copy.

## FAQ

### What does Nightstand send to the internet?

- Nightstand has no error reporting or analytics. The app fetches only the
  release list and changelog from GitHub
  ([a browser test](app/e2e/privacy.spec.ts) on the demo build checks this).
- Installs and updates download from GitHub and npm, Node through Volta and,
  for Biometrics, Python packages from PyPI. The installer also reads the
  time from google.com.
- With the firewall rules on, only time sync, name lookups and update
  downloads get out
  ([step 19](INSTALLATION.md#19-add-firewall-rules-to-limit-internet-access)).
  With Tailscale running, HTTPS, name lookups and UDP to any server are
  allowed, Eight Sleep's included.

### How do I start over?

`fs-reset` on the Pod erases Nightstand's settings, schedules and sleep data
but keeps its backups and the firmware's own raw recordings.
[INSTALLATION.md](INSTALLATION.md#nightstand-shortcuts) says where, so you
can delete them too.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests go to the `dev` branch.

## Credits

Nightstand is a fork of [jmew/free-sleep](https://github.com/jmew/free-sleep),
which builds on the original
[throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep)
(upstream free-sleep in these docs). Most of the code here is theirs:
upstream built the installer, server, app and biometrics pipeline, and
jmew's fork added presence detection, sleep stages, one-time alarms,
adjustable base control and live screen updates.
Matt Gates ([@Geczy](https://github.com/Geczy/free-sleep)) originally wrote
the adjustable base control that jmew's fork carried
([driver](https://github.com/Geczy/free-sleep/commit/74d6439c0fffbd634e3b84ec054cb52d741eddab),
[angle maps](https://github.com/Geczy/free-sleep/commit/fccb7916fbf3f8f1e0da4324de57bdf1a1fe12a4)).
These are the main-branch copies of the patches credited in 3.6.1. His
[preset integration](https://github.com/Geczy/free-sleep/commit/c17cb0866489889b2230f698e99eb74184c15623)
also includes the HTTP route, app API client and four-tap base action.
Multiple alarms per night came from
[SFenton's fork](https://github.com/SFenton/free-sleep), and `sensorTemps`
came from Felix Sommer's [Beat2er fork](https://github.com/Beat2er/free-sleep).
[@bobobo1618](https://github.com/bobobo1618) worked out how the Pod is
controlled through `dac.sock`. Other contributions are credited in the
[changelog](CHANGELOG.md).

## Related projects

- [sleepypod](https://github.com/sleepypod/core): local control with a web and [iOS](https://github.com/sleepypod/ios) app.
- [Lunaris](https://github.com/Schluggi/lunaris): Pod firmware built around Home Assistant and MQTT.
- [hass-free-sleep](https://github.com/Mrtenz/hass-free-sleep): a Home Assistant integration for free-sleep.

## License

MIT, the same terms as upstream free-sleep. [LICENSE.md](LICENSE.md) has the
full text and upstream's disclaimer. There is no warranty.
