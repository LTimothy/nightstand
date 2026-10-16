# Integrations

Nightstand serves the free-sleep HTTP API on port 3000. Home Assistant,
Homebridge and scripts can use it over a trusted network. There is no
login: anyone who can reach the API can control the bed and read its data.
For remote access, see [Tailscale](REMOTE_ACCESS.md). The complete route
reference is [server/API.md](../server/API.md).

## Home Assistant

These community integrations speak the same core API:

| Integration | Checked source | Notes for Nightstand |
|---|---|---|
| [Mrtenz/hass-free-sleep](https://github.com/Mrtenz/hass-free-sleep) | [ddf0c5e](https://github.com/Mrtenz/hass-free-sleep/commit/ddf0c5e) | Power, temperature, LED, priming, presence and vitals summary requests match. Its README schedule examples need the complete alarm object and a temperature record, as shown below. |
| [DaSonOfPoseidon/free-sleep-ha](https://github.com/DaSonOfPoseidon/free-sleep-ha) | [b390441](https://github.com/DaSonOfPoseidon/free-sleep-ha/commit/b390441) | Leave the Sentry switch disabled. Temperature durations cannot exceed 720 minutes. The format selector needs to accept `level`. |
| [NylonDiamond/free-sleep-hacs](https://github.com/NylonDiamond/free-sleep-hacs) | [d6328cc](https://github.com/NylonDiamond/free-sleep-hacs/commit/d6328cc) | Date queries need URL encoding in UTC and positive-offset zones. An unknown tap action must be shown as unknown: the default quad tap is `base_control`, not decrease temperature. |

Configure the integration with the Pod's address and port 3000 using its
own setup instructions. The compatibility checks above come from source
inspection and local route tests, not a Home Assistant or hardware session.

Mrtenz's water problem sensor treats `waterLevel` as a boolean, but the
API returns the strings `"true"` and `"false"`. A nonempty string is truthy
even when it says `"false"`. Compare the string explicitly, or use
`GET /api/serverStatus`: `waterTank.status == "failed"` means the tank has
read low for about 30 seconds.

Mrtenz's Update entity compares Nightstand's installed version with
upstream free-sleep's version. These are separate release streams. Use
Nightstand's Settings > Software for updates, or configure a client to read
[Nightstand's version](https://github.com/LTimothy/nightstand/blob/main/server/src/serverInfo.json)
and [release list](https://github.com/LTimothy/nightstand/blob/main/releases.json).
The version URL approach has a precedent in
[seanpasino's fork](https://github.com/seanpasino/hass-free-sleep/commit/e67278f).
An integration's Install action still uses Nightstand's updater and can
receive `409` while the bed may be in use.

## Homebridge

[caseyWebb/homebridge-free-sleep](https://github.com/caseyWebb/homebridge-free-sleep)
has matching power, temperature, LED, away mode and test alarm requests.
At [8f92a83](https://github.com/caseyWebb/homebridge-free-sleep/commit/8f92a83),
two response contracts need changes in the plugin:

- Its services parser requires `sentryLogging`, which Nightstand removed.
  The plugin needs to make that field optional. Without that fix it cannot
  learn whether Biometrics is enabled, so occupancy polling does not start.
- Its vitals parser requires string timestamps. Nightstand sends epoch
  seconds as numbers. The parser needs to accept numbers before
  `occupancySource: "vitals"` can work.

Leave `occupancySource` set to `"none"` until those client fixes are
installed. Nightstand does not provide a dummy Sentry field or change
vitals back to strings.

### Turn off keepAlive

Set `"keepAlive": false` in the plugin's platform configuration, then
restart Homebridge. Keep the other platform settings:

```json
{
  "platform": "FreeSleep",
  "keepAlive": false,
  "occupancySource": "none"
}
```

The plugin enables keepAlive by default. Whenever an observed on side has
less than 30 minutes remaining, it posts `secondsRemaining: 43200`, a new
12-hour timer. This includes sides turned on by Nightstand's schedule.
That write overrides the firmware off timer Nightstand armed for the end
of the sleep. The scheduled off job still runs while the server works, but
if the server stops before then, the firmware can keep the side on for
the newly posted 12 hours. Disabling keepAlive preserves Nightstand's
firmware timer. See the plugin's
[keepAlive implementation](https://github.com/caseyWebb/homebridge-free-sleep/blob/8f92a83/src/pod/keepAlive.ts).

The plugin predicts alarms from the legacy first alarm only. Later alarms,
one-time alarms and Rhythms alarms do not get its fast polling window, so
a short alarm can be missed as a HomeKit event. Integrations can use
Nightstand's [WebSocket events](../server/API.md#websocket-wsevents) to
observe status changes instead. This also addresses the push-channel
request in [caseyWebb's issue 23](https://github.com/caseyWebb/homebridge-free-sleep/issues/23).

## Scripts and request shapes

Send JSON bodies with `Content-Type: application/json`. Successful
`POST /api/deviceStatus` returns `204` with no body. Settings, schedules
and services writes return `200` with the updated object. Check the status
code before trying to parse JSON. Do not retry an alarm start blindly.

For example, from a machine permitted to control the bed, replace
`<pod-address>` with the configured address:

```sh
curl --fail-with-body 'http://<pod-address>:3000/api/deviceStatus'
curl --fail-with-body -X POST 'http://<pod-address>:3000/api/deviceStatus' \
  -H 'Content-Type: application/json' -d '{"left":{"targetTemperatureF":75}}'
curl --fail-with-body -X POST 'http://<pod-address>:3000/api/deviceStatus' \
  -H 'Content-Type: application/json' -d '{"left":{"isOn":false}}'
```

Temperatures on the wire are Fahrenheit, including when the display uses
Celsius or `level`. `currentTemperatureLevel` is a read-only raw firmware
level. Posting it is accepted but ignored. `targetTemperatureLevel` is not
accepted. A float `targetTemperatureF` is accepted, but firmware scale
rounding means it may read back as a nearby whole Fahrenheit value.

A complete weekly alarm write looks like this:

```json
{
  "left": {
    "monday": {
      "alarm": {
        "time": "07:00",
        "enabled": true,
        "vibrationIntensity": 100,
        "vibrationPattern": "double",
        "duration": 60,
        "alarmTemperature": 82
      },
      "temperatures": { "22:00": 75, "06:30": 82 }
    }
  }
}
```

Fetch the stored alarm, merge the fields being edited, then send the full
alarm object. A legacy `alarm` write updates the first item of `alarms`
and keeps all later items. Setting its `enabled` to false disables only
that first alarm. Sending `alarms` replaces the entire array; `alarms: []`
clears every alarm for that day. When both fields are sent, `alarms` wins.
The legacy `alarm` read exposes only the first item, including a disabled
one, so clients should read `alarms` to see the whole day.

Use a query encoder such as Python's `urllib.parse.urlencode` or
JavaScript's `URLSearchParams` for metric dates. A literal `+` in a URL
query decodes as a space; for example, encode `+00:00` as `%2B00%3A00`.
Dates must be ISO 8601 and `side` must be `left` or `right`.

`GET /api/deviceStatus` makes a live hardware round trip. Full
`GET /api/serverStatus` responses are shared for 15 seconds, including
concurrent requests. It writes services data only when stream health
changes. For a lightweight liveness check, use `/api/serverStatus/alive`,
which returns `204` without reading or writing data.

Sleep reads without `startTime` or `endTime` return records overlapping the
last 90 days. The app uses that window for its initial recent history and
requests explicit ranges for older weeks. Sending either bound preserves
the explicit range behavior, with no 90-day limit. Vitals and movement
rows default to 24 hours and accept at most seven days (with an hour of
daylight saving slack). Vitals summary has no default range cap.

## Differences from upstream free-sleep

Compared with upstream 3.0.3, the following contracts matter to clients.
Unknown request fields usually get `400`; extra response fields should be
ignored by clients.

| Surface | Nightstand behavior |
|---|---|
| `POST /api/deviceStatus` | `secondsRemaining` is a whole number from 0 to 43200; LED brightness is whole 0 to 100; settings `v`, `gainLeft`, `gainRight` are whole 0 to 2147483647. Read-only status fields are tolerated and ignored. |
| Temperature display | Settings adds `temperatureFormat: "level"`. It is display only; `targetTemperatureF` stays Fahrenheit. `targetTemperatureLevel` gets `400`, also on current upstream after its revert. |
| `POST /api/settings` | Strict deep partial. Adds `alarmsEnabled`, `oneOffAlarm`, `scheduleOverrides.pause`, `rawArchiveRetentionDays`, `updateChannel`, `features`, and tap types `base_control` and `set_temperature`. Invalid or past pauses get `400`. Changing `features.rhythms` here or disabling `levelTemps` while format is `level` gets `409`. |
| `POST /api/schedules` | An alarm must have all six fields. Up to 10 alarms and 48 temperature entries per day, with stored oversized days allowed to shrink. Alarm duration is 1 to 300 seconds. Legacy writes preserve later alarms. |
| `POST /api/alarm` | Duration is 1 to 300 seconds. Waits for the start command. An off or away side without `force: true` does not start and returns `503` with `error.message`, rather than upstream's silent `200`. Hardware start failures also return `503`. |
| `POST /api/execute` | `TEMP_LEVEL_*` takes a plain whole number from -100 to 100; `*_TEMP_DURATION` takes 0 to 43200. Other supplied arguments must be strings. Use the validated device-status route for normal controls. |
| `/api/services` | No `sentryLogging`. Posting it gets `400`. Additional job keys and status values may appear. |
| Metric reads | Strict ISO dates and side validation, bad queries get `400`. Vitals and movement timestamps are numeric epoch seconds. Sleep record dates are ISO strings. Row ranges and the default sleep window are bounded as described above. |
| Origin filter | A refused browser origin gets `403`. See the current [API allowlist](../server/API.md). Clients without an Origin header are allowed; this is not authentication. |
| Request bodies | JSON content type required (`415`), malformed JSON (`400`), body over 100 kB (`413`). Prototype-related keys are refused in settings, schedules and services (`400`). |
| `POST /api/jobs` | Reboot and update together get `400`; duplicate queued analysis or calibration gets `409`. Update gets `409` if a side is on, an alarm is due within 15 minutes, or state cannot be read. Reboot has no bed-in-use gate. |

## Scheduling and automation behavior

While Rhythms is on, an integration that changes the weekly power,
temperature or alarm schedule changes its fingerprint. Nightstand then
reports `fingerprint-mismatch` from `/api/rhythms` and falls back to the
weekly schedule. The feature flag stays on and the app asks which schedule
to use. The saved rhythms are kept.

To avoid this, disable integration entities or automations that write
`/api/schedules` while using Rhythms. Edit named plans through the app or
the [Rhythms API](../server/API.md#apirhythms). If a weekly edit was
intentional, choose the weekly schedule in the app. To return to the saved
rhythms, choose Rhythms in the app or call `POST /api/rhythms/enable` after
reviewing the change. Do not repeatedly re-enable it from an automation
that is also editing weekly schedules.

Other controls can affect a scheduled night:

- A manual temperature write can pause weekly temperature changes for
  12 hours when a scheduled change is within three hours, or hold the
  Smart Schedule curve. Repeated writes can extend a hold.
- With Biometrics enabled and a live stream, presence auto-off can turn a
  side off after 45 minutes without presence outside a scheduled sleep.
  A long preheat automation may therefore end before someone gets in.
- `isOn: true` starts a 12-hour timer. Use `isOn: false` to turn off;
  `secondsRemaining: 0` is currently accepted but does not turn a side off.
- When either side is in away mode, a one-side device-status write can
  control both sides.
- `rise` vibration falls back to `double` on unsupported hardware. Tap
  counters are available through WebSocket status events, not ordinary
  device-status reads. Presence with no observation timestamps is
  unobserved, not proof of an empty bed.

Client request shapes and read fields are covered by
[`integrationsContract.test.ts`](../server/src/routes/integrationsContract.test.ts).
Those tests use a local temporary database and substitute hardware and
privileged operations. They do not verify device behavior or the clients'
full UI flows.
