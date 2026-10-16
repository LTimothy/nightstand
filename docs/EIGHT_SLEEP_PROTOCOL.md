# Eight Sleep Pod protocol notes

A consolidated reference for what's been reverse-engineered about the Pod's
local hardware protocol, the `dac.sock` command set, the RAW biometrics
telemetry stream, and a few other odds and ends. This is our own working
notes, cross-checked against other independent reverse-engineering projects
where noted. These are unofficial notes. See [Credits & sources](#credits--sources)
for the sources; each entry records what was tested.

Every entry below is tagged with a verification status:

- ✅ **Verified against our hardware**, we've sent/read this ourselves and
  confirmed the effect (or read live values from this pod).
- 📖 **Documented elsewhere, not independently verified**, another project
  states this; we haven't tested it ourselves.
- ❌ **Tested, did not work as documented**, we tried it and it didn't do
  what the source claimed, on our hardware (Pod 5) as of the date noted.
- ❓ **Unverified guess**, nobody's confirmed this; it's a plausible name
  based on position/pattern only.

## `dac.sock`, the hardware control socket

Free-sleep's Node server (`server/src/8sleep/frankenServer.ts`, referred to
internally as "Franken") *is* the socket server at `dac.sock`, the pod's own
firmware component connects to it as a client and answers text commands. This
is the same socket Eight Sleep's own `dac` process used to own before
free-sleep replaced it. Protocol: write `<cmd>\n<arg>\n\n` when there is an
argument, or `<cmd>\n\n` without one; read back a newline-delimited response.
Nightstand's [socket implementation](https://github.com/LTimothy/nightstand/blob/dbc024b00d79d0f79e6c8f8bf9f2a740c2e38333/server/src/8sleep/frankenServer.ts)
appends the blank-line separator after the command and optional argument.

| # | Name | Args | Status | Notes |
|---|------|------|--------|-------|
| 0 | `HELLO` | none | ✅ | Returns `ok`. Used as a liveness check. |
| 1 | `SET_TEMP` | ? | ❓ | Named by position only; free-sleep doesn't use it: temperature is set via `TEMP_LEVEL_LEFT`/`TEMP_LEVEL_RIGHT` (11/12) instead. |
| 2 | `SET_ALARM` | ? | ❓ | Named by position only; free-sleep uses `ALARM_LEFT`/`ALARM_RIGHT` (5/6) instead. |
| 3 | `REBOOT` | none | 📖 (8rp) | Reboots the device. Free-sleep has this commented out as `RESET` and doesn't call it: the pod's daily reboot schedule reboots at the OS level instead, not through this socket. |
| 4 | `FORCE_RESET` | ? | ❓ | Commented out, never used or tested. |
| 5 | `ALARM_LEFT` | CBOR alarm string | ✅ | Free-sleep uses this actively. Encodes target time (unix ts), duration (seconds), vibration pattern (`double` or `rise`), power level (0-100). Nightstand sends `rise` only when both hub and cover are reported as Pod 5, otherwise `double`, see [other Pod generations](#other-pod-generations). |
| 6 | `ALARM_RIGHT` | CBOR alarm string | ✅ | Same shape as 5, right side. |
| 7 | `FORMAT` | ? | ❓ | Commented out, never used or tested. Sounds destructive: do not try without a strong reason and a backup plan. |
| 8 | `SET_SETTINGS` | CBOR settings string | ✅ | Free-sleep uses this actively. Encodes `gl`/`gr` (left/right piezo gains) and `lb` (LED brightness), see the settings observation below. |
| 9 | `LEFT_TEMP_DURATION` (aka `TURN_ON_LEFT`) | integer seconds | ✅ | Free-sleep uses this to turn a side on/off: `0` = off, `43200` (12h) = on. |
| 10 | `RIGHT_TEMP_DURATION` (aka `TURN_ON_RIGHT`) | integer seconds | ✅ | Same as 9, right side. |
| 11 | `TEMP_LEVEL_LEFT` | integer level, -100..100 | ✅ | Free-sleep uses this actively. Command transport verified. The app's legacy level-to-°F formula is not the firmware target scale (see below). |
| 12 | `TEMP_LEVEL_RIGHT` | integer level, -100..100 | ✅ | Same as 11, right side. |
| 13 | `PRIME` | none (arg ignored) | ✅ starts, ❌ can't stop | Starts a priming cycle. `isPriming` goes `true` ~10s after the command and clears on its own after ~11-12 minutes: a genuinely long operation, not a quick flush. No known way to stop one early (see [below](#priming-cancellation)). |
| 14 | `DEVICE_STATUS` | none | ✅ | Returns the full status blob: see [DEVICE_STATUS response fields](#device_status-response-fields) below. |
| 15 | n/a | n/a | ❓ | Unused/unknown. Not referenced by free-sleep, jmew, or 8rp. |
| 16 | `ALARM_CLEAR` | none | ✅ | Upstream free-sleep uses this to stop an active alarm vibration. Nightstand dismissal uses a side-specific one-second replacement and sends no `ALARM_CLEAR`. Other projects send a side argument, and a Pod 3 report says it does not stop a running alarm, see [other Pod generations](#other-pod-generations). |
| 17 | `STOP_PRIME` / `ALARM_SOLO` (disputed) | unverified | 📖 unverified, ❌ cancellation on my Pod 5 | [8rp](https://github.com/Schluggi/8rp/blob/main/docs/commands.md) names it `STOP_PRIME`, as Nightstand used to. [Upstream free-sleep's commented command table](https://github.com/throwaway31265/free-sleep/blob/e5172139874a274d1ced12c8da052ab2cbaa286d/server/src/8sleep/deviceApi.ts#L23) and [seanpasino/free-sleep](https://github.com/seanpasino/free-sleep/commit/50580edff36e6a632f7d29ec4b8c69ceb3b62c93) name it `ALARM_SOLO`, a whole-bed alarm. Neither meaning is confirmed here. On my Pod 5, sending it before and after priming was confirmed active left `isPriming` true for 5+ minutes with no visible effect. [Nightstand 3.6.1 removed it from the command table and API](https://github.com/LTimothy/nightstand/commit/3c394e10b55bf20c9ac1fb10274070c08bf06bd0); do not add a cancellation action without a positive hardware test. |

Alarm duration (`du`) is in seconds. A [published RAW sample](https://github.com/davidsilva2841/8sleep_biometrics/commit/0dd440b7483b984d18b65f163d7041460a3a38c8)
logs `dur 179` at the hub and `dur 179000 ms` at the sensor, followed by
`ramp power to 10` for `rise` (pattern 255 in that sample). 📖 The sample's
Pod model is not stated; it does not establish a ramp rate or that `rise`
works on every generation. See [other Pod generations](#other-pod-generations)
for the separate Pod 3 intensity report.

### Temperature levels and reported targets

Nightstand's `82.5 + (level/100) * 27.5` formula is a legacy display and
command convention, not a verified firmware temperature scale. Saved
Fahrenheit values and outgoing level commands keep that convention.
`frzTherm.target` reports the thermostat target in Celsius, separately from
measured water or mattress temperature.

In offline RAW captures from my Pod 5, I found 33 target-setting log entries
with these 14 distinct pairs. These observations cover my Pod 5, not all
generations or firmware versions.

| Firmware level | Logged target °C | Occurrences |
|---:|---:|---:|
| -100 | 10.00 | 1 |
| -71 | 18.48 | 1 |
| -60 | 19.80 | 1 |
| -49 | 21.12 | 3 |
| -42 | 21.96 | 1 |
| -38 | 22.44 | 2 |
| -31 | 23.28 | 2 |
| -27 | 23.76 | 2 |
| -24 | 24.12 | 3 |
| -20 | 24.60 | 1 |
| -16 | 25.08 | 8 |
| -9 | 25.92 | 2 |
| 2 | 27.36 | 2 |
| 27 | 31.86 | 4 |

The eleven sampled levels from -71 through -9 fit `27 + 0.12 * level` °C;
the two positive sampled levels fit `27 + 0.18 * level` °C. Interpolation,
the breakpoint and the cold-end transition remain inferred. Levels -99
through -72 and above 27 are undetermined. Do not extrapolate these fits
into command conversions. At -100 the observed target is 50°F, while the
legacy display shows 55°F. The worst observed difference is 5°F; the
whole-range error is unknown.

Telemetry corroborates targets through level 2, except that -60 reports
19.790001°C rather than the logged 19.80°C. Its cause is unknown. All four
level-27 logs occur during startup and subsequent thermostats are disabled,
so 31.86°C is a logged conversion, not a confirmed active target.

<a id="priming-cancellation"></a>

### `PRIME` / priming cancellation on the tested Pod 5

Cancellation has not been demonstrated on the tested Pod 5:

- On my Pod 5, command 17 (`STOP_PRIME` per 8rp) had no observable effect,
  see above. Its removal in 3.6.1 does not establish its meaning.
- `opensleep`'s lower-level protocol notes (direct STM32 serial, Pod 3)
  list one prime command and no stop/cancel variant.
- `ninesleep` sends `13\n\n` with no argument; a code comment there
  speculates about one but the implementation doesn't use it.

On the tested Pod 5, "Prime now" and daily priming run to completion.
Other models and firmware may behave differently.
Open a PR if you find a working cancel command.

### `DEVICE_STATUS` response fields

Response is newline-delimited `key = value` text, values as strings.

| Field | Meaning | Status |
|---|---|---|
| `tgHeatLevelL` / `tgHeatLevelR` | Target heat level, -100..100 | ✅ |
| `heatLevelL` / `heatLevelR` | Current heat level, -100..100: **this is the hub sensor reading water temp near the heating element, not a direct bed-surface reading.** See [pump-stall caveat](#pump-stall-can-make-heatlevel-lie) below. | ✅ |
| `heatTimeL` / `heatTimeR` | Seconds remaining until this side auto-shuts-off | ✅ |
| `sensorLabel` | Hardware revision string for the cover sensor; free-sleep parses the 3rd `-`-delimited segment to guess Pod generation (`J00+`→Pod 5, `I00+`→Pod 4, `H00+`→Pod 3) | ❓ Unconfirmed thresholds, see [hardware generation detection](#hardware-generation-detection) for the conflicting public sources. |
| `waterLevel` | `"true"`/`"false"`: whether the reservoir has enough water | ✅ |
| `priming` | `"true"`/`"false"`: whether a priming cycle is active | ✅ |
| `settings` | Hex-encoded CBOR blob: `gl`/`gr` (left/right piezo gains), `lb` (LED brightness) | ✅ On my Pod 5, `{v: 1, gl: 400, gr: 400, lb: 4}` accompanied a firmware log `[sampling] req gain 400 400`. |
| `doubleTap` / `tripleTap` / `quadTap` | JSON string `{l, r, s}`: unix timestamp (or `0`) of the last tap gesture per side/sensor. free-sleep uses `quadTap` to cycle the adjustable-base preset. | ✅ |
| `dismissAlarm` | JSON object keyed by `l` and `r`, with numeric values that upstream free-sleep treats as dismissal timestamps. Nightstand baselines each alarm on its first valid status after starting. The first valid sample after reconnecting can only raise that alarm's high-water mark. Decreases and restored historical values do not dismiss it. Missing or malformed values and the unmapped `s` channel are ignored. Only a later value strictly above the highest seen for that alarm across all connections clears it, without sending a command. | ✅ On my Pod 5, the value rose after a double tap stopped a Nightstand alarm, and Nightstand cleared its ringing state and logged the dismissal. Timestamp units remain unverified. Reading adapted from the [upstream monitor](https://github.com/throwaway31265/free-sleep/blob/a35972d839a68a1a7a78c57085edf7a5a4be314d/server/src/8sleep/frankenMonitor.ts#L350). |

On the tested Pod 5, a double or triple tap during an alarm stops it in the
firmware, regardless of the tap settings. The gesture is not reported to
Nightstand through the tap counters, so the alarm tap action cannot snooze
it. Nightstand clears its ringing record when that side's `dismissAlarm`
value increases beyond the highest value seen for that alarm across all
connections. I confirmed this on my Pod 5 with a double tap during a
Nightstand alarm. There is no verified firmware ringing flag in the status
fields used here.

## RAW biometrics stream record types

Separate from `dac.sock`, this is the CBOR record stream the pod firmware
writes to `/persistent/*.RAW` (piezo/capacitance/health telemetry), which
the RAW archiver (from [jmew/free-sleep](https://github.com/jmew/free-sleep))
hardlinks into
`/persistent/free-sleep-data/raw-archive/` before the firmware's rolling
buffer truncates it. See `biometrics/load_raw_files.py` and
`biometrics/stream/stream.py`.

| `type` | Contents | Consumed by free-sleep? |
|---|---|---|
| `piezo-dual` | Raw piezo sensor waveform, both sides | ✅ yes: core presence/vitals signal |
| `capSense` (Pod 3, possibly some Pod 5, and a Pod 4 hub with a Pod 5 cover) / `capSense2` (Pod 5 newer cover; a Pod 4 cover not confirmed) | Capacitance sensor readings; Pod 5's `capSense2` shape is normalized to the legacy `capSense` fields (`out`/`cen`/`in`) | ✅ yes |
| `bedTemp` (Pod 3, v1 integer centidegrees; also a Pod 4 hub with a Pod 5 cover) / `bedTemp2` (Pod 4/5, float °C, `temps[]` array) | Bed-surface temperature sensors. On my Pod 5, `bedTemp2` has `{version: 1, mcu, left: {amb, hu, board, temps: [four values]}, right: {...}}`; `-327.68` marks a missing reading, including in `temps`, `amb` and `hu`. | `bedTemp` yes; `bedTemp2` surface temperatures are not used yet |
| `frzTemp` | `{amb, hs, left, right}`: ambient, heatsink, and per-side hub sensor temps in centidegrees C | ✅ yes: feeds the Settings page sensor-temp display |
| `frzHealth` | `{left, right, fan}`, each side `{tec: {current}, pump: {mode, rpm, water}, temps: {flowrate}}`: see [pump/thermal telemetry](#pumpthermal-telemetry-frzhealth) below. Not written by every firmware: see [other Pod generations](#other-pod-generations) | ✅ yes: pump-stall detection and pump-speed checks for the newer vitals estimators |
| `frzTherm` | `{version: 1, left, right}`, each `{target, power, valid, enabled}` on my Pod 5; target is Celsius, and negative power was observed while cooling | ✅ decoded from offline captures on my Pod 5; optional target readout and cooling diagnostics |
| `log` | `{type, ts, level, msg}`, firmware's internal messages, including Pod 5 cover button presses (see [other Pod generations](#other-pod-generations)). Several log records can share one RAW envelope's `data` payload. | ✅ observed on my Pod 5; optional allowlisted health feed and dismissal diagnostics; no raw text sent to clients |
| `buttonEvent` | `{type, ts, left/right: {top/bottom: count}}`, the temperature buttons via the TCA8418 keypad | ✅ on my Pod 5, five right-side events (three `top: 1`, two `bottom: 1`), alongside `[tca8418R]` logs; optional diagnostics |
| `tap-gesture` | `{type, ts, side, taps}` | Optional diagnostics only. 📖 [Reported by dallonby on a Pod 3 hub with a Pod 4 cover](https://github.com/throwaway31265/free-sleep/pull/30), which reports no taps in `DEVICE_STATUS`; not seen on my Pod 5 |

These Pod 5 shapes are observations from my offline RAW captures. One
envelope contained 14 `log` records; decoding only the first CBOR object
would miss the others. The `buttonEvent` records identify top and bottom
buttons, not cover tap gestures. Four accompanied `temp_up`/`temp_down`
logs; the fifth accompanied `off | off`, so a button record alone does not
prove a temperature change. The public [RAW samples](https://github.com/davidsilva2841/8sleep_biometrics/commit/0dd440b7483b984d18b65f163d7041460a3a38c8)
also show `log` fields; dallonby's [tap reader](https://github.com/dallonby/free-sleep/commit/514086f96919699230227b74d8872c60aa743892)
documents the separate `tap-gesture` shape.

On my Pod 5, `[tca8418R] gpi press 97` and `gpi release 97` are followed
by `[TTC] right top button clicked 1 times` and `[buttons] enc {id:0,clicks:1}`,
then `[thermostat] temp_up right -24->-14`. Two quick clicks report
`clicks:2` and "clicked 2 times". The firmware changes the target itself by
10 levels per click, so the buttons already work without Nightstand.
The Pod 4 hub with a Pod 5 cover instead logs `[TTC] ignoring N short clicks`
for plus and minus. My Pod 5 also logs a stray `gpi press 105` with
`invalid gpi->row 105->255` every five minutes.

### Pump/thermal telemetry (`frzHealth`)

Decoded `frzHealth` example from my Pod 5, with the timestamp replaced:

```python
{'type': 'frzHealth', 'ts': 0, 'version': 1,
 'left':  {'tec': {'current': 11.99}, 'pump': {'mode': 'pwm', 'rpm': 1928, 'water': True}, 'temps': {'flowrate': 24.94}},
 'right': {'tec': {'current': 7.86},  'pump': {'mode': 'pwm', 'rpm': 2000, 'water': True}, 'temps': {'flowrate': 24.63}},
 'fan': {'top': {'rpm': 414}, 'bottom': {'rpm': 318}}}
```

- `pump.rpm`: healthy/running is ~1900-2000 on this pod; idle/off is exactly
  0 with no ramp. The gap is wide (~1900), so any threshold from ~200-1800
  reliably separates the two states.
- `temps.flowrate`: **this is loop water temperature in °C, not a literal
  flow rate**, it reads ~25°C regardless of pump RPM (matches
  sleepypod/core's ADR 0022, confirmed against this pod's own data). Not
  used for stall detection for that reason, `tec.current` combined with
  `pump.rpm`/`pump.water` is used instead. Potentially useful later for
  clog detection (compare loop temp to bed temp under load).
- `tec.current`: reported current in amps. In one capture on my Pod 5 it
  stayed at 10.7213 A left and 11.5162 A right with both running and stopped
  pumps. It cannot by itself establish that a side is actively heating or
  cooling; correlate it with thermostat and pump state.
- `pump.water`: boolean, appears to be the firmware's own water-flow-sensed
  flag.
- Frame cadence observed: ~1 every 10 seconds.

### Pump-stall can make `heatLevel` lie

The hub water-temperature sensor (`heatLevelL`/`heatLevelR` in
`DEVICE_STATUS`, and `frzTemp`'s `left`/`right`) sits in the same housing as
the heating/cooling element, not in the bed. While the pump circulates, it
reads meaningful moving-water temperature. If the pump stalls while the
element keeps drawing current, the sensor instead reads stagnant water next
to a powered heater, a runaway number that does not reflect actual bed
temperature.

This failure has been reported in practice, with a bed reading 102°F
overnight against an 84°F setpoint until a power cycle cleared it;
sleepypod/core documents the same root cause in their ADR 0022. Nightstand
v3.0.0+ watches `frzHealth` for this (TEC actively drawing current + pump
RPM near zero or `water: false`, sustained for a dwell window) and surfaces
it in Settings > Pod and diagnostics > System status as "Pump health." Detection and visibility only,
no automatic power-off, since a safe automatic response is a bigger call
than a detection threshold.

## Adjustable base (BLE)

Separate from everything above, the adjustable base is controlled over
Bluetooth LE via `bluetoothctl`, not `dac.sock`. See
`server/src/8sleep/trimixBaseControl.ts` for the packet format (20-byte
frames, `0xff 0xff 0xff 0xff` header, a 2-byte checksum). Not duplicated here;
that file is the source of truth and already has inline documentation.
The driver and angle maps came from [Geczy/free-sleep](https://github.com/Geczy/free-sleep/commit/74d6439c0fffbd634e3b84ec054cb52d741eddab)
([angle maps](https://github.com/Geczy/free-sleep/commit/fccb7916fbf3f8f1e0da4324de57bdf1a1fe12a4));
the [preset integration](https://github.com/Geczy/free-sleep/commit/c17cb0866489889b2230f698e99eb74184c15623)
includes the HTTP route, app API client and four-tap base action. I have
not verified base control on a physical base.

## Hardware generation detection

Nightstand's `detectCoverVersion` and `detectHubVersion` in
[`loadDeviceStatus.ts`](https://github.com/LTimothy/nightstand/blob/dbc024b00d79d0f79e6c8f8bf9f2a740c2e38333/server/src/8sleep/loadDeviceStatus.ts)
guess Pod 5 from cover revision `J00` and up and hub revision `G53` and up.
The comments cite Discord, not an official specification. ❓ Both
thresholds are unconfirmed.

📖 [Geczy's hardware page](https://github.com/Geczy/free-sleep/commit/39e2b25e631299e26a175f375b7914336e364b80)
instead uses cover `J50` and up and hub `G40` and up for Pod 5. Its comments
cite a `J55` Pod 5 cover, an `I14` Pod 4 cover and one user's `G43` Pod 5
hub. Those observations do not confirm the boundaries either. This
disagreement is unresolved; no detection thresholds change here. Pod
owners can help by sharing the hub and cover model and hardware-revision
segments from their labels, with serial numbers omitted.

<a id="other-pod-generations"></a>

## Other Pod generations

I test on my Pod 5. These notes come from other owners and projects and
have not been verified here. The Pod 4 hub with a Pod 5 cover reports
come from [2-X](https://github.com/2-X), with RAW records and firmware log
lines from that bed.

- 📖 **Alarm pattern.** Pod 3 firmware accepts only `double`: with `rise`
  it answers with an error code and does not vibrate
  ([throwaway31265/free-sleep#55](https://github.com/throwaway31265/free-sleep/issues/55)).
  Pod 4 firmware logs an invalid pattern and falls back to `double`
  ([jmakes/free-sleep](https://github.com/jmakes/free-sleep/commit/9be14cdb)).
  sleepypod's notes say the two patterns feel the same on a Pod 5
  ([sleepypod alarms notes](https://github.com/sleepypod/core/blob/dev/docs/hardware/alarms.md)).
  Nightstand sends the chosen pattern only when both hub and cover are
  reported as Pod 5. It sends `double` for mixed, older or unknown hardware.
  The app offers "Builds up" only when both are reported as Pod 5. Saved
  schedules keep accepting `rise`.
- 📖 **Alarm intensity ramp.** On the Pod 3 in
  [free-sleep#55](https://github.com/throwaway31265/free-sleep/issues/55),
  intensity was reported as a ceiling: power starts at 10 and rises on
  roughly an eight-second cadence, reaching about 37 after two minutes.
  This is separate from the `rise` sample above; that Pod 3 rejects `rise`.
  Neither report establishes the ramp rate on my Pod 5.
- 📖 **Mixed hub and cover.** dallonby reports a Pod 3 hub with a Pod 4
  cover: taps are absent from `DEVICE_STATUS`, while RAW contains
  `tap-gesture` records
  ([free-sleep#30](https://github.com/throwaway31265/free-sleep/pull/30)).
  Hub and cover generation can therefore differ; the socket tap counters
  alone do not establish whether that combination detects gestures.
- 📖 **Stopping a running alarm.** On a Pod 3, `ALARM_CLEAR` with the
  argument `empty` produced no firmware log line and the alarm ran its full
  length; re-sending `ALARM_LEFT`/`ALARM_RIGHT` with a duration of 1 second
  replaced the running alarm and stopped it
  ([throwaway31265/free-sleep#54](https://github.com/throwaway31265/free-sleep/issues/54)).
  sleepypod sends `ALARM_CLEAR` with `0` (left) or `1` (right) on a Pod 5
  and notes that a clear sent within about 100 ms of the start cancels the
  alarm before it is felt. Whether the side argument works on a Pod 3 has
  not been tested. Nightstand dismisses a tracked ringing alarm with a
  one-second replacement on that side, without an unscoped clear. Dismissing
  an idle side sends no alarm command. Replacement-only dismissal and partner
  isolation still need physical confirmation on Pod 4 and Pod 5.
  Before release, the owner must authorize and complete a physical Pod 5
  dismissal check: each side ringing alone, both sides ringing with
  dismissal in each direction, dismissal of an idle side, and a subsequent
  alarm. Record the hub, cover and firmware versions and confirm that the
  partner keeps ringing. This is a hardware release gate; mocked command
  assertions do not verify replacement effectiveness or partner isolation.
- 📖 **`SET_SETTINGS` keys.** The firmware reads only the two-letter keys
  `v`, `gl`, `gr` and `lb`, and a write changes only the keys it contains
  (sleepypod, Pod 5,
  [sleepypod/core#607](https://github.com/sleepypod/core/pull/607)).
  On a Pod 3, [ninesleep](https://github.com/bobobo1618/ninesleep) sets
  the light by sending `lb` on its own. opensleep describes the
  Pod 3 light as an I2C LED driver that other firmware processes also
  write to
  ([opensleep background](https://github.com/LiamSnow/opensleep/blob/main/BACKGROUND.md)),
  so a brightness write may be overridden. Reading `settings` back from
  `DEVICE_STATUS` shows whether a write took.
- 📖 **Capacitance scale.** Pod 3 `capSense` reports three integer channels
  per side, and someone getting into bed moves them by hundreds. Pod 5
  `capSense2` values move by about 5 to 20
  ([sleepypod sensor profiles](https://github.com/sleepypod/core/blob/dev/docs/hardware/sensor-profiles.md)).
  Nightstand's presence thresholds were checked against Pod 5 data only.
- 📖 **Which capacitance format.** sleepypod's notes tie `capSense2` to the
  newer Pod 5 cover and report one Pod 5 on newer firmware writing `capSense`
  ([sleepypod sensor profiles](https://github.com/sleepypod/core/blob/main/docs/hardware/sensor-profiles.md),
  [NATS frame notes](https://github.com/sleepypod/core/blob/main/docs/nats-frame-readers.md)).
  We have not found a published Pod 4 cover capture of either. Nightstand
  therefore reads the format from the records and treats anything but
  `capSense2` on a Pod 5 as experimental. On `capSense` its new sleep tracking
  starts from sleepypod's `capSense` entry level of 300 counts
  ([sleepypod sleep detector](https://github.com/sleepypod/core/blob/main/docs/sleep-detector.md))
  and then learns each side's own level.
- 📖 **A Pod 4 hub with a Pod 5 cover.** The two fit together and run
  Nightstand. `DEVICE_STATUS` reports the cover as a Pod 5 through
  `sensorLabel` and the hub as a Pod 4, so alarms go out as `double` and
  the model-gated features treat the bed as unchecked. Its RAW files hold
  `capSense` and `bedTemp` records, not `capSense2` or `bedTemp2`, on both
  the host firmware from February 2025 and a newer host with Frozen 1.5.58.
- 📖 **`frzHealth` depends on the host firmware.** The Pod 4 host firmware
  from February 2025 writes `piezo-dual`, `capSense`, `bedTemp`, `frzTemp`
  and `log` records and no `frzHealth` at all (a scan of three RAW files
  found 2,896 `capSense`, 1,447 `piezo-dual`, 145 `bedTemp`, 145 `frzTemp`
  and 55 `log` records, and the binary carries no `frzHealth` string). The
  same hub wrote `frzHealth` about every 10 seconds once it ran a newer
  host firmware with Frozen 1.5.58, with the pumps reading about 1,900 to
  2,000 rpm while circulating and 0 when off, as on the Pod 5 above. On a
  Pod without `frzHealth`, pump health stays `not_started` and the newer
  vitals estimators report the pump speed as unknown.
- 📖 **Cover buttons on a Pod 4 hub with a Pod 5 cover.** Each side has
  three buttons (plus, logo, minus) on a TCA8418 keypad. The firmware logs
  every press and release to the RAW `log` records as `[tca8418R] gpi press 97` and
  `[tca8418R] gpi release 97` (`L` for the left side; codes 97, 98 and 99
  are the plus, logo and minus buttons). A short click on plus or minus
  is logged as `[TTC] ignoring N short clicks` and does nothing: it changes
  no tap counter and no temperature. On the February 2025 Pod 4 host
  firmware a long press was logged as `[buttons] top button held for 320ms (abort)` and also did
  nothing. On the newer host firmware a press held for 500 ms is logged as
  `[buttons] long press top: 500ms` before the release, then `[TTC]
  temperature up gesture`, the firmware plays a short vibration of its
  own, and the gesture reaches `DEVICE_STATUS` through the tap counters:
  a long press on plus as `tripleTap`, a short click on the logo as
  `quadTap`, and a long press on minus presumably as `doubleTap`. The
  firmware changes no target itself; the step comes from Nightstand's tap
  action, so with the default actions long presses step by the tap
  amounts and the logo button tries to move an adjustable base, which
  fails harmlessly when none is paired. The Pod 5 hub handles short clicks
  differently, as noted above. The firmware batches about a minute of `log`
  records into one RAW chunk, so a press can be 15 to 25 seconds old
  before it is readable; in one archive 3 of 93 presses were older than 15
  seconds.
- 📖 **Files the firmware keeps in `/persistent`.** Pod 3 firmware reads
  `frozen.heartbeat` relative to its working directory; moving it made the
  firmware reload every 30 seconds and leak file descriptors
  ([sleepypod/core#690](https://github.com/sleepypod/core/issues/690)).
  Leave `SEQNO.RAW`, `frozen.heartbeat`, `alarm.cbr` and `uptime.log` in
  place when cleaning up RAW files.
- 📖 **Firmware without RAW files.** Firmware from about April 2026 writes
  sensor data to a NATS JetStream stream and creates no `.RAW` files
  ([sleepypod ADR 0018](https://github.com/sleepypod/core/blob/dev/docs/adr/0018-tmpfs-raw-frames.md)).
- 📖 **Reset completion.** A Pod 4 owner reported that powering off while
  the reset light still blinked green left `/extlinux/extlinux.conf`
  unreadable. Wait for the light to blink blue (pairing mode) before
  powering off after a firmware reset
  ([free-sleep#12](https://github.com/throwaway31265/free-sleep/issues/12#issuecomment-2902456458)).
- 📖 **Boot slot after reinstall.** A user who still saw `current_slot=b`
  after reinstalling the firmware reported that `setenv current_slot a`,
  then `saveenv`, then `reset` allowed installation to continue
  ([free-sleep#45](https://github.com/throwaway31265/free-sleep/issues/45#issuecomment-4058193796)).
  This persists the slot choice and boots whatever is in slot `a`; it is
  a user report, not a verified recovery procedure here.

Reported by users, not verified here:

- Pod 3 with sensor firmware 3.0.5 and Frozen firmware 1.1.40
  ([caseyWebb, #55](https://github.com/throwaway31265/free-sleep/issues/55)).
- Pod 3 without an SD card, running firmware
  `444c5a9ee7c7092120ec19a12ed964b6f7865a41` and NATS JetStream instead of
  RAW files ([jfrykman, #58](https://github.com/throwaway31265/free-sleep/pull/58)).
- Pod 3 hub with a Pod 4 cover
  ([dallonby, #30](https://github.com/throwaway31265/free-sleep/pull/30)).
- Pod 4 installed through serial
  ([shiftforce240, #12](https://github.com/throwaway31265/free-sleep/issues/12)).
- A pictured newer Pod 5 Core control-board revision, with a maintainer
  reply saying it worked
  ([simonepsp, #33](https://github.com/throwaway31265/free-sleep/issues/33),
  [reply](https://github.com/throwaway31265/free-sleep/issues/33#issuecomment-3659260445)).

## Credits & sources

- [Schluggi/8rp](https://github.com/Schluggi/8rp), `dac.sock` command
  table and `DEVICE_STATUS` field names.
- [sleepypod/core](https://github.com/sleepypod/core), pump-stall failure
  mode, the `flowrate`-is-temperature correction, `frzHealth`/`frzTherm`
  wire shapes (their ADR 0022), and the Pod 5 alarm, `SET_SETTINGS`,
  capacitance, `/persistent` and RAW-less firmware notes under
  [other Pod generations](#other-pod-generations).
- [LiamSnow/opensleep](https://github.com/LiamSnow/opensleep), lower-level
  STM32 serial protocol (Pod 3 hardware; not confirmed to match Pod 5) and
  the Pod 3 light driver notes.
- [bobobo1618/ninesleep](https://github.com/bobobo1618/ninesleep), cross-
  checked `dac.sock` client implementation.
- [caseyWebb](https://github.com/caseyWebb), Pod 3 alarm findings in
  throwaway31265/free-sleep#54 and #55.
- [jmakes/free-sleep](https://github.com/jmakes/free-sleep), Pod 4 alarm
  pattern behavior.
- [2-X](https://github.com/2-X), the Pod 4 hub with a Pod 5 cover notes:
  record formats, `frzHealth` by host firmware, and the cover buttons.
- [Geczy/free-sleep](https://github.com/Geczy/free-sleep/commit/39e2b25e631299e26a175f375b7914336e364b80),
  conflicting hardware-generation thresholds and the base-control work
  linked above.
- [davidsilva2841/8sleep_biometrics](https://github.com/davidsilva2841/8sleep_biometrics/commit/0dd440b7483b984d18b65f163d7041460a3a38c8),
  published RAW log samples, alarm duration and initial ramp power.
- [dallonby](https://github.com/throwaway31265/free-sleep/pull/30), mixed
  Pod 3 hub/Pod 4 cover tap reports and the `tap-gesture` reader.
- [shiftforce240](https://github.com/throwaway31265/free-sleep/issues/12)
  and [Ejwittig](https://github.com/throwaway31265/free-sleep/issues/45),
  reset completion and boot-slot reports.
- [jmew/free-sleep](https://github.com/jmew/free-sleep/commit/3ffaa0d), the
  RAW-file archive that keeps overnight data past the firmware's rolling
  buffer.

Add new findings here with a source and verification status, worth knowing
whether something was tested or just copied from a doc.
