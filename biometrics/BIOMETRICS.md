# Biometrics

These are estimates from bed sensors, not medical measurements. Don't use
them for health decisions.

With Biometrics on, Nightstand estimates when each side is in bed, heart
rate, breathing rate and sleep from the Pod's sensors. It's off by default;
the [README](../README.md#biometrics) explains how to install it and turn it
on or off in Settings > Features. The Biometrics switch won't change while an update, rollback or fork
switch is running; wait for it to finish. I test it on my own Pod 5 only.

The pipeline, including the vitals code built on HeartPy, comes from upstream
[throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep);
presence detection, sleep stages and the sleep score come from
[jmew/free-sleep](https://github.com/jmew/free-sleep); Nightstand has changed
parts of all of it. Smaller credits are in [DEVELOPER.md](DEVELOPER.md),
which describes the code.

## What the numbers are

Time in bed is measured from detected presence, so wrong presence gives a
wrong entry, exit or side. Heart rate and, with New sleep tracking on,
breathing rate are estimates. HRV and sleep stages aren't validated and
aren't shown (see [How accurate it is](#how-accurate-it-is)).

## Privacy

Nightstand keeps sleep data on the Pod and sends it nowhere. The app has no
login, so any device that can reach the Pod can read all of it. Raw sensor
recordings are archived for 14 days by default (Settings > Features, "Keep
raw sensor recordings"), or less when free space runs low; archiving runs
whether Biometrics is on or off. Nightly analysis needs those recordings, so
a shorter archive limits how far back it can be rerun; it doesn't delete
stored sleep records or vitals. Eight Sleep's firmware can upload raw
recordings unless the
[firewall rules](../INSTALLATION.md#19-add-firewall-rules-to-limit-internet-access)
are on.

## How accurate it is

The heart-rate figures below come from different tests, so they can't be
compared with each other.

Upstream free-sleep compared its heart-rate estimate with reference devices,
mostly Apple Watches, over 33 nights from six people
([table](#upstream-heart-rate-comparison)). Nightstand's estimates were
checked against a public dataset (Li et al., 2024) recorded with an
under-mattress sensor, not a Pod, and chest straps, with 22 healthy young
adults sleeping alone. On that dataset (bpm is beats per minute):

| | Old tracking (the default) | New sleep tracking (beta) |
| --- | --- | --- |
| Heart rate | off by about 2.8 bpm on average | off by about 1.3 bpm, with a value for fewer minutes |
| Breathing rate | no better than a fixed guess, so hidden | off by about 0.4 breaths per minute; shown, as an estimate, only with the switch on |

HRV isn't shown: the old estimate was no better than a fixed guess, and the
newer one, with New sleep tracking, missed the accuracy bar I set before
testing it. Both are stored. Deep sleep and REM aren't shown because the
stage rules haven't been compared with any reference and gave each night
roughly the same shares. Time asleep isn't shown either: the rule for when
you fell asleep waits for heart rate to get close to the night's lowest, so
on most of my nights it counted the first hours as awake. The app shows time
in bed instead. The sleep score isn't shown for now: without an estimate of
time asleep it only reflected time in bed and trips out of bed. It's still in
the API.

Nobody has worn a reference device on my Pod, so there is no accuracy figure
for a Pod. In a shared bed, movement on one side reaches the other side's
sensor through the mattress: old tracking can read an empty side as
occupied, and that side's heart rate and breathing can then carry the
partner's values. [docs/VALIDATION.md](../docs/VALIDATION.md) has the
details.

## Other limits

The vibration sensors respond to changes in pressure, not to steady weight,
so a very still sleeper can drop below the level that counts as present,
which leaves gaps in vitals. Heart rates outside a fixed range leave gaps too
(40 to 90 bpm with old tracking; see
[docs/CALIBRATION.md](../docs/CALIBRATION.md)). Pod 3 has two vibration
sensors per side, Pod 4 and Pod 5 have one, and covers write capacitance
data in different formats. Only a Pod 5 has been tested. Newer firmware that
writes sensor data only to a local stream, not to files, is read too, live
and nightly, but I haven't run Nightstand on a Pod with that firmware yet.

## New sleep tracking (beta)

On a Pod 5 whose cover writes the newer capacitance records (the format the
firmware calls `capSense2`), this switch in Settings > Features takes
presence from the capacitance sensor under each side, which responds mainly
to the person on it. Heart rate and breathing then come from newer
estimates, which leave a minute blank when the signal is unclear. Until
capacitance presence is ready (before the first calibration, for example),
or when calibration is missing or the capacitance readings go stale, a side
stays on old tracking, so turning the switch on doesn't by itself mean New
sleep tracking is running.

Elsewhere, including a Pod 5 with the older `capSense` records, the switch
has not been checked against anyone's sleep. It changes the nightly records
and which minutes get heart rate and breathing, not the in-bed indicator or
presence auto-off.

### How the new sleep tracking was checked

Over seven nights on one Pod 5, both sleepers kept their own notes of when
they got into and out of bed, independently of the sensor. The Pod's bed
entry and exit times for each side were compared with those notes. They
were within 9 minutes on every night but one (median under a minute over 22
noted entries and exits). The exception was a morning when the bed was still
in use after the note said we were up: the note was 27 minutes earlier than
both New sleep tracking and the vibration sensor. New sleep tracking kept
each person's bed times apart, while old tracking split each side's night
into pieces. Heart rate, the score and stages weren't part of this
check. Other models and the older `capSense` format haven't been checked.

## What runs and when

The schedule of live presence, nightly analysis and calibration, and what
each writes, is in [DEVELOPER.md](DEVELOPER.md#what-runs-and-when). One part
matters day to day: a calibration started by hand (Settings > Pod and
diagnostics > System status) doesn't check whether the bed is occupied, so
only run it when the bed is empty.

## Upstream heart-rate comparison

The table reproduces [upstream free-sleep's summary](https://github.com/throwaway31265/free-sleep#biometrics)
of its heart-rate estimates. It doesn't cover Nightstand's later changes.

| Across 33 nights | Average | Best | Worst |
| --- | --- | --- | --- |
| RMSE (beats per minute) | 2.88 | 1.45 | 7.63 |
| MAE (beats per minute) | 1.83 | 1 | 5.77 |
| Correlation | 80.8% | 95% | 27% |
