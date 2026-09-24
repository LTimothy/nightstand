# Changelog

Notable changes to Nightstand, in its own version stream starting at 3.0.0
(see [CONTRIBUTING.md](CONTRIBUTING.md) for how versions get bumped). Nightstand
is a hard fork; for the history of the projects it descends from, see
[jmew/free-sleep](https://github.com/jmew/free-sleep) and
[throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep).

## [3.2.1] - 2026-09-24

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

## [3.1.0] - 2026-08-07

- The Status page now shows when the active presence calibration profile was
  created and what it learned from, instead of only whether the last run
  succeeded. Calibration results are stored with the window they came from,
  so a thin result can be told apart from a good one. A pod that has never
  calibrated now says so plainly rather than reporting an error.

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

A bug-fix release. Most of it comes from one root cause: the app and the
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
  temperature, power state, or away-mode setting the pod never accepted.
- The sleep chart labelled times like "22:30pm" and could put the wrong
  weekday under a bar.
- A schedule with alarms saved in the older single-alarm shape always looked
  edited, so discard never went quiet.
- A malformed settings response could blank the whole app instead of one
  section, and an invalid live-update frame could write over the cached
  device status and show the bed as off.

Also in this release:

- Settings now links to Software and updates, which was built and routed but
  had no way in. Its version picker and instant rollback were gated behind a
  version floor that no release had reached, so both were unavailable; the
  floor now sits at 3.0.0, where the features it guards actually shipped.

Known limitation, not fixed here: on the spring daylight-saving change, a job
scheduled in the hour that does not exist that day is skipped, and a weekly
job skips a full week rather than a day. The autumn case, where an alarm
could fire twice, is fixed. Addressing the spring case means replacing the
recurrence rules with explicit per-day scheduling, which is a larger change
to safety-critical code than belongs in a patch release.

## [3.0.0] - 2026-07-16

Nightstand's first release under its own identity: a minimal agent that
turns a stock free-sleep install into one with update, rollback, and
revert-to-stock built in. Everything else that has landed on top of that
agent so far, Franken hardening, biometrics, the sleep and schedule
pages, the updater surface, ships in this same tree today, and becomes
the first flag-gated feature bundle in a later release once the flag
system exists.

The git history itself was rebuilt from a fresh clone of upstream
throwaway31265/free-sleep, with each prior feature ported or
reimplemented as its own commit, attributed to its original author
wherever a commit could be taken directly. See [README.md](README.md)
for the fork lineage and [CONTRIBUTING.md](CONTRIBUTING.md) for how
versions get cut.
