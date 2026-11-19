# Calibration and fixed constants

This page is for people changing the biometrics or presence code. It says
what calibration stores and lists the numeric constants the code relies on,
with the reason each has its value. Every constant is a fixed literal, even
where it shapes a value that is learned, and I tuned most of them on my own
Pod 5. Unless its meaning says otherwise, a constant is a timing margin, a
tuning choice tied to one bed, or a chosen acceptance range (not a
physiological limit). A value here says what the code does, not that the
mechanism behind it has passed a test on a real Pod. For what the sleep data
can tell you, see [biometrics/BIOMETRICS.md](../biometrics/BIOMETRICS.md);
for the code, see [biometrics/DEVELOPER.md](../biometrics/DEVELOPER.md).

## What calibration does

Calibration measures an empty-bed baseline for each side's sensors. It
doesn't validate heart rate, breathing rate, HRV, sleep stages or the sleep
score.

With Biometrics on and a time zone set, it runs at 18:30 for the left side
and 19:00 for the right (`server/src/jobs/primeScheduler.ts`), whether or not
daily priming is on. Each run looks back six hours for a stretch when the bed
was empty. It asks the live presence detector first and skips the run if
someone is on the bed; if it can't ask, it logs that and goes ahead. A side
that is usually occupied at that time is rarely calibrated.

A run started by hand (Settings > Pod and diagnostics > System status) looks
from two hours ago to one hour ahead and skips the occupancy check, so only
start one when the bed is empty. It still needs an empty stretch in the
recorded data; without one it reports insufficient data rather than saving an
occupied baseline.

| Value | Where it is kept | How it is used |
| --- | --- | --- |
| Empty-bed capacitance means and standard deviations | SQLite calibration profiles, plus a legacy baseline JSON file for older readers | The default nightly detector compares readings with this baseline. New sleep tracking reads the same means and noise. |
| Empty-bed piezo floor | SQLite calibration profiles and run history | New sleep tracking uses recent floors for its whole-bed activity check. The default live detector keeps its fixed noise threshold. |
| Occupied capacitance rise | SQLite calibration profiles, learned by the nightly analysis when New sleep tracking finds a usable night | Sets each side's entry level for that path; one night moves it only so far. |
| Recent and occupied piezo floors in the default live detector | Stream memory | Decide when an ambiguous two-side signal counts toward leaving the bed. A restart loses them. |

## Default live presence

In `biometrics/stream/biometric_processor.py`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `NOISE_THRESHOLD` | 150,000 | Piezo range below which a side reads empty. Bed tuning: an empty side idled at 40k to 110k on my Pod 5 and an occupied one at 200k and up, even on the other side through the mattress; 150k keeps a margin below the weakest occupied signal. |
| `DOMINANCE_RATIO` | 1.3 | One side must read at least 1.3 times the other to count as the only occupied side. Bed tuning: depends on mattress coupling. |
| `_SANE_MAX_SIGNAL` | 25,000,000 | Largest sample magnitude accepted: above the 16,777,215 clipping ceiling seen on the Pod, far below the int32 overflow values near 2.1 billion that it rejects. |
| `no_presence_tolerance` | 180 s | Exit delay once presence is established. A still sleeper's signal can sit below the threshold for a minute or more. |
| `_fast_exit_grace` / `_established_threshold` | 30 s / 60 s | Sessions shorter than 60 s can end after 30 s without signal. |
| `_REENTRY_CONFIRM_FRAMES` | 3 | Clear frames needed to cancel an exit that has started. |
| `_presence_heartbeat_interval` | 60 frames | About one report a minute to the server; a contract with `PRESENCE_STALE_MS` below. |
| `VITALS_RESET_ABSENCE_SECONDS` | 600 s | With New sleep tracking deciding presence, a side keeps its heart-rate bounds and last HRV and breathing values through an absence shorter than this; each estimate still waits for a full window after the return. After it, the next occupant starts clean. |

In `biometrics/stream/presence_floor.py`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `FLOOR_PERCENTILE` / `FLOOR_MIN_WINDOW` | 20 / 300 samples | Low end of the recent range distribution, trusted after about 5 minutes at 1 Hz. |
| `FLOOR_EMPTY_FRACTION` | 0.30 | A rolling floor below 30% of the learned occupied floor looks empty. Bed tuning: on one recording the occupied floor sat near 2.5M against a 0.7M crosstalk floor. |
| `FLOOR_EMA_ALPHA` | 0.02 | Smoothing of the occupied-floor reference, slow enough that a still stretch can't drag it down. |
| `AMBIGUOUS_FREEZE_CAP` / `AMBIGUOUS_LEAK_DIVISOR` | 600 frames / 4 | After 600 consecutive ambiguous frames the exit clock advances one tick in four, so ambiguity can't hold presence indefinitely. A still sleeper can also produce an ambiguous signal. |

## Calibration and default nightly analysis

| File | Constant | Value | Meaning |
| --- | --- | --- | --- |
| `biometrics/sleep_detection/cap_data.py` | `min_std` | 1 | Floor for a saved capacitance standard deviation, used as a z-score denominator. Measured empty-bed values on my Pod 5 were 0.03 to 0.85. |
| `biometrics/sleep_detection/calibrate_sensor_thresholds.py` | `range_threshold` / `threshold_percent` | 80,000 / 0.70 | Piezo range gate for finding an empty window, and the share of a rolling window that must agree. |
| Same file | `threshold_range` / `empty_minutes` | 10,000 / 5 | Stillness gate and the shortest window worth calibrating from. |
| `biometrics/sleep_detection/sleep_detector.py` | `occupancy_threshold` / `threshold_percent` | 5 / 0.90 | Gate on the capacitance z-score sum and the share of a 10 s window that must read occupied. The helper's own default gate is 50. The call's 5 comes unchanged from upstream free-sleep's first sleep detection code, which was tested on a Pod 3, and no reason for it is recorded. |
| Same file | `noise_threshold` / piezo `threshold_percent` | 150,000 / 0.70 | Nightly piezo range gate (a duplicate of `NOISE_THRESHOLD`) and window share. |

## New sleep tracking

Off by default, and tested only on my Pod 5 with `capSense2` records. Reading
another format in code doesn't mean it works on another Pod.

On any other Pod, capacitance decides only when vitals are taken, and the
presence the server hears (schedules, presence auto-off, the in-bed
indicator) stays on the vibration sensor, unless the owner turns on
Capacitance presence (`uncheckedCapPresence`). That switch was
checked on one Pod 3 writing `capSense`, over six nights replayed from RAW
files: both sides used learned levels near 1,000 counts, and capacitance
never put an empty side in bed beside an occupied one.

| File | Constant | Value | Meaning |
| --- | --- | --- | --- |
| `biometrics/presence/params.py` | `DEFAULT_ENTER_DELTA` | 4 | Starting entry rise in `capSense2` units, before a side has a learned rise. |
| Same file | `ENTER_FRACTION` / `EXIT_RATIO` | 0.4 / 0.5 | Entry at this share of the learned occupied rise; exit at half of entry. |
| Same file | `ENTER_MIN` / `NOISE_MULTIPLE` / `ENTER_MAX` | 3 / 6 / 10 | Entry never drops below partner-only spikes (about 3 on real nights) or six times the calibrated noise, and never rises past where a light sleeper would be missed. |
| Same file | `DEFAULT_PIEZO_FLOOR`, min, max | 75,000 / 30,000 / 150,000 | Default and bounds for the median of recent empty floors. |
| `biometrics/presence/detector.py` | `enter_seconds` / `exit_seconds` | 20 s / 60 s | Confirmation before a side reads occupied or empty. |
| Same file | `BED_QUIET_SECONDS` / `PIEZO_ALIVE_MARGIN` / `ENTER_ALIVE_SECONDS` | 90 s / 2 / 5 s | Whole-bed quiet period, activity multiplier over the floor, and active seconds needed within entry confirmation. |
| `biometrics/presence/sensors.py` | `CAPSENSE.unit` | 75 | Converts the fixed levels from `capSense2` units to `capSense` counts, giving a starting entry level of 300 counts. That level is an assumption, not a measurement: it has not been tested on a Pod that writes `capSense`, and each side's learned level takes over after its first good night. |
| `biometrics/presence/guard.py` | `UNEXPLAINED_SECONDS` of `UNEXPLAINED_WINDOW_SECONDS` | 600 of 900 | On a Pod or format not yet tested, the vibration sensor takes back vitals recording, and the presence the server hears when the owner has let capacitance drive it there, when the bed reads in use for 10 of 15 minutes but capacitance places nobody in it. Longer than any entry, much shorter than the 45 minute auto-off. |
| `biometrics/presence/piezo.py` | `ONE_PER_SECOND_SHARE` | 0.9 | On a Pod or format not yet tested, the new tracking runs only when at least 90% of record steps are one second, since it counts piezo records as seconds. |

## Vitals filters

| Path | Heart rate | Breathing rate | HRV |
| --- | --- | --- | --- |
| Default live, `biometrics/stream/biometric_processor.py` | HeartPy bounds 40 to 90 bpm; a rate over 90 is dropped, which leaves a gap | Updates accepted at 8 to 20 breaths/min | SDNN updates accepted at 8 to 200 ms |
| Standalone recomputation, `biometrics/vitals/calculations.py` (does not run as supplied) | HeartPy bounds 40 to 90 bpm | 10 to 23 breaths/min | 10 to 100 ms |
| New estimators, `biometrics/vitals2/gates.py` | `HR_RANGE` 35 to 140 bpm, plus quality, motion and signal gates | `RESP_RANGE` 6 to 30 breaths/min, plus a quality gate | Needs interval coverage; see [DEVELOPER.md](../biometrics/DEVELOPER.md) |

How rejected and missing values are stored is in
[DEVELOPER.md](../biometrics/DEVELOPER.md#vitals-and-missing-values).

`HR_RANGE` and `RESP_RANGE` are plausibility bounds: an estimate outside them
is dropped. I set them wider than the older paths' limits so the limits stop
shaping the result (the old 90 bpm ceiling drops every faster reading). The
exact edges are round numbers, not tuned values. The estimators search a
little past them (heart rate up to 150 bpm, breathing 5 to 36 a minute), so a
rate near an edge can still be found.

## Server and sensor-health settings

| File | Constant | Value | Meaning |
| --- | --- | --- | --- |
| `server/src/8sleep/presenceAutoOffMonitor.ts` | `PRESENCE_AUTO_OFF_MS` / `CHECK_INTERVAL_MS` | 45 min / 60 s | A side on with nobody reported for 45 minutes is turned off, checked once a minute to match the presence heartbeat. Skipped inside a scheduled sleep, while paused or away, and when presence is unknown. |
| `server/src/8sleep/presenceStale.ts` | `PRESENCE_STALE_MS` | 5 min | Presence older than this is unknown to auto-off: five missed heartbeats. |
| `server/src/jobs/primeScheduler.ts` | calibration times | 18:30 left / 19:00 right | Evening times when the bed is usually empty. |
| `biometrics/stream/stream.py` | `STREAM_HEALTH_INTERVAL_SECONDS` / `SOURCE_IDLE_SECONDS` | 60 s / 30 min | Stream health heartbeat, and how long without a sensor record before System status reports sleep tracking stopped. |
| Same file | `NATS_SILENT_SECONDS` | 2 min | A connected stream with no sensor records for this long gets the RAW files read alongside it. |
| `biometrics/stream/pump_speed.py` | `PUMP_HIGH_RPM` / `PUMP_STALE_SECONDS` | 2,500 rpm / 30 s | A `frzHealth` frame at or above this speed marks the pump fast; a frame older than 30 s, or none yet, leaves it unknown. Once a pump frame has arrived, the newer vitals keep a window only when frames show the pump slow throughout. A stream with no pump frames skips this check and warns once. |
| `biometrics/service_health.py` | `SENSOR_TEMPS_UPDATE_INTERVAL` | 30 s | Throttle on sensor-temperature reports. |
| Same file | `_PUMP_RPM_STALL_THRESHOLD` / `_PUMP_TEC_ACTIVE_AMPS` | 200 rpm / 1.0 A | Pump stall alert. Bed tuning from the 1900 to 2000 rpm running speed of my Pod 5; not known to hold for other pump revisions. |
| Same file | `_PUMP_STALL_DWELL_FRAMES` / `_PUMP_RECOVERY_DWELL_FRAMES` | 6 / 3 frames | `frzHealth` frames arrive about every 10 s; six in a row raise the alert, three clear it. |
| `server/src/8sleep/loadDeviceStatus.ts`, `server/src/routes/deviceStatus/updateDeviceStatus.ts` | level to Fahrenheit | 82.5 and 27.5 | Converts the level scale to Fahrenheit, inlined in both files. A calculation, not a measured cover temperature. |
