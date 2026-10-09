# Changelog

Notable changes to Nightstand, in its own version stream starting at 3.0.0
(see [CONTRIBUTING.md](CONTRIBUTING.md) for how versions get bumped). Nightstand
is a hard fork; for the history of the projects it descends from, see
[jmew/free-sleep](https://github.com/jmew/free-sleep) and
[throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep).

## [Unreleased]

### Cover taps

- Two taps that arrive in the same 2 s read now step one after the other,
  each from the target the one before it wrote, and a tap after a read that
  still carries the old target steps from the written one. Before, both
  stepped from the same read's target and the second write undid the first.
  Seen on a Pod 4 hub with a Pod 5 cover by @2-X, where the newer host
  firmware reports a held cover button as a tap.
- Settings > Features has a new Cover buttons switch, off by default. It is
  for a Pod 4 hub with a Pod 5 cover, whose firmware ignores short clicks on
  the cover's plus and minus buttons. With it on, Nightstand reads those
  ignored clicks from the Pod's RAW files and steps that side by 1 F per
  click. A click can take 15 to 25 s to apply, because the firmware writes
  its log in batches. A Pod 5 hub handles its buttons itself, so the switch
  does nothing there. By @2-X.

### Alarms

- Dismiss sends a one-second replacement only to the side reported or
  tracked as ringing, without the unscoped clear that could stop a partner's
  alarm. Alarms started through `/api/execute` are tracked too. Checked in
  tests; replacement-only dismissal and partner isolation still need a
  hardware check on Pod 4 and Pod 5.
- A raw `ALARM_LEFT` or `ALARM_RIGHT` sent through `/api/execute` with a
  target time (`tt`) in the future is now refused with `400`, because only
  an alarm that rings at once can be tracked for dismissal.
- The app keeps a separate dismissal latch for each side, so dismissing one
  side's alarm no longer hides the other side's dismissal dialog.
- The "Builds up" (`rise`) pattern now needs both a Pod 5 hub and a Pod 5
  cover, because the vibration firmware runs on the cover. Mixed, older or
  unknown hardware uses `double`. This change has not been checked on hardware.

### Updates and recovery

- Boot recovery now records the outcome of an interrupted update, including
  server or Biometrics restart failures, so Settings shows that recovery's
  result instead of the previous update's result.
- An open tab whose page files disappeared after a reinstall now reloads
  once after a failed page load, at most once every five minutes per tab.
  If browser storage is unavailable, it does not attempt the reload.
- Switch to upstream still installs the pinned pre-3.0 upstream commit
  `ca7dc543`, with the same steps and wording as before. The Versions page
  now sends the exact target it showed, and the switch refuses a target that
  changed in the meantime. Groundwork for switching to upstream 3.0.x is in
  place but not offered yet: it records each switch, return and cross-fork
  rollback as a transaction that a power cut can finish or undo at boot,
  keeps upstream's Python environment separate, and records where each
  calibration came from. With no switch journal on the Pod, none of this
  runs at startup. The newer target is published only after the checks in
  [TESTING.md](docs/TESTING.md#upstream-switch-publication-gate) pass on a
  VM and on hardware.

### Network and security

- Browser controls and WebSocket updates now accept bare hostnames and names
  ending in `.lan`, `.home.arpa` or `.internal`, alongside `.local`. A
  Tailscale `.ts.net` origin must match the hostname used to reach the Pod;
  other `.ts.net` sites are not allowed by that rule.
- The firewall now rejects blocked outbound traffic so programs fail
  without waiting for a timeout, with a checked drop-rule fallback if
  rejection is unavailable. It also allows local-link IPv6 router and
  neighbour discovery, needed for IPv6 connectivity, DNS and time sync.
  Recovery restores the normal output policy only after terminal blocks
  are in place. Checked in tests; firewall behavior after a reboot still
  needs a hardware check.
- SSH setup now uses the built-in SFTP server, so file transfers do not
  depend on an external `sftp-server` binary that some Pods lack.

### Installation and fork migration

- The installer checks for a Wi-Fi profile and password salts reported in a
  shared prebuilt SD image. It offers to remove the profile and change the
  affected accounts' passwords, with separate consent for each. Without an
  interactive terminal, it changes neither.
- Coming from another fork now stops before changing anything if the data
  contains a single schedule per side or dated away settings that Nightstand
  cannot use. The message explains what needs changing in the current fork.
- Coming from another fork now checks for firewall-opening cron jobs and
  an ambient-light service, backs them up and requires consent to remove
  them. It stops services it does not own before the database checkpoint.
  Failure to restore those files does not block the remaining recovery.
  Installs and updates also warn about the cron jobs without editing them.
  These migration changes have not been checked on a Pod.

### Firmware readouts

- Settings > Features > Firmware target, off by default, shows each side's
  thermostat target from firmware records on System status. It needs
  Biometrics. This is separate from the app's temperature scale and from
  measured water or mattress temperature; saved temperatures and command
  conversions keep their existing convention.
- Settings > Features > Firmware health, off by default, shows selected
  firmware messages about pumps, sensors, storage and connections on
  System status. It needs Biometrics; raw firmware log text stays local.
- Settings > Features > Tap diagnostics, off by default, lists button and
  tap candidates on System status with an export. It needs Biometrics and
  does not trigger actions. Button records alone do not prove a cover tap
  or a temperature change.
- Settings > Features > Cooling warning, off by default, reports when
  measured water keeps warming while cooling is requested. It needs
  Biometrics and does not send a hardware command. The warning is a sensor
  observation, not a diagnosis of a failed component.

### Sleep data and retention

- The RAW reader now reads every record in bundled payloads and keeps
  incomplete tails for the next pass. After a corrupt record, the live
  reader finds the next complete record and logs the skipped bytes instead
  of retrying the same offset until a newer file appears. It does not skip
  a partial record still being written at the live file's end.
- Settings > Features > Low-disk protection is on by default and checked
  daily, even with Biometrics off. Below 150 MiB free, it deletes the oldest
  detailed vitals in bounded batches, aiming for 16 MiB of reusable SQLite
  pages while keeping at least the last two nights of detail per side.
  It saves each night's vitals summary before deleting any of its detail.
  Sleep records, scores and movement are kept. Pruning does not shrink the
  database file or run VACUUM.
- Settings > Features > Prune detail after 30 days is off by default. It
  deletes detailed vitals older than 30 days with the same recent-night
  protection and saved summaries. The Sleep page uses those summaries when
  detail is gone. Deleted detail cannot be restored by rollback; turning
  either switch off stops future deletions. See
  [metrics retention](docs/METRICS_RETENTION.md) for the limits.
- `/api/metrics/sleep` and `/api/metrics/vitals/summary` now default to the
  last 90 days when no range is given, instead of reading every recorded
  night. Explicit ranges and older-week browsing still work, and the app
  keeps the latest recording visible while a newer night is being analysed.

### System status

- System status now warns when clock synchronization is unavailable or the
  clock is not synchronized. Schedules still arm once the system year is
  plausible, so the warning does not stop jobs from running.
- The daily prime now checks the Pod's priming state after 30 seconds and
  reports a failure on its status row if priming was not confirmed.
- Status polls within 15 seconds share one snapshot, measured with a
  monotonic clock. The status check writes stream health to disk only when
  it changes, reducing work from integrations that poll frequently.

### Integrations

- Legacy single-`alarm` schedule writes now edit only the first alarm and
  preserve later alarms, instead of replacing the day's whole list.
- The new [integration guide](docs/INTEGRATIONS.md) covers Home Assistant,
  Homebridge and scripts, including client compatibility limits, request
  shapes and Rhythms falling back after a weekly-schedule write. It explains
  how to turn off Homebridge's keepAlive, which resets the Pod's scheduled
  off timer to 12 hours. Compatibility checks use source inspection and
  local route tests, not live integration or hardware sessions.

### Adjustable base

- Adjustable-base parsing now strips bracketed tags and MAC addresses from
  `bluetoothctl` lines before reading notification bytes. Checked in tests;
  the base controls remain untested on a physical base.

### Docs

- The protocol notes now distinguish the app's temperature convention from
  fourteen firmware level-to-target pairs observed in my Pod 5's offline
  captures. They also record bundled RAW shapes, missing readings, buttons,
  socket framing, alarm and recovery reports, mixed hardware and conflicting
  generation thresholds. Reports from other owners remain marked as
  unverified here; detection thresholds do not change.

### Credits

- Cooling warning thresholds follow ideas from GoogleBot42/podd, reimplemented
  without copying code ([first change](https://github.com/GoogleBot42/podd/commit/3268bdbe379211c6b0e4c5fb88ef25d8e16b8560),
  [follow-up](https://github.com/GoogleBot42/podd/commit/ed91118e7d92573dad5b3ae7b16e3ddb98a2cfa7)).
  The prime check and per-side dismissal latch also follow that fork's
  ideas ([prime check](https://github.com/GoogleBot42/podd/commit/cc0eaea),
  [dismissal latch](https://github.com/GoogleBot42/podd/commit/e36e4d4)).
- RAW recovery follows ideas from
  [onemec/free-sleep](https://github.com/onemec/free-sleep/commit/e3511ab096554a6d60a83e00f69c1a8c26325dc8),
  [onemec's follow-up](https://github.com/onemec/free-sleep/commit/c5a5dafd5c6eda6035f513695524617d83e446dd)
  and [SFenton/free-sleep](https://github.com/SFenton/free-sleep/commit/f768fc807d8ecd90e4ad8253e1c74229ddd5be58),
  reimplemented here.
- Retention tiers and local hostname support follow ideas from jmakes/free-sleep
  ([retention](https://github.com/jmakes/free-sleep/commit/8769af4161d73bbf8afdb1747b8b81358dc5eaa8),
  [hostnames](https://github.com/jmakes/free-sleep/commit/407814ca88bf81cbea5751bd85df5d56ec5d8dd7)).
- The replacement-alarm approach follows caseyWebb's Pod 3 report in
  [throwaway31265/free-sleep issue 54](https://github.com/throwaway31265/free-sleep/issues/54).
  The pattern restriction follows caseyWebb's
  [rise report](https://github.com/throwaway31265/free-sleep/issues/55) and
  [LiamSnow/opensleep's mixed-cover notes](https://github.com/LiamSnow/opensleep/issues/12).
- Integration guidance covers
  [Mrtenz/hass-free-sleep](https://github.com/Mrtenz/hass-free-sleep/commit/ddf0c5e),
  [DaSonOfPoseidon/free-sleep-ha](https://github.com/DaSonOfPoseidon/free-sleep-ha/commit/b390441),
  [NylonDiamond/free-sleep-hacs](https://github.com/NylonDiamond/free-sleep-hacs/commit/d6328cc)
  and [caseyWebb/homebridge-free-sleep](https://github.com/caseyWebb/homebridge-free-sleep/commit/8f92a83).
  The keepAlive warning comes from
  [caseyWebb's implementation](https://github.com/caseyWebb/homebridge-free-sleep/blob/8f92a83/src/pod/keepAlive.ts).
- The migration compatibility checks cover shapes from
  [EpicPi/free-sleep](https://github.com/EpicPi/free-sleep/commit/bc7b63a2de44c4dfe7c8ee4631b92cf54996da6c)
  and [Geczy/free-sleep](https://github.com/Geczy/free-sleep/commit/98edcf28cbaaa2566ea7906a3d5b3f4ad1e5defb).
  The cron and service checks cover Geczy's installer
  ([firewall jobs](https://github.com/Geczy/free-sleep/commit/3bbd5708d5ada6ac3a0fac5364eab838393786c2),
  [ambient-light service](https://github.com/Geczy/free-sleep/commit/fa81f92430314de60cb31e662b4bda4041bd2229)).
- The SFTP change comes from
  [onemec/free-sleep](https://github.com/onemec/free-sleep/commit/b47c07301e9fffccca674a818e64cd9793b0c5b3).
- The prebuilt-image credential check follows
  [GoogleBot42/podd's research notes](https://github.com/GoogleBot42/podd/blob/main/docs/research/connectivity-and-diff.md).
- Outbound rejection follows
  [M4v3R1cK-dev/free-sleep](https://github.com/M4v3R1cK-dev/free-sleep/commit/783291fe9e70d7afb5c2dd51926bfef4bbdcd0b9).
  The IPv6 gap was described in
  [throwaway31265/free-sleep pull request 60](https://github.com/throwaway31265/free-sleep/pull/60).
- Base output tag parsing restores Geczy/free-sleep's
  [original expression](https://github.com/Geczy/free-sleep/commit/32ace15b5c391db0905dcff209abd2d0c7a0d83d).
  The README now links the main-branch copies of Geczy's
  [driver](https://github.com/Geczy/free-sleep/commit/74d6439c0fffbd634e3b84ec054cb52d741eddab)
  and [angle maps](https://github.com/Geczy/free-sleep/commit/fccb7916fbf3f8f1e0da4324de57bdf1a1fe12a4)
  credited in 3.6.1, and credits the
  [preset integration](https://github.com/Geczy/free-sleep/commit/c17cb0866489889b2230f698e99eb74184c15623),
  including the HTTP route, app API client and four-tap base action.

## [3.6.1] - 2026-10-07

Keeps tap temperature changes within range, reports the daily reboot under its own status, stops sending an unverified command, and credits three contributors.

### Fixes

- Tap temperature changes now stay between 55 and 110 F, and a tap counter
  that resets no longer triggers an action. Internal temperature updates
  use the same limits. Ideas from jmakes/free-sleep
  ([temperature limits](https://github.com/jmakes/free-sleep/commit/093475e13bcbe39ed1cff86545e0847f8a73217d),
  [counter resets](https://github.com/jmakes/free-sleep/commit/6e79e401ad3cebccbdcd9927294ce9ce14fc64c3)).
- The daily reboot job now reports its result under reboot status instead
  of alarm status. Adapted from
  [benri/free-sleep](https://github.com/benri/free-sleep/commit/266810eb27487f8db69090254c885397d5e51e12).
- The API no longer sends command 17 as `STOP_PRIME`. Its meaning is
  disputed: 8rp calls it prime cancellation, while
  [seanpasino/free-sleep](https://github.com/seanpasino/free-sleep/commit/50580edff3)
  uses it for a whole-bed alarm. Neither meaning is verified in Nightstand.

### Credits

These contributions have been in Nightstand since 3.0.0 and are credited
here now:

- SFenton's fork supplied
  [multiple alarms per night](https://github.com/SFenton/free-sleep/commit/1b509162035a4ad49a9baea5e3b3c105cdeaf1a4)
  and the
  [five-minute recurring alarm limit](https://github.com/SFenton/free-sleep/commit/957b4c813d6a56deb14870d02d9f73cfd1789a4c).
- Felix Sommer's Beat2er fork supplied
  [`sensorTemps`](https://github.com/Beat2er/free-sleep/commit/2afc20f6ea639f7b58d0c885b8269315e56d3366),
  the ambient, heatsink and left/right sensor readings from the biometrics
  stream exposed through the device status API.
- Matt Gates (@Geczy) originally wrote the adjustable base BLE driver in
  Geczy/free-sleep in July 2025
  ([driver](https://github.com/Geczy/free-sleep/commit/5fb11a1a9138c3301e332b642e4986ccb739b696),
  [angle maps](https://github.com/Geczy/free-sleep/commit/44b2352948bc186ce9ee17b8d79696623c8801fe)).
  jmew's fork later carried this code, including the base presets.

Checked on: automated tests only (server, app and end-to-end, in CI on the release commit); these fixes were not run on a Pod before release.

## [3.6.0] - 2026-10-07

Adds themes, safer updates, saved copies of the original system settings, and time in bed instead of estimated sleep.

### What changes in the app

- A side whose schedule was paused turns on when the pause ends if its night
  is in progress. Checked on my Pod 5 with Rhythms and a weekly schedule,
  including ending a pause early. Change pause saves a new end in one write
  without turning the side on in between, also checked on my Pod 5.

- Settings > Bed and sides has a new Theme setting with
  three themes, saved on each device. Lamp, the look of 3.4.0 to 3.5.1,
  stays the default. The other looks are free-sleep classic and jmew.
  Thanks to [throwaway31265](https://github.com/throwaway31265/free-sleep)
  and [jmew](https://github.com/jmew/free-sleep) for the designs these are
  based on.
- The Sleep page now leads with time in bed and no
  longer shows the sleep score: without an estimate of time asleep it only
  reflected time in bed and trips out of bed. It also no longer marks nights
  against a 7 to 9 hour range, which is a range for sleep, not time in bed.
  The score is still returned by the API. Charts break where readings are
  missing, and the breathing chart's shaded band, which looked like a normal
  range, is gone.
- The Sleep page no longer shows deep sleep and REM, or time
  asleep. Deep sleep and REM came from fixed rules over heart rate and
  movement and looked about the same every night, and the rule for when you
  fell asleep counted the first hours of most nights as awake. It shows time
  in bed instead.
- Smart Schedule now says it cools once you have settled
  in bed, and that a shared bed can fool its presence sensing. The Tonight
  card no longer says it is cooling before anyone is in bed.
- A rhythm can also turn a side off when you get up: after
  your wake time the side stays on at the wake temperature while you are in
  bed, and turns off about 10 minutes after you get up, at most 3 hours past
  the set off time. If Nightstand stops, the Pod's own timer still turns the
  side off about 15 minutes after the set off time, or within about 15
  minutes if the side is already being kept on past it. While the schedule
  is paused, it turns off at the latest off time instead.
- Settings > Features now says biometrics are estimates,
  not medical measurements, and have only been checked on a Pod 5. New sleep
  tracking (beta) says which part has been checked and what else it changes.
- Settings > Software > Recovery now says how to go back to Eight Sleep's
  software on each model, and that on a Pod 5 no reset procedure has been
  checked yet.

### Updates, recovery and alarms

- Updating, rolling back or switching from the app now
  asks you to confirm when a side is on, an alarm is due within 15 minutes,
  or the bed's state cannot be read, and checks again just before Nightstand
  stops. The update dialog now says that Nightstand restarts, not the Pod.
- When an update, rollback or switch stops or goes back,
  the app now says so within seconds, with the reason, instead of waiting
  ten minutes.
- Updates, rollbacks and the switch to upstream now change
  nothing if Nightstand cannot stop cleanly, and one interrupted mid-swap
  puts the previous version back. An update, switch to upstream or reinstall
  keeps the previous version ready until the new one answers, and puts it
  back after a failure or interruption unless the services won't stop.
  A reinstall whose database migration fails now stops with an error instead
  of starting. Update, downgrade and rollback ran on my Pod 5. The failure
  paths above are covered by automated tests, not all by hardware checks;
  the fork switch has not been run on a Pod.
- The installer now holds the same operation lock as updates, rollbacks and
  switches through its health check and any restore, so a rollback cannot
  replace the install while the installer is still checking it. On my Pod 5,
  the installer refused before downloading or changing anything while a
  test process held the lock.
- After a power loss during an update swap, a timer now starts one recovery
  attempt 45 seconds after boot. If the live install is missing or fails its
  health check, it tries to restore the marked previous version. A timeout
  or failed restore keeps the marker for manual recovery. On my Pod 5, a
  reboot with no marker did nothing, a hand-set marker cleared after the
  health check, and a power cut shortly after the server stopped left the
  previous install healthy. Recovery ran once about 40 seconds after power
  returned and cleared the marker. The cut landed before the tree move; a
  cut during the move itself is covered only by automated tests. The
  interrupted update recorded no result, so the app's last result stayed
  at the previous run.
- Reset and install now take the operation lock before changing anything,
  so they refuse while another operation holds it and the server can tell
  they are running. A systemd tmpfiles rule creates the lock after each boot,
  checked on my Pod 5.
- Nightstand now keeps a copy of the Pod's original SSH, firewall and time
  sync settings in /persistent/nightstand-stock/ the first time it changes
  them. On a Pod installed earlier, each copy is taken the next time
  Nightstand changes that setting (the firewall at the next update) and is
  marked as taken after the change.
- The script behind Switch to upstream free-sleep is now
  scripts/switch-to-upstream.sh. The old name, revert-to-stock.sh, still
  works.
- After 3.6.0 is installed, updates check a downloaded release against a
  checksum published in the release list, when one exists, using the
  installed copy. The update from 3.5.1 or earlier to 3.6.0 is not checked,
  because those versions have no checksum step. This catches a corrupted or
  swapped download, not a compromised GitHub account. Switching
  to upstream installs the upstream version the switch was last checked
  with, once one is recorded.
- Updates no longer turn the firewall off while
  downloading; they open only what the download needs and close it even if
  killed partway. A release that needs a different Node version now gets it
  during the download instead of failing and rolling back.
- Settings > Software now says when you are running a beta
  while your update channel is Stable, and offers to switch. Releases are
  marked Stable or Beta in the version list and the release notes, and
  installing a beta says so.
- A new install now installs a tagged release and saves that
  release's channel, so a Pod installed on a beta keeps getting beta fixes.
  A reinstall follows the channel already saved. Installing a release older
  than the installer itself is refused with a message saying what to do.
- Nightstand now restarts its server if it is running but
  stops answering for three minutes, except while an install, reset, update,
  rollback or switch is in progress.
- Installs and updates now turn on the hardware watchdog on
  the Pod 5, so a Pod whose system freezes restarts itself within about 30
  seconds instead of staying down until it is unplugged. Other models are
  left as they are for now. It also stays off where a watchdog is already
  set up some other way, and switching to upstream turns it off again (on
  some Pods, at the next restart). I checked setup, removal, persistence
  across a reboot and recovery from a deliberate freeze on my Pod 5. Setup
  was run by hand; an update left a pre-existing watchdog setting alone.
- If you turned the hardware watchdog off with
  setup_watchdog.sh --remove, installs and updates now leave it off. Run
  setup_watchdog.sh again to turn it back on.
- With the hardware watchdog on, Nightstand now restarts
  the Pod when the stock Wi-Fi driver has crashed and the router has not
  answered for 5 minutes, or when the router has not answered and Wi-Fi scans
  have failed for 20 minutes; a router that is away while scans still work
  never counts. It restarts at most 3 times a day and never during an
  update or install. Whether a restart brings Wi-Fi back is not yet
  confirmed; Wi-Fi recovery has not been exercised on a Pod.
- If Nightstand stops, a side turned on by the weekly
  schedule now turns itself off a few minutes after its scheduled off time,
  instead of 12 hours after it came on, including when a pause skips that
  off. With the server stopped on my Pod 5, a weekly night and a Rhythms
  night turned the side off about 5 minutes after the scheduled off time;
  "When I get up" turned it off about 15 minutes after the scheduled off time.
- The app now says when an alarm did not ring, or may not
  have rung, and why. The message stays at the top of every page until you
  dismiss it or a week passes. Checked on my Pod 5 with the server stopped
  across a one-time alarm: after restart, Nightstand reported it as missed.
- A tap set to the alarm action, the shape upstream free-sleep uses, is
  accepted but has no effect yet. On a Pod 5 the firmware handles a tap
  while an alarm rings: a double or triple tap stops the alarm, whatever the
  tap settings say, and the tap is not passed on to Nightstand through the
  tap counters.
- Nightstand now reads the firmware's per-side `dismissAlarm` counter. After
  taking a baseline for a ringing alarm, a later value above the highest
  seen for that alarm clears that side's ringing record and pending snooze,
  without sending a command to the Pod. Confirmed on my Pod 5: a double tap
  stopped a Nightstand alarm in firmware, the counter rose, and Nightstand
  cleared its ringing state and logged the dismissal. Adapted from
  [upstream free-sleep's dismissal reading](https://github.com/throwaway31265/free-sleep/commit/2f630d9cf72e3e5583cf8a4b50da604f050f70be).

### Newer firmware and fixes from upstream

- Some newer Eight Sleep firmware, seen on at least one
  Pod 3, sends sensor data to a local NATS stream instead of writing RAW
  files; on such a Pod, live biometrics and the nightly sleep analysis,
  calibration and vitals jobs now read that stream. Thanks to jfrykman, whose
  [upstream pull request 57](https://github.com/throwaway31265/free-sleep/pull/57)
  described the firmware change. Tested on a computer, not yet on a Pod with
  this firmware.
- Without Tailscale, the firewall blocked DNS to resolvers
  outside the local network, so on some networks the Pod's clock never
  synced. It now allows DNS to the resolvers the Pod was set up with. Adapted
  from [EpicPi's pull request 51 to
  throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep/pull/51);
  not yet checked on a Pod.
- Dismissing an alarm now stops one that is already
  ringing. Reported by caseyWebb in [upstream issue
  54](https://github.com/throwaway31265/free-sleep/issues/54); not yet
  checked on a Pod.

### Sleep tracking and biometrics

- With "New sleep tracking (beta)" on, heart rate and
  breathing rate come from newer estimators built for the bed's vibration
  sensors. They write a value only while the bed's presence sensor says that
  side is occupied, and leave a minute blank when the signal is unclear or
  the sleeper is moving a lot. Until the presence sensor is ready, for
  example before its first calibration, the existing estimates are used
  instead. The Sleep page shows the breathing rate again while the switch is
  on; HRV is stored but not shown. On a public dataset recorded with chest
  straps, the newer heart rate was within about 1.3 bpm on average. On a
  shared bed, one side can still pick up the partner's heart rate. These
  remain estimates from bed sensors, not medical measurements. With the
  switch off, the estimates are the same as before.
- HRV is no longer shown in the app, and the sleep score no
  longer uses it. Checked against chest-strap recordings, the stored
  estimate was no more accurate than a fixed guess. It is still stored and
  returned by the API.
- Turning the Biometrics switch on now starts sleep
  tracking instead of only saving the setting, and restarts, resets,
  installs and switching forks now respect the switch.
- At startup and after the Biometrics setting is saved, Nightstand now
  starts and enables the stream service when Biometrics is on, and stops
  and disables it when off. This fixes a restored setting leaving the
  service disabled at the next reboot; reconciliation waits while another
  operation or update recovery is pending. Checked on my Pod 5, including
  after a server restart and reboot.

### Smaller fixes

- Nightstand now removes old database snapshots, keeping the
  newest three and any from the last week, so they cannot fill a Pod's
  storage. It removes more, oldest first, only when space runs low.
- If Nightstand's server crashes repeatedly, it now keeps
  restarting every five seconds instead of giving up until the next reboot.
- fs-reset now always starts Nightstand again with an
  empty database; before, it could leave a Pod 4 or Pod 5 unable to reach
  the bed, or the server stopped. fs-reset-db can now reset a damaged
  database, keeping a copy first.
- Bed settings stay locked until they have loaded, so a
  failed load can no longer save defaults such as Fahrenheit. Old readings
  on the Schedule page show as Not responding in grey, as on the Bed page.

Checked on: 2026-10-07, my Pod 5, updates, rollback, reset and restore,
boot recovery, alarms, pause resume, firmware off timers, hardware watchdog,
final controls and overnight health. See [the hardware checks and remaining
gaps](docs/TESTING.md#hardware-checks).

## [3.5.1] - 2026-10-01

Keeps biometrics RAW files from filling the disk on a Pod 3 with internet access blocked.

- On a Pod 3 with internet access blocked, the firmware never deletes its
  biometrics RAW files, so the small (about 1 GB) /persistent partition
  filled up in about a day and the server kept restarting. The RAW archive
  now applies its retention to the firmware's own RAW files too. When space
  runs low it removes the oldest file from both places, never the file being
  written, and its free-space floor scales with the partition, so a small
  disk no longer has its archive emptied every minute. Pod 4 and Pod 5 are
  not changed by this fix (only a Pod 5 has been tested). Thanks to @sim- for
  the report (https://github.com/LTimothy/nightstand/issues/1). Not yet
  confirmed on a Pod 3; tested with unit tests and on a Pod 5. The maintainer
  does not have a Pod 3.

  A Pod 3 whose /persistent is already full may not have room for the
  update. Removing some of the oldest RAW files first frees space; this
  removes the oldest 40 (about 270 MB) and never touches SEQNO.RAW:

  ```
  cd /persistent && ls -1tr *.RAW | grep -v '^SEQNO.RAW$' | head -n 40 | xargs -r rm -f --
  ```

  On a Pod 3 the free-space floor, not the retention setting, decides how
  much RAW history is kept, which is less than a day.

## [3.5.0] - 2026-10-01

Rhythms with an optional Smart Schedule, pausing a side's schedule, a new beta sleep tracking option, and more reliable sleep analysis.

- A new switch in Settings > Features, "Rhythms (beta)", is off by default.
  Rhythms are named sleep plans for each side: bedtime, wake time, alarms,
  turn off and temperatures. A week picks a rhythm, or no sleep, for each
  day, and any date up to 60 days ahead can use a different one. Week and
  date changes save at once and can be undone. The Schedule tab, the Bed
  page and the Tonight card all follow the same sleeps. With biometrics on,
  each Rhythms sleep is analyzed 15 minutes after it ends and again 2 hours
  after, in place of the noon analysis. Rhythms and Pause schedule have been
  used on one Pod 5. They have not been tried on a Pod 3 or Pod 4.

  The first time Rhythms is turned on, it copies the weekly schedule into
  rhythms named after their days and leaves the weekly schedule as it is.
  Turning it on again later brings back the saved rhythms; changes made to
  the weekly schedule in the meantime are not added. Turning Rhythms off
  restores the weekly schedule as it was, with nothing copied back, and
  keeps the rhythms in their own file for next time. When a side is in the
  middle of a sleep, you choose whether it stays on until that sleep ends,
  with its remaining alarm still ringing, or turns off now.

  A rhythm sets its temperatures by hand or with Smart Schedule. Rhythms
  copied from your weekly schedule keep your hand-set temperatures. A rhythm
  you add starts on Smart Schedule, and you can switch it to manual. Smart
  Schedule is loosely based on sleep research (the editor lists the studies
  and what each tested). Warming a little before wake time is our own
  addition and no study tested it. Changes are small and stay within a
  few steps of a base temperature you pick. With biometrics on, the
  cool-down waits until you have settled in bed. A temperature you set by
  hand holds until the curve's next phase. The step sizes and timings are
  our own estimates, and none of these studies tested this curve or a
  water-cooled cover like the Pod's. The editor lists the studies under
  "Based on sleep research". It is a general starting point for comfort,
  not a medical recommendation.

  Older versions and upstream free-sleep do not know about Rhythms and run
  the weekly schedule. Before a downgrade or rollback to a version without
  Rhythms, or switching to upstream free-sleep, each side goes back to the
  weekly schedule. A side in a Rhythms sleep that a weekly night also
  covers follows that night from then on. Otherwise it stays on until the
  sleep ends, when the Pod's own timer turns it off, and that sleep's
  remaining alarms do not ring. If the sleep's alarm already rang, the
  weekly alarms are skipped for the rest of that night so it does not ring
  twice. Settings > Versions says this before you start. The rhythms stay
  on the Pod: after coming back, Rhythms carries on if the weekly schedule
  was not changed in the meantime. If it was, the weekly schedule runs and
  the app asks whether to go back to Rhythms or use the weekly schedule.

- A new switch in Settings > Features, "New sleep tracking (beta)", is off by
  default and still being tested. When it is on, the bed's capacitance
  sensors are used to estimate which side of the bed has someone in it in the
  nightly analysis. On a Pod 5 whose cover writes the newer capacitance records
  they are used live too, and heart rate and breathing tracking carries on
  through short trips out of bed instead of starting over. It is an estimate
  from bed sensors and may be wrong. With the switch off, presence, sleep
  records and everything stored behave exactly as before. It has been checked
  only on a Pod 5 whose cover writes the newer capacitance records. On any
  other model, whatever records it writes, and on a Pod 5 whose cover writes
  the older records, it is experimental, has not been checked against anyone's
  sleep, and Settings > Features says "Experimental on this Pod" (on such a
  Pod 5, from its first calibration with the switch on). There it changes the
  nightly sleep records, starting from the Pod 5's entry level, or from 300
  counts on the older records (the entry level sleepypod uses for that
  format), and then following each side's level as learned from the Pod's own
  nights. A side keeps the older reading for a night whenever
  its capacitance had gaps, found a much shorter night or came in two formats.
  Once both sides' levels are learned and vibration readings arrive once a
  second, capacitance also decides when heart rate and breathing are recorded.
  The in-bed indicator, presence auto-off and schedules that react to presence
  stay on the vibration sensor. A capacitance format it does not recognize, as
  a Pod 6 may write, leaves sleep tracking as it was and is noted in the log.

  On one night checked against both sleepers' own notes, the old live
  presence split the two sleepers' nights into 20 and 31 pieces, and the old
  nightly record gave both sides the same bed times. The new tracking
  matched each person's notes on that night, including two short trips out of
  bed. See the
  [before and after](https://github.com/LTimothy/nightstand/blob/main/docs/presence-before-after.png).
  So far this has been checked on one Pod 5 over a handful of nights.

- You can pause one side's schedule with Pause schedule on the Bed page's
  Tonight card: for tonight only, until a set time up to 14 days ahead, or
  until you resume it. While a side is paused, its scheduled power changes,
  temperature changes and alarms are skipped and presence auto-off leaves it
  alone, so it stays under your control. The other side keeps its schedule,
  and a one-time alarm still rings. The side's tile, the Tonight card and the
  Schedule page show the pause with a Resume schedule button. A side in away
  mode cannot be paused.

  Older versions do not know about a pause. Before a downgrade, a rollback or
  switching to upstream free-sleep, a paused side's alarms for the coming
  night are skipped, but the older version runs the rest of that side's
  schedule.

- Alarms on a Pod 3 or Pod 4 vibrate with Double pulse. Pod 3 firmware
  refuses the Builds up pattern, so those alarms did not vibrate at all while
  the app reported success, and Pod 4 firmware falls back to Double pulse on
  its own. Builds up is now offered only on a Pod 5, and a Pod whose model is
  not recognized also gets Double pulse. Saved alarms keep their setting.
  Reported by caseyWebb in
  [throwaway31265/free-sleep#55](https://github.com/throwaway31265/free-sleep/issues/55);
  jmakes made the same change for Pod 4 in
  [their fork](https://github.com/jmakes/free-sleep/commit/9be14cdb).

- Running sleep analysis again for the same night now replaces that night's
  movement as well as its sleep records, instead of keeping the movement from
  an earlier run. Repeated runs over the same data agree, and the movement for
  a moment no longer depends on the time window that was analyzed.

- Movement no longer counts moments when a bed sensor reported no reading,
  which showed up as spikes.

- A sleep analysis whose database write fails now shows as failed on the
  Status page instead of healthy, and a successful one says how many sleep
  records and movement rows it wrote. Each run is also recorded with its time
  window, how much sensor data it read, how long it took and its peak memory
  use. A run that finds no sleep still shows as healthy, but now says that it
  found none and that the bed may have been empty or presence was not
  detected.

- If the part of the biometrics stream that processes sensor records stopped,
  incoming records kept piling up in memory, about 10 KB a second, until the
  Pod ran out of memory. The stream now notices, starts that part again, and
  restarts the service if that fails.

- The biometrics stream no longer logs an error every second while the Pod is
  still writing the last record of a sensor file, and sleep analysis no longer
  logs one when it reaches such a record.

- Biometrics exceptions are logged with their full traceback. On Pods running
  Python 3.9, logging an exception raised an error of its own.

- Leaving the log viewer while a log was still loading no longer keeps the
  server watching that file until it restarts.

- The vitals and movement endpoints return the last 24 hours when no time
  range is given, instead of every row ever stored, and refuse a range longer
  than 7 days. Without a range, vitals took several seconds on a Pod and
  more than doubled the server's memory use.

- API requests that send a body other than JSON now get a 415 error instead
  of being handled as if they had no body.

## [3.4.0] - 2026-09-29

A redesigned app, sleep records that start at your real bedtime, and safer updates, rollbacks and reinstalls.

- Reinstalling no longer loses recent sleep data. The installer deleted the
  database's write-ahead file after stopping the biometrics service, which
  could drop rows that were saved but not yet merged into the main file. It
  now keeps that file, and the biometrics service closes the database cleanly
  when it stops.

- Database backups made by updates, the installer, `fs-reset-db` and
  switching to upstream free-sleep now include the newest rows. They were
  plain file copies taken while the services were running. Database backups
  are kept apart from code backups, so several updates in a row no longer
  rotate out the last database copy.

- The app now checks each response from the Pod before using it. Fields it
  does not recognize are ignored, so it keeps working after rolling back from
  a newer version, and on a Pod switched over from upstream free-sleep or
  jmew's fork, feature switches that have no stored value yet are shown
  disabled instead of off.

- Switching to upstream free-sleep converts schedules and settings to a shape
  upstream can save. Each day keeps its first enabled alarm, alarm length is
  capped at 180 seconds, the level temperature display becomes Fahrenheit,
  and base control taps become alarm dismiss. The switch also stops the
  sensor recording archive, leaving saved recordings in place, and installs a
  Python package that upstream's biometrics needs. The guide lists what stays
  on the Pod afterwards.

- Roll back, switching to upstream and turning biometrics off check that the
  Pod can run them before starting, and say what to do if it cannot. Only one
  update, rollback or switch runs at a time. While one is running, Restart Pod
  is refused with a message and the daily restart is skipped, and none of them
  can start while a restart is under way.

- Downgrading from this version to 3.2.2 or older keeps archived sensor
  recordings. Those versions delete recordings older than 36 hours; the
  updater now gives them your retention setting, up to 14 days, since they
  do not check free space. The downgrade dialog lists what the older version
  will not do. Rolling back to 3.0.0 keeps the archive running.

- A failed database migration no longer leaves updates stuck. New migrations
  run as a single transaction, and the updater clears a failed one and
  retries once when that is safe. A Pod on 3.0.x whose update skipped a
  database step now shows it in System status, with Reinstall as the fix.

- Settings and schedules brought over from upstream keep their tap actions
  and disabled alarms instead of being reset to defaults. A day saved on
  3.0.0 with more than ten alarms loads and can be edited; new alarms are
  still limited to ten per day.

- The sleep, vitals and movement endpoints answer a malformed `startTime`,
  `endTime` or `side` with a 400 error instead of a server error. Movement
  records return their times as epoch seconds, as the API documentation
  describes. The sleep stages and score endpoints need a side and a range of
  at most 48 hours; a range reaching far into the future could use all of
  the Pod's memory and stop the server.

- Sleep records start when you got into bed. The nightly analysis began at
  the first sensor file after midnight, so most nights were recorded as
  starting around 11:45 PM whatever the real bedtime. It now covers the whole
  day and only the requested window, and analyzing a night again replaces its
  earlier record instead of adding a second one.

- Sleep stages hold up better when the bed sensors lose track of a still
  sleeper. Minutes without heart readings no longer delay the estimated start
  of sleep or end it early, and a night with too few readings shows time in
  bed rather than a stage estimate. The sleep score's duration now uses the
  same figure as the time asleep shown above it.

- Setting up biometrics installs its Python packages at versions tested on
  Pods instead of whatever is newest. A new major version of one of them was
  released recently and has not been tried on a Pod.

- The Sleep page no longer shows breathing rate. The current estimate does not
  track breathing closely enough to be useful, so it is hidden until it is
  measured differently.

- Alarms minutes apart no longer suppress one another. Overnight temperature
  changes, alarm replacements and sleep analysis use the full night window.

- Concurrent settings and schedule saves preserve unrelated changes. Empty
  sensor windows wait for data; presence duration no longer resets on
  heartbeats.

- Hardware commands release stalled or dropped connections, and HTTP and
  WebSocket connections apply the same origin checks.

- When the Pod's hardware does not answer, for example while it reconnects
  after a restart, turning a side on or off, changing its temperature or
  priming now fails after a short wait and says so next to the control.
  Before, the request could hang and the change could reach the Pod much
  later. Scheduled power and temperature changes still wait for the hardware
  and apply once it answers. A scheduled alarm that would start more than a
  few minutes late is skipped.

- An alarm set for the same minute as a scheduled turn-off now rings before
  the side turns off, including an alarm change made for that minute during
  the night.

- The server checks writes more closely. Temperatures, durations and LED
  settings must be within the Pod's range, a day holds at most 48 temperature
  changes, sleep record edits are validated, and `/execute` checks its input
  before sending it to the Pod. Refused requests answer 400 or 409 with a
  short message, and 500 responses no longer include internal error text.
  The schedule editor stops adding temperature changes at that limit.

- The Sleep page copes better with bad or partial data. Records dated in the
  future are ignored, and stage totals are hidden when there are too few
  heart readings. The Bed page
  scores the same night the Sleep page shows, and requests that never answer
  now show an error instead of loading.

- Schedule editing keeps turn-off after the latest alarm, accepts the wake
  time in the alarm change dialog, sends one alarm test per press, says when a
  test alarm did not start and keeps keyboard focus after saving or
  discarding.

- A temperature change made with + or - just before switching sides or
  leaving the page is sent instead of dropped. One made just before turning
  the side off is dropped instead of being sent after it, where it could
  pause that side's temperature schedule.

- Keyboard use is easier across the app. Buttons, tabs and accordions show a
  focus outline, a skip link and the navigation come first in tab order, and
  focused controls scroll clear of the navigation bar. Side names save on
  Enter, and LED brightness applies every key press.

- Update notices and the Update button use the selected release channel and
  offer only newer releases. Failed updates restart the restored biometrics
  service. Switching from another fork restores the original if database
  setup fails, and its dry run leaves the Pod clock unchanged. Backup restore
  checks the code and dependencies before replacing the running app.

- The app now has Bed, Schedule, Sleep and Settings navigation. Schedule
  editing shows night events and save scope; elevation cancels queued moves
  on Stop. Sleep separates Night and Week, preserves selection, uses the Pod
  timezone, and distinguishes missing recordings from zero sleep.

- The app's icon, and its name when added to a home screen, are Nightstand's
  instead of free-sleep's.

- Settings are grouped by task. System status separates problems from healthy
  services, and logs show when the connection drops and resumes.

- A fresh install and `fs-reset-db` now set up the database with only the
  migrations that ship with the release (`prisma migrate deploy`). They used
  Prisma's development command, which can create new migrations or offer to
  reset the database when it finds differences.

- The app works when opened at http://eight-pod.local:3000. Changes made
  from that address were refused before. Adapted from [2-X/nightstand](https://github.com/2-X/nightstand).

- Re-running the firewall script no longer piles up duplicate rules, and the
  outbound rules Tailscale needs are only added while Tailscale is running, so
  without it, new outbound connections remain blocked except time sync and
  answers to local name lookups (mDNS), which keep http://eight-pod.local:3000
  working.
  Updates apply the installed version's rules after the swap, and rollback
  applies the restored version's rules. If you set up Tailscale later, run the
  block script again once it is running. Applying the rules removes hand-added
  INPUT and OUTPUT rules, including custom VPN exceptions. Adapted from
  [2-X/nightstand](https://github.com/2-X/nightstand).

- After a restart, replayed sensor records no longer show old temperatures on
  the Status page or trip a false pump alert. Adapted from [2-X/nightstand](https://github.com/2-X/nightstand).

- Presence auto-off, which turns a side off after 45 minutes with no one on it
  outside its scheduled on-window, can now be turned off in Settings >
  Features. It stays on by default, so nothing changes unless you turn it
  off.

- The nightly sensor calibration for biometrics now runs whether or not daily
  priming is on. Before, it was scheduled together with priming, so a Pod with
  biometrics on and priming off never calibrated its presence thresholds.

- The restart an hour before daily priming can now be turned off in Settings,
  next to daily priming. It was already a setting, with no control in the app.

- A Pod switched over from another fork now gets the same services and
  permissions as a fresh install. Roll back, switching to upstream free-sleep,
  and turning biometrics off work right away instead of after the first
  update. The permissions file is also checked before it is replaced.

- Switching from another fork now downloads the migration tool's two helper
  files along with it, and the tool checks for them before it changes
  anything. Following the guide before this downloaded only the main script,
  so the install stage could not start. The tool also installs the newest
  release, the same one a fresh install gets, instead of the newest stable
  release, which can be well behind.

- The README and install guide are reorganized around which install path
  each pod takes and what tools each one needs.

## [3.3.2] - 2026-09-29

Fixes the firmware getting stuck on some Pod 3 units while internet access is blocked.

- Blocking internet access no longer leaves the firmware stuck on some Pod 3
  units. The firewall now refuses the firmware's cloud connection right away
  instead of silently ignoring it, which left the firmware waiting. Thanks to
  @sim- for tracking this down
  (https://github.com/LTimothy/nightstand/issues/1). The port 1337 rule was
  found and tested by the reporter on their Pod 3. The maintainer does not
  have a Pod 3.

  The update that installs this version blocks internet access again with the
  previous version's firewall script, so the new rule is not in place yet. To
  apply it now, run this as root on the Pod:

  ```
  sh /home/dac/free-sleep/scripts/unblock_internet_access.sh && sh /home/dac/free-sleep/scripts/block_internet_access.sh
  ```

  A fresh install applies it, and so does the next update after this one.

Moved from stable to beta with 3.6.0: it had about a day of use on one Pod 5
before going to stable. It includes everything in 3.0.1 to 3.3.1, which were
beta releases.

## [3.3.1] - 2026-09-28

Biometrics setup on Pod 3 units installed from an SD card, safer installs, and updates that download exactly the chosen release.

- Biometrics installs on a Pod 3 that was set up with the SD card method.
  The bundled Python module for reading XML needed a newer system library
  than that pod has, so creating the Python environment failed. It is now
  built against an older library that every supported pod has. The setup
  step also looked for Python's files in the wrong folder on that pod, and
  now asks Python where they are. Confirmed on the reporter's Pod 3 (they
  applied the rebuilt file by hand). The maintainer does not have a Pod 3.

- The installer stops if the download fails, and only removes an existing
  install once the new files have unpacked.

- Updates download each release from its own tagged archive. Before, the
  newest release came from the main branch, so an update could include
  changes made after that release, and two pods reporting the same version
  could be running different code. This takes effect from the update after
  this one, because the download step is run by the updater a pod already
  has.

- The biometrics log no longer records a second "exit" for a side that was
  already empty. What the pod reports for presence is unchanged.

- Opening internet access for an update now also clears the IPv6 rules that
  blocking it adds, not only the IPv4 ones. Taken from
  [EpicPi's commit](https://github.com/EpicPi/free-sleep/commit/0642856a37e6828eb78f9d87b8024c8e72be2a6b)
  to the EpicPi/free-sleep fork of free-sleep.

## [3.3.0] - 2026-09-26

A water tank status, longer and adjustable sensor recording retention, and memory limits for the services.

- The Status page has a Water tank entry. The pod reports its tank sensor on
  every status read, and that reading only ever showed on the temperature page
  while the tank was low. A low tank now counts as needing attention, which
  also lights the dot on the Status tab, and the entry shows when the tank went
  low. A change has to hold for about 30 seconds before it counts, so water
  moving during priming does not register.

- Raw sensor recordings are kept for 14 days instead of 36 hours, and Settings
  can set anywhere from 2 days to 2 months. The recordings take about 0.4 GB a
  day. If the data partition drops below 2 GB free, the oldest recordings are
  removed first.

- The server and the biometrics stream now run with memory limits, and their
  processes are the first the system stops if memory runs out. The pod's
  heating and cooling firmware shares about 1.9 GB of memory with them, so a
  runaway analysis job should not be able to take memory it needs. The limits
  are installed by this update and apply from the next time each service
  starts. Reverting to stock removes them.

- Settings no longer links to the community chat and donation pages of the
  projects Nightstand builds on, since they cannot help with this fork. For
  help, open an issue on this repository.

- The guides were checked against the current code and corrected where they
  had drifted, most of all the API reference.

## [3.2.2] - 2026-09-25

Fewer false pump warnings, and a Logs page that opens large log files.

- The pump warning on the Status page no longer goes off when a side is
  switched off. It raised "pump stall suspected" almost every day, because a
  side the schedule has switched off reports its pump at 0 rpm, and nothing else
  the pump reports tells a switched-off side from a stalled one. It now checks
  whether the side is switched on before calling a stopped pump a stall. A stall
  warning already showing when a side switches off now clears, where before it
  stayed until the pump ran again.

- The Logs page opens large log files. It read a whole file before showing any
  of it, and rotated logs reach 15 MB, so on a busy pod the page could wait long
  enough for the browser to give up. It now reads only the end of the file,
  which is all the page shows.

## [3.2.1] - 2026-09-24

Updates apply pending database changes reliably and say so on the Status page when they cannot.

- When an update cannot apply its database changes, the Status page now says
  so. The database entry names the changes that are missing, and the Versions
  page offers Reinstall on the running version, which applies them. Before
  this, the server kept running without tables it needed, and nothing reported
  why until something that used them failed.

- Updates now apply database changes whenever the database is behind, not only
  when the new version brings changes of its own. An update that left changes
  unapplied can now be finished by reinstalling the same version, which was
  not possible before.

- The version being installed now finishes its own update. Updates were always
  run by the updater already on the pod, so a fix to the updater reached a pod
  one update after the one that delivered it. From the next update on, the new
  version's updater takes over once it has been downloaded. An update only
  hands over to an updater that supports this, so installing an older version
  still installs the version asked for.

  This starts with the update after this one. Installing 3.2.1 is still run by
  the updater already on the pod. Coming from 3.0 or 3.1, that updater can
  leave database changes unapplied, and if it does, the Status page will say so
  and one reinstall finishes them.

## [3.2.0] - 2026-09-24

Steadier presence calibration, a fix for missing database tables after updates, and an optional hardware watchdog.

- Calibration now needs the whole bed to be empty, not only the side being
  calibrated. It picked its quiet stretch by looking at its own side alone, so a
  side could calibrate while someone lay on the other one and measure their
  movement coming through the mattress instead of an empty bed. A stretch is now
  skipped if either side recorded a heart rate during it. When the bed was busy
  the whole time, calibration waits for another day rather than settling for the
  least busy stretch.

- The calibration quality score now drops when the window it learned from was
  thin. Every second was being counted twice, so a window missing half its
  readings scored the same as a full one. Calibration also measures each side's
  signal level on an empty bed and keeps that with every run. It is recorded
  only, and does not change how presence is detected yet.

- An update could leave the server running without database tables it needs.
  The database step ran while the biometrics service was still writing to the
  same file and could not get the lock it needed. That was logged as a warning,
  and the check after the update passed anyway, because it confirms the server
  answers, reports the right version and reads a sensor, and none of that
  touches the new tables. On one pod this left calibration failing every night
  until it was fixed by hand. Updates now pause the biometrics service while the
  database is updated, retry, confirm nothing is left pending, and roll back if
  it still did not apply. This protects updates made from this version on. The
  update that installs this version runs the updater already on the pod, so it
  does not get the fix itself.

- Each time presence starts, the minute that follows is now recorded along with
  the few seconds before it. A person settles well above the level that starts a
  session, while an empty side that briefly crossed it drops back within
  seconds, so the log now shows which sessions were real without keeping raw
  sensor recordings around.

- `scripts/setup_watchdog.sh` turns on the pod's hardware watchdog, so a frozen
  system restarts itself within about 30 seconds. On one pod a fault in the
  stock Wi-Fi driver froze the system partway through its nightly restart, and
  it stayed down, with no server and no cooling, until it was unplugged. Updates
  do not run this script. It is run once, as root, on the pod.

- The README says how to open the app, at http://eight-pod.local:3000 or the
  pod's IP address, and how to add it to a phone's home screen.

## [3.1.0] - 2026-08-07

Sleep page charts show data again, and the Status page shows what presence calibration learned.

- The Status page now shows when the active presence calibration profile was
  created and what it learned from, instead of only whether the last run
  succeeded. Calibration results are stored with the window they came from,
  so a thin result can be told apart from a good one. A pod that has never
  calibrated now says so plainly rather than reporting an error.

- Sleep analysis no longer fails on a pod whose presence calibration has not
  run yet. It stopped with an error asking for a calibration command to be run
  by hand; it now uses the vibration sensor alone until a calibration exists.

- The in-bed indicator starts and ends far more sessions than anyone actually
  has. Over eleven days of recordings the live detector counted 23 to 30
  separate sessions per side per day, most of them under twenty minutes, while
  the overnight analysis of the same nights found the one real session per side
  you would expect. Signal strength is not the reason: an occupied side reads
  around forty times higher than an empty one, so the two are easy to tell
  apart. The sessions are being started by something in the entry logic, which
  the once-a-minute log is too coarse to show. Each start is now recorded along
  with the few seconds that led into it, so the next look at this can read what
  happened instead of estimating.

- The pump warning on the Status page is a false alarm, and this release starts
  gathering what is needed to fix it properly. The check treats "pump reporting
  no speed while the cooling element draws current" as a stalled pump, but
  across eleven days of recordings the pump reports no speed for exactly the
  hours the power schedule has that side switched off, and the current reading
  never drops low enough to tell a switched-off side from a running one. So the
  warning fires most days when the bed powers off. The check is unchanged for
  now, because getting it wrong in the other direction would hide a real stall.
  It now records the full pump reading when the pump starts or stops reporting
  speed, which is the missing piece for telling those two cases apart.

- The heart rate, HRV and breathing charts on the Sleep page were blank. The
  server reformatted each reading's timestamp into a local-time string before
  sending it, and the charts scale the timestamp themselves and discard
  anything that is not a number, so every reading was thrown away and the
  charts drew nothing. No error appeared anywhere. Readings now go out as the
  plain timestamps they are stored as, which is what the charts already expect.

- Heart rate variability and breathing rate recorded at the start of a sleep
  session belonged to the previous session. Both are smoothed running values,
  and neither can be recomputed immediately: breathing rate needs 30 seconds of
  established presence and HRV needs five minutes. Leaving the bed cleared the
  samples behind them but not the values themselves, so the opening minutes of
  the next session were written with whoever was there last. Measured against
  eleven days of recordings, that was 16% of stored readings, 10% of them
  carrying a plausible-looking number rather than the blank the rest of the
  system knows to ignore. Leaving the bed now clears both, along with any
  measurement still waiting to be written.

- A physical double or triple tap that failed to write its temperature change
  restarted the server. Tap handling runs detached from the polling loop, so a
  base movement over Bluetooth cannot delay the next tap being noticed, but that
  also meant a failure had nowhere to go and the server treats an unhandled one
  as a reason to shut down. The failure is now caught where it happens, logged,
  and shown on the Status page.

## [3.0.1] - 2026-08-01

Scheduling fixes, including sides that stayed on, alarms on the wrong day, and controls that showed unsaved values.

A bug-fix release. Much of it comes from one root cause: the app and the
server disagreed about which day a schedule ends on. The app asked whether
the off time falls before the on time, which is right. The server used a
fixed rule that a time at or before noon belongs to the next day, and never
looked at the on time at all. The presence monitor carried a third copy of
that rule. All three now share one model: a day's schedule opens at its
power-on time, so a time at or after that belongs to the same day and
anything earlier falls on the next one.

Fixed in the schedulers:

- A side could stay on for days. A Saturday 23:00 to 13:00 schedule put the
  power-off ten hours before its own power-on, so the next one to actually
  run was the following Saturday. A morning nap or an after-midnight
  schedule had smaller versions of the same problem.
- Alarms took their day from the power-off time rather than from the alarm's
  own time, so changing only when the bed switches off could move the alarm
  to a different weekday. The alarm then found the side already off and
  skipped itself, which looked like no alarm at all.
- Temperature adjustments could scatter one night's changes across three
  days, since each entry applied the old rule to a different time.
- An alarm saved without a time passed validation and then threw while being
  scheduled. Because every job was cancelled before the rebuild, one bad
  entry could leave the pod with no power, temperature, alarm, or priming
  jobs, and it stayed that way across restarts. Schedules are now validated
  more strictly, an unusable alarm is skipped rather than fatal, and each day
  is scheduled on its own so one failure cannot take down the rest.
- An alarm override accepted any text. "25:00" quietly armed the alarm for
  01:00 the next day. Override times and dates are now validated.
- A slow clock sync at boot could leave the pod with no jobs for the life of
  the process, because the retry budget ran out after 100 seconds and stopped
  for good. It now keeps retrying on a longer interval.
- The daily reboot silently never scheduled when priming was set before
  01:00, because the hour worked out to -1.
- Powering on no longer overwrites a temperature you set by hand while the
  temperature schedule is paused.

Fixed in presence auto-off:

- Auto-off treated "no presence data" as "nobody there" and could switch a
  side off with someone in it, 45 minutes after the biometrics stream stopped
  reporting. Turning biometrics off in settings stops that stream, so this
  was reachable from the app. Presence is now three states, and auto-off
  holds when it is unknown rather than assuming an empty bed.
- A clock correction after boot read as hours of absence and switched a side
  off on the next check.

Fixed in the app:

- Dismissing a vibrating alarm latched the dialog closed, so the next alarm
  did not show one.
- Several controls kept an optimistic value after the save failed, showing a
  temperature or LED brightness the pod never accepted. A failed prime also
  left the power, temperature, and prime controls disabled until the page was
  reloaded.
- The + and - temperature buttons sent the previous target, so the pod kept
  its old temperature and the display jumped back on the next status update.
  Quick taps could also push the target past the allowed range.
- Cancel did not close the rollback and revert-to-stock confirmation dialogs.
- A failed alarm dismiss closed the dialog while the pod could still be
  vibrating. It now stays open.
- The schedule editor refused an overnight turn-off more than 12 hours after
  turn-on, and chose which day to show from the browser's time zone rather
  than the pod's.
- The sleep chart labelled times like "22:30pm" and could put the wrong
  weekday under a bar.
- A schedule with alarms saved in the older single-alarm shape always looked
  edited, so discard never went quiet.
- A malformed settings response could blank the whole app instead of one
  section, and an invalid live-update frame could write over the cached
  device status and show the bed as off.

Also in this release:

- Settings now has a Versions row that opens Software & updates, which was
  built and routed but had no way in. Its version picker and instant
  rollback were gated behind a version floor that no release had reached, so
  both were unavailable; the floor now sits at 3.0.0, where the features it
  guards actually shipped.
- The update check compared the pod with upstream free-sleep's newest
  version, which is numbered 2.x, so it always reported the pod as up to date
  and the Update button never appeared. It now checks this project's releases.
- Settings > Features has three new switches, all on by default: Sleep score
  and stages, Level temperature display, and One-off alarms. Turning one off
  hides that feature in the app, and with One-off alarms off a pending
  one-off alarm does not ring. Sleep score and stages needs biometrics, and
  while either is off the server returns no score or stages instead of
  computing them from whatever data it has. Level temperature display cannot
  be turned off while level is the selected temperature format.
- A fresh install downloaded upstream free-sleep's code, then set up this
  project's rollback and revert-to-stock services, which pointed at files that
  were not there. It now installs Nightstand.
- Switching to Nightstand from another fork with the migration tool always
  stopped before changing anything, saying the staged tree had no readable
  serverInfo.json. It now runs.
- The low water warning links to this project's issues.

Known limitation, not fixed here: on the spring daylight-saving change, a job
scheduled in the hour that does not exist that day is skipped, and a weekly
job skips a full week rather than a day. The autumn case, where an alarm
could fire twice, is fixed. Addressing the spring case means replacing the
recurrence rules with explicit per-day scheduling, which is a larger change
to safety-critical code than belongs in a patch release.

## [3.0.0] - 2026-07-16

Nightstand's first release under its own version numbers. It is the full
tree: the in-app updater with rollback and revert to stock, the features
carried over from jmew/free-sleep (presence detection, sleep stages,
adjustable base control, and live updates in the app), and the fixes made
since, including the hardware socket timeouts and the biometrics work.

The git history itself was rebuilt from a fresh clone of upstream
throwaway31265/free-sleep, with each prior feature ported or
reimplemented as its own commit, attributed to its original author
wherever a commit could be taken directly. See [README.md](README.md)
for the fork lineage and [CONTRIBUTING.md](CONTRIBUTING.md) for how
versions get cut.
