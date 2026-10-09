# API reference

The server listens on port 3000 and serves a REST API under `/api/` and a
WebSocket at `/ws/events`. Responses are JSON unless noted otherwise.

For Home Assistant, Homebridge and scripts, see
[Integrations](../docs/INTEGRATIONS.md), including the differences from
upstream free-sleep and the Homebridge keepAlive setting.

There is no login. A device that can reach the Pod, locally or over Tailscale,
can control it and read its data. Use a trusted network, do not port-forward
this API to the public internet, and restrict remote access.

HTTP requests and WebSocket upgrades use the same Origin filter. It accepts
HTTP(S) origins with exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`),
single-label `.local` hosts, or IPv4 addresses in the same /24 as one of the
server's non-internal network interfaces. `ALLOWED_ORIGIN` can add one
configured origin; `*` turns the filter off. An origin cannot contain
credentials, a path, a query or a fragment. A refused origin gets `403`.
Requests without an Origin header are allowed, so this filter is not
authentication or protection from non-browser clients.

Request bodies are JSON. A POST, PUT or PATCH whose body has any other
content type returns `415`. A request that takes no body, such as
`POST /api/base-control/stop`, can be sent without one. A body that is not
valid JSON returns `400`, and one larger than 100 kB returns `413`.
`/api/settings`, `/api/schedules` and `/api/services` refuse bodies with a
key named `__proto__`, `constructor` or `prototype` with `400`.

An unknown path under `/api/` returns `404 { "error": { "message": "Not Found" } }`.
When a command cannot reach the Pod's hardware, routes answer `503` with
`{ "error": { "message": "..." } }`. Other server errors answer `500` with a
generic message; the details go to the server log.

---

## `/api/deviceStatus`

### GET

- Returns the current state of the bed. Returns `503` while Franken (the
  hardware socket) is still connecting after a start, or if the Pod does not
  answer in time.

#### Response

```json
{
  "left": {
    "currentTemperatureLevel": -43,
    "currentTemperatureF": 71,
    "targetTemperatureF": 64,
    "secondsRemaining": 0,
    "isOn": false,
    "isAlarmVibrating": false
  },
  "right": {
    "currentTemperatureLevel": -47,
    "currentTemperatureF": 70,
    "targetTemperatureF": 64,
    "secondsRemaining": 0,
    "isOn": false,
    "isAlarmVibrating": false
  },
  "coverVersion": "Pod 5",
  "hubVersion": "Pod 5",
  "freeSleep": {
    "version": "3.6.0",
    "branch": "main"
  },
  "waterLevel": "true",
  "isPriming": false,
  "settings": {
    "v": 1,
    "gainLeft": 400,
    "gainRight": 400,
    "ledBrightness": 0
  },
  "wifiStrength": 52,
  "sensorTemps": {
    "ambientC": 22.5,
    "ambientF": 73,
    "heatsinkC": 31.2,
    "leftC": 24.1,
    "rightC": 23.8,
    "lastUpdated": "2026-04-26T10:12:34Z"
  }
}
```

- `freeSleep` holds Nightstand's version and the branch it was built from.
  The name is kept so tools written for free-sleep keep working.
- `sensorTemps` is `null` until the biometrics service has reported an
  ambient temperature at least once. It is not available on every Pod.
- Each side can also carry `taps`, the count of double, triple and quad taps
  the firmware has seen. It is read only by the gesture monitor, so it
  appears in the WebSocket `device-status` payload, not in this response.

### POST

- Changes the bed; send only the fields you want to change. Returns
  `204 No Content` on success.
- Returns `503` if the hardware connection is not back within 10 seconds or
  a command gets no answer. A command that failed this way is dropped, never
  sent later when the connection returns. `/api/execute` behaves the same.
  Scheduled alarms follow the same rule: one that could only start more than
  3 minutes after its time is skipped. Scheduled power and set point changes
  are the exception: they wait for the hardware for as long as it takes, and
  when several changes for the same setting are waiting, only the newest is
  sent.

#### Request body

```json
{
  "left": {
    "targetTemperatureF": 88,
    "isOn": true
  },
  "right": {
    "targetTemperatureF": 90,
    "isOn": false
  }
}
```

- `targetTemperatureF` must be 55 to 110, `secondsRemaining` a whole number
  of seconds from 0 to 43200, `settings.ledBrightness` a whole number from 0
  to 100, and `settings.v`, `settings.gainLeft` and `settings.gainRight`
  whole numbers from 0 to 2147483647. Out-of-range values and unknown keys
  return `400` and nothing is sent to the Pod. Read-only fields from the GET
  response (such as `currentTemperatureF` or `waterLevel`) are accepted and
  ignored.
- `isOn: true` turns a side on for 12 hours (the firmware's maximum);
  `false` turns it off.
- While either side is in away mode, a change to one side is applied to
  both.
- `isAlarmVibrating: false` stops a ringing alarm: the server sends a
  one-second replacement alarm only to the tracked ringing side, then clears
  its ringing record and pending snooze. Dismissing an idle side sends no
  alarm command.
- `isPriming: true` starts a prime. `isPriming: false` is accepted and
  ignored. No verified command stops an active prime.
- A manual `targetTemperatureF` change pauses that side's temperature
  schedule for 12 hours when its next scheduled change is within 3 hours
  (`scheduleOverrides.temperatureSchedules` in `/api/settings`). On a Smart
  Schedule night it holds the curve instead (see
  [`/api/rhythms/live`](#get-apirhythmslive)).

---

## `/api/settings`

### GET

- Returns the current settings.

#### Response

```json
{
  "id": "d07caf20-4f6a-4a9b-be8e-012989b0a65f",
  "timeZone": "America/Los_Angeles",
  "temperatureFormat": "fahrenheit",
  "rebootDaily": true,
  "rawArchiveRetentionDays": 14,
  "updateChannel": "stable",
  "left": {
    "name": "Left",
    "awayMode": false,
    "alarmsEnabled": true,
    "scheduleOverrides": {
      "temperatureSchedules": { "disabled": false, "expiresAt": "" },
      "alarm": { "disabled": false, "timeOverride": "", "expiresAt": "" },
      "pause": { "active": false, "expiresAt": "" }
    },
    "oneOffAlarm": {
      "enabled": false,
      "fireAt": "",
      "vibrationIntensity": 100,
      "vibrationPattern": "rise",
      "duration": 30
    },
    "taps": {
      "doubleTap": { "type": "temperature", "change": "decrement", "amount": 2 },
      "tripleTap": { "type": "temperature", "change": "increment", "amount": 2 },
      "quadTap": { "type": "base_control", "behavior": "toggle_preset" }
    }
  },
  "right": { "...": "same shape as left" },
  "primePodDaily": {
    "enabled": true,
    "time": "14:00"
  },
  "features": {
    "sleepScore": true,
    "levelTemps": true,
    "oneOffAlarms": true,
    "presenceAutoOff": true,
    "nightstandTheme": true,
    "rhythms": false,
    "biometricsV2": false,
    "coverButtons": false
  }
}
```

- `temperatureFormat` is `fahrenheit`, `celsius`, or `level` (the -10 to +10
  scale the Eight Sleep app uses). It changes only how temperatures are
  shown; all three map to the same Fahrenheit value.
- `updateChannel` is `stable` or `beta` and sets which releases the in-app
  updater offers. Stable offers stable releases only; beta offers both.
- `rawArchiveRetentionDays` (1 to 60, default 14) is how long the Pod keeps
  raw sensor recordings. Changing it rewrites `raw-archive.conf` in the data
  folder, which `scripts/archive-raw.sh` reads.
- `oneOffAlarm` is a single alarm that rings once at `fireAt` (an ISO 8601
  date and time with offset) and then turns itself off, apart from the
  weekly alarms in `/api/schedules`.
- `scheduleOverrides.temperatureSchedules` pauses a side's scheduled
  temperature changes until `expiresAt`. `scheduleOverrides.alarm` turns a
  side's weekly alarms off until `expiresAt` (`disabled`), or sets one alarm
  at `timeOverride` (`HH:mm`) when that time comes before `expiresAt`.
- `scheduleOverrides.pause` pauses one side's schedule. While `active`, that
  side's scheduled power, temperature and weekly alarm jobs are skipped when
  they come due, and presence auto-off leaves the side alone. The one-time
  alarm is not affected by the pause, so it rings if the side is on.
  `expiresAt` is an ISO 8601 date and time with offset, at most 14 days
  ahead, or `""` to pause until the side is resumed. When `expiresAt`
  passes, the server clears the pause after one minute. Ending a pause,
  including Resume schedule in the app, turns an off side on if its scheduled
  night is in progress. It runs the engine's scheduled power-on job at that
  moment, with its power-on temperature, manual hold rules and scheduled off time.
  When I get up can extend the night under its usual rules. An away side or
  a side already on is left alone.
  When a scheduled start is due within two minutes, resume waits for it and
  checks once more three minutes later, but a server restart in that window
  drops the check.
  Skipped alarms do not ring late.
- `taps` maps each gesture (`doubleTap`, `tripleTap`, `quadTap`) to an
  action. The app has no editor for them. The actions are:
  - `{ "type": "temperature", "change": "increment" | "decrement", "amount": 0 to 10 }`
  - `{ "type": "base_control", "behavior": "toggle_preset" }`, which moves
    an adjustable base between its `relax` and `flat` presets
  - `{ "type": "alarm", "behavior": "snooze" | "dismiss", "snoozeDuration": 60 to 600, "inactiveAlarmBehavior": "power" | "none" }`,
    the shape upstream free-sleep uses. On the tested Pod 5 the firmware
    handles a double or triple tap while an alarm rings and stops it without
    changing the tap counters, so the configured action cannot snooze it.
    The firmware `dismissAlarm` field has numeric values that upstream
    free-sleep treats as dismissal timestamps. The server takes each alarm's
    baseline from its first valid status after starting. The first valid
    sample after reconnecting can only raise that alarm's high-water mark.
    Decreases, restored historical values, missing, malformed and unchanged
    values do nothing. Only a later value strictly above the highest seen
    for that alarm across all connections clears its ringing record and
    pending snooze. It sends no command in response. On my Pod 5, a double
    tap stopped a Nightstand alarm in firmware, the `dismissAlarm` value
    rose, and Nightstand cleared its ringing state and logged the dismissal.
    Timestamp units remain unverified.
- `features` are feature flags. `sleepScore` turns the sleep score and sleep
  stage routes on and off; the app no longer shows either.
  `coverButtons` is Cover buttons, off by default. It is for a Pod 4 hub with
  a Pod 5 cover, whose firmware ignores short clicks on the cover's plus and
  minus buttons. With it on, Nightstand reads those ignored clicks from
  `/persistent/*.RAW` and steps that side by 1 F per click, within 55 to
  110 F. A click can take 15 to 25 s to apply, because the firmware writes
  its log in batches. A Pod 5 hub handles its buttons itself, so the switch
  does nothing there. While off, the server opens no RAW files for buttons.
  `nightstandTheme` is no longer read and stays so stored settings keep
  validating. `features.rhythms` is the Rhythms switch (see `/api/rhythms`
  below); it changes only through `POST /api/rhythms/enable` and
  `POST /api/rhythms/disable`. `biometricsV2` is New sleep tracking.

### POST

- Changes settings; send only the fields you want to change. The update is
  merged into the stored settings, except that a gesture in `taps` is
  replaced: send that gesture's whole action, with every field its `type`
  needs. Returns the full updated settings.
- Returns `400` if the body does not match the schema, if a pause would end
  in the past or more than 14 days ahead, or if a pause is turned on while
  that side is in away mode.
- Returns `409` if the update would turn off `levelTemps` while
  `temperatureFormat` is still `level`, or if it would change
  `features.rhythms` (use `/api/rhythms/enable` or `/api/rhythms/disable`;
  sending the value it already has is fine).

#### Request body

```json
{
  "timeZone": "America/Los_Angeles",
  "left": {
    "name": "Left",
    "taps": {
      "quadTap": { "type": "temperature", "change": "decrement", "amount": 1 }
    }
  },
  "primePodDaily": {
    "enabled": true,
    "time": "14:00"
  }
}
```

---

## `/api/schedules`

### GET

- Returns the weekly schedule for both sides.

#### Response

```json
{
  "left": {
    "monday": {
      "temperatures": {
        "07:00": 72,
        "22:00": 68
      },
      "power": {
        "on": "20:00",
        "off": "08:00",
        "onTemperature": 82,
        "enabled": true
      },
      "alarm": {
        "time": "06:30",
        "vibrationIntensity": 100,
        "vibrationPattern": "rise",
        "duration": 10,
        "enabled": true,
        "alarmTemperature": 78
      },
      "alarms": [
        {
          "time": "06:30",
          "vibrationIntensity": 100,
          "vibrationPattern": "rise",
          "duration": 10,
          "enabled": true,
          "alarmTemperature": 78
        },
        {
          "time": "07:15",
          "vibrationIntensity": 100,
          "vibrationPattern": "rise",
          "duration": 10,
          "enabled": true,
          "alarmTemperature": 78
        }
      ]
    }
  }
}
```

### POST

- Changes the weekly schedule; send only the sides and days you want to
  change. Within a day, `power` is merged into what is stored, while
  `temperatures` and `alarms` replace the stored values. Returns the full
  updated schedule.
- Up to 10 alarms and 48 temperature changes per side and day. A day already
  stored above a limit can be saved at its current size but not grown.
- Alarm `duration` is 1 to 300 seconds and `vibrationIntensity` 1 to 100;
  temperatures are whole °F from 55 to 110.
- Each scheduled power-on also tells the firmware to turn the side off 5
  minutes after the scheduled off time (8 minutes when an alarm is due just
  before it), so the side turns off even if the server has stopped.
- A scheduled power off waits for an alarm of the same side that is due at
  that minute to finish ringing, for at most nine minutes, so the alarm does
  not find the side already off. It does not wait for an alarm that starts
  the next night, and it is skipped if a scheduled power on for the same
  side is due at that minute or later.

#### Request body

```json
{
  "left": {
    "monday": {
      "power": {
        "on": "19:00",
        "off": "07:00",
        "enabled": true
      }
    }
  }
}
```

`alarm` is kept as the older single-alarm field. Use `alarms` to store
several alarms for the same side and day; when `alarms` is sent, Nightstand
schedules every enabled item and copies the first into `alarm` for older
clients. When only `alarm` is sent, it replaces the first item in `alarms`
and keeps all later items, even if the first is disabled. On an empty day
it creates that first item. Use `alarms: []` to clear every alarm.

---

## `/api/rhythms`

Rhythms are named sleep plans per side, a weekly plan that picks a rhythm for
each weekday, and date changes that pick a different rhythm (or no sleep) for
one date. They are stored in `rhythmsDB.json`, apart from the weekly
schedule, and are off unless `features.rhythms` is on. Only
`POST /api/rhythms/enable` creates that file, and none of these routes
changes `schedulesDB.json`. While Rhythms are active, the Pod follows them
instead of the weekly schedule.

### GET `/api/rhythms`

- Returns whether Rhythms are on and the stored data. `data` is the stored
  file whenever it can be read, even when Rhythms are not active, and `null`
  otherwise.
- `status.reason` is present when `active` is false: `flag-off`, `absent`
  (not set up yet), `invalid` (the file could not be read),
  `unsupported-version` (saved by a newer version) or `fingerprint-mismatch`
  (the weekly schedule changed since Rhythms were set up). Later versions
  may add reasons.

#### Response

```json
{
  "status": { "enabled": true, "active": true },
  "data": {
    "version": 1,
    "legacyFingerprint": "7751bac1543dfb451bc211034ed29808b5d8c870fffe4c5883df45b158265704",
    "left": {
      "rhythms": {
        "workdays": {
          "id": "workdays",
          "name": "Workdays",
          "night": {
            "temperatures": { "23:00": 78, "03:00": 74 },
            "power": { "on": "22:00", "off": "07:00", "onTemperature": 82, "enabled": true },
            "alarm": { "time": "06:30", "vibrationIntensity": 80, "vibrationPattern": "rise", "duration": 30, "enabled": true, "alarmTemperature": 82 },
            "alarms": [
              { "time": "06:30", "vibrationIntensity": 80, "vibrationPattern": "rise", "duration": 30, "enabled": true, "alarmTemperature": 82 }
            ]
          },
          "wake": "06:30",
          "temperatureMode": "manual",
          "smart": { "baseLevel": 0, "intensity": "standard", "warmStart": true, "warmUp": true, "upEarly": false }
        }
      },
      "week": {
        "sunday": "workdays", "monday": "workdays", "tuesday": "workdays", "wednesday": "workdays",
        "thursday": "workdays", "friday": null, "saturday": null
      },
      "changes": [{ "date": "2026-10-12", "rhythmId": null }]
    },
    "right": { "rhythms": {}, "week": { "sunday": null, "monday": null, "tuesday": null, "wednesday": null, "thursday": null, "friday": null, "saturday": null }, "changes": [] }
  }
}
```

- `smart.offWhenUp`, when `true`, turns the side off when the person gets up
  ("When I get up"): after 10 minutes out of bed, and no later than 3 hours
  past the set off time. It is stored only when on. Version 3.5.0 drops it
  when it reads the file and turns the side off at the set time.

### POST `/api/rhythms`

- Saves one or both sides. A side that is sent replaces the stored side; a
  side that is left out is kept. The body accepts only `left` and `right`,
  and unknown keys anywhere inside a side are refused.
- Up to 120 date changes per side can be sent. Changes more than 7 days old
  are dropped before the side is checked.
- A side can have up to 12 rhythms. Each rhythm is stored under its own
  `id`. The weekly plan and the date changes name existing rhythms or
  `null`. A date appears at most once, is a real date and is at most 60 days
  ahead in the Pod's time zone. A rhythm can have up to 48 temperature
  changes, or as many as it already has when more are stored.
- Two sleeps on the same side may not overlap, from now to 69 days ahead.
  Date changes reach 60 days ahead, so the last days of that span hold the
  weekly plan alone and a clash between two weekly nights cannot hide behind
  changes. A sleep that has already ended is not checked, so an overlap
  never involves a sleep that is over.
- Returns the same body as `GET /api/rhythms`.

#### Request body

```json
{
  "left": {
    "rhythms": { "workdays": { "...": "a full rhythm, as in the GET response" } },
    "week": { "sunday": "workdays", "monday": "workdays", "tuesday": "workdays", "wednesday": "workdays", "thursday": "workdays", "friday": null, "saturday": null },
    "changes": [
      { "date": "2026-10-12", "rhythmId": null },
      { "date": "2026-10-16", "rhythmId": "workdays" }
    ]
  }
}
```

#### Errors

- `400 { "error": "Invalid request data", "details": [...] }`: the body does
  not match the schema.
- `400 { "error": "Invalid rhythms", "details": ["left: The Monday plan uses a rhythm that does not exist (nap)"] }`:
  a rule above is broken. Each detail starts with the side.
- `400 { "error": "Two sleeps would overlap", "overlaps": [{ "side": "left", "first": "2026-10-12", "second": "2026-10-13" }] }`:
  `first` and `second` are the start dates of the two sleeps.
- `409 { "error": "...", "state": "absent" }`: nothing is saved unless the
  stored file can be read. The text depends on `state`: `absent` is
  "Rhythms are not set up on this Pod", `unsupported` is "The saved rhythms
  are from a newer version" and `invalid` is "The saved rhythms could not be
  read". Switch on `state`, not the text.

### GET `/api/rhythms/sleeps`

- Returns the sleeps of one side that overlap a window: from Rhythms when
  they are active, otherwise from the weekly schedule. Alarms are left out
  when the side's alarms are turned off. While Rhythms are active, a side in
  away mode gets the present side's sleeps, with `side` naming the present
  side and no alarms, because alarms ring only on the present side; if both
  sides are away the answer is `[]`. The weekly schedule is returned as
  stored.
- Query: `side` (`left` or `right`), `from` and `to` (ISO 8601 date times
  with an offset, `to` after `from`, at most 16 days apart). Any other query
  key is refused with `400`.
- A sleep is named by the date it starts, in the Pod's time zone. `rhythmId`
  is `null` for sleeps from the weekly schedule. Events are sorted by time.
- For a Smart Schedule sleep, `start` is when the bed turns on (20 or 30
  minutes before bedtime) and `smartCurve` gives `bedtime`, `coolStart`,
  `wake`, `daySleep` and the curve `points` (ISO times). The temperature
  events follow the curve.

#### Response

```json
[
  {
    "side": "left",
    "date": "2026-10-05",
    "rhythmId": "workdays",
    "start": "2026-10-06T05:00:00.000Z",
    "end": "2026-10-06T14:00:00.000Z",
    "wake": "2026-10-06T13:30:00.000Z",
    "night": { "...": "the rhythm's night" },
    "mode": "manual",
    "events": [
      { "kind": "power-on", "at": "2026-10-06T05:00:00.000Z", "temperatureF": 82 },
      { "kind": "temperature", "at": "2026-10-06T06:00:00.000Z", "temperatureF": 78 },
      { "kind": "temperature", "at": "2026-10-06T10:00:00.000Z", "temperatureF": 74 },
      { "kind": "alarm", "at": "2026-10-06T13:30:00.000Z", "alarm": { "...": "the alarm" }, "index": 0 },
      { "kind": "power-off", "at": "2026-10-06T14:00:00.000Z" }
    ]
  }
]
```

### GET `/api/rhythms/live`

- Returns the Smart Schedule night that is running for a side, read from
  memory. It writes nothing. The answer is `null` when Rhythms are not
  active, when the side has no Smart Schedule sleep being followed, or when
  both sides are in away mode. A side in away mode gets the present side's
  night, with `side` naming the present side.
- Query: `side` (`left` or `right`). A missing or unknown side, or any other
  query key, is refused with `400`.
- A manual temperature change on a Smart Schedule night holds the current
  level until the curve's next phase starts, at most 3 hours. A change made
  before the cool-down holds until the cool-down starts. `hold.until` is
  that end. Holds are kept in memory only, so a server restart drops them.

#### Response

```json
{
  "side": "left",
  "date": "2026-10-05",
  "phase": "cooldown",
  "waiting": false,
  "coolStart": "2026-10-06T05:20:00.000Z",
  "hold": { "until": "2026-10-06T06:10:00.000Z" },
  "baseSince": null,
  "nextChange": { "at": "2026-10-06T06:10:00.000Z", "level": -4, "phase": "hold" }
}
```

- `date` is the date the sleep starts, in the Pod's time zone.
- `phase` is the curve phase now: `prewarm`, `bedtime`, `cooldown`, `hold`,
  `warmup`, `wake` or `after`. It is `null` when none applies. Later
  versions may add phases.
- `waiting` is `true` while the cool-down waits for the person to get into
  bed.
- `coolStart` is when the cool-down starts or started. It is the bedtime
  before the night's start is decided, and when presence is stale or
  unknown. While `waiting` is `true` it is the latest the cool-down can
  start, 2 hours after the bedtime, and once the start is decided it is that
  start. It is rounded up to the minute, like the curve.
- `hold` is `null` when no manual change is holding the curve. A hold never
  runs past the power off.
- `baseSince` is when the curve was released to the base level, or `null`
  while it has not been. That happens when the person gets up early, if that
  setting is on, or leaves the bed between the wake time and 30 minutes
  after it.
- `nextChange` is the next change of the curve and the phase it starts, or
  `null` when none is left. `level` is a level on the same -10 to +10 scale
  as `baseLevel`, not a temperature. Points that a hold or a release to the
  base level suppresses are skipped, so `nextChange.at` is never before
  `hold.until`.
- `offWhenUp` is present only on a "When I get up" sleep while presence is
  fresh: `{ "by": "<instant>" }`, the latest the side turns off.
- Instants are ISO 8601 strings with an offset.

### POST `/api/rhythms/enable`

- Turns Rhythms on and rebuilds the Pod's jobs. The first time, it converts
  the weekly schedule into rhythms. Later times it keeps the saved rhythms
  and accepts the weekly schedule as it is now.
- The body must be empty or `{}`; any key is refused with `400`.
- `200 { "converted": true }`: `converted` is `true` when this call created
  the rhythms from the weekly schedule.
- `409 { "error": "..." }`: the saved rhythms are from a newer version or
  cannot be read, or a night in the weekly schedule cannot become a rhythm.
  Nothing changes.

### POST `/api/rhythms/disable`

- Turns Rhythms off, hands a sleep in progress back to the weekly schedule
  and rebuilds the Pod's jobs. The weekly schedule is restored as it was,
  with nothing copied back from Rhythms.
- Body: `{ "powerOffNow": true }` powers off a side that is running a
  Rhythms sleep instead of leaving it on. The key is optional and defaults
  to `false`; anything else is refused with `400`.
- Returns `200` with one entry per side, even when a side's hardware write
  failed:

```json
{
  "sides": [
    { "side": "left", "action": "kept-on-until", "until": "2026-10-06T14:00:00.000Z", "alarmOverrideSet": false },
    { "side": "right", "action": "legacy-takes-over", "until": "2026-10-06T14:30:00.000Z", "alarmOverrideSet": false, "deviceUpdateFailed": true }
  ]
}
```

- `action` is `none` (nothing was running), `legacy-takes-over` (the weekly
  schedule runs the rest of the night, until `until`), `kept-on-until` (the
  side stays on until `until`, and the firmware turns it off 5 minutes after
  that; its remaining alarms still ring, except on an away side, which has
  none, but they are held in memory only, so a server restart, including the
  daily reboot, drops them) or `powered-off`. `alarmOverrideSet` is `true`
  when the side's weekly alarms are switched off until `until` because that
  night's alarm already rang. `deviceUpdateFailed` is present and `true`
  when the Pod could not be told to change that side; the settings change
  was still made.

---

## `/api/execute`

### POST

- Sends one Franken command to the Pod. This bypasses the checks the other
  routes make, so read
  [docs/EIGHT_SLEEP_PROTOCOL.md](../docs/EIGHT_SLEEP_PROTOCOL.md) first.
- `command` is one of `HELLO`, `SET_TEMP`, `SET_ALARM`, `ALARM_LEFT`,
  `ALARM_RIGHT`, `SET_SETTINGS`, `LEFT_TEMP_DURATION`,
  `RIGHT_TEMP_DURATION`, `TEMP_LEVEL_LEFT`, `TEMP_LEVEL_RIGHT`, `PRIME`,
  `DEVICE_STATUS` or `ALARM_CLEAR`; any other value returns `400`.
  Command 17, known elsewhere as `STOP_PRIME` or `ALARM_SOLO`, is excluded
  because its meaning is disputed and unverified.
- For `TEMP_LEVEL_LEFT` and `TEMP_LEVEL_RIGHT`, `arg` must be a plain whole
  number from -100 to 100; for `LEFT_TEMP_DURATION` and
  `RIGHT_TEMP_DURATION`, a plain whole number of seconds from 0 to 43200.
  Text such as `1e2`, `0x10`, `10.5` or a padded number is refused. Every
  other command takes `arg` as a string (or no `arg`), and a value of
  another type is refused with `400`. Nothing is sent to the Pod for a
  `400`, which answers `{ "message": "..." }`.
- For `ALARM_LEFT` and `ALARM_RIGHT`, `arg` must be a hex-encoded CBOR
  object with integer `pl` from 0 to 100, integer `du` from 1 to 2147483
  seconds, `pi` of `double` or `rise`, and a nonnegative safe integer `tt`
  in Unix seconds. Future target times return `400` before any hardware
  command. The in-memory tracker supports immediate ringing alarms, not
  pending firmware starts. Accepted raw alarms remain tracked for `du`
  seconds after command acceptance so they can be dismissed.

#### Request body

```json
{
  "command": "TEMP_LEVEL_LEFT",
  "arg": "20"
}
```

#### Response

```json
{
  "success": true,
  "message": "Command 'TEMP_LEVEL_LEFT' executed successfully."
}
```

---

## `/api/alarm`

### POST

- Starts the vibration alarm now, apart from any schedule. The app uses it
  to try alarm patterns and strengths.

#### Request body

`side`, `vibrationIntensity` (1 to 100), `vibrationPattern` (`double` or
`rise`), `duration` (1 to 300 seconds; the alarm rings for at least 10) and
an optional `force`. Any other key returns `400`. The Pod gets the `rise` pattern only when its hub is
detected as a Pod 5; any other or unknown hub gets `double`, which rings on
every Pod. The same rule applies to scheduled and one-time alarms.

```json
{
  "side": "left",
  "vibrationIntensity": 50,
  "vibrationPattern": "rise",
  "duration": 10,
  "force": false
}
```

#### Response

Returns the weekly schedule once the start command has been sent, not when
the alarm ends. Returns `503` with `{ "error": { "message": "..." } }` if
the alarm did not start, for example when the hardware connection is not
back within 10 seconds. Without `force`, an alarm for a side that is off or
in away mode does not start either.

---

## `/api/alarms/missed`

### GET

- Lists alarms from the last 7 days that were due but did not ring, newest
  last, at most 20. The app shows them so a missed alarm is not silent.

#### Response

```json
{
  "missed": [
    {
      "id": "left-2026-10-06T13:30:00.000Z-not-running",
      "side": "left",
      "at": "2026-10-06T13:30:00.000Z",
      "reason": "not-running",
      "recordedAt": "2026-10-06T13:41:12.000Z"
    }
  ]
}
```

`reason` is one of:

- `not-running`: the server was stopped when the alarm was due.
- `late`: the Pod could be reached only after the alarm's time had passed.
- `failed`: sending the alarm to the Pod failed.
- `unconfirmed`: the Pod did not answer, or the server stopped while the
  alarm was being sent, so it may or may not have rung.
- `error`: the server failed before it asked the Pod to ring.
- `side-off`: the side was off, so the alarm does not ring.

Alarms on a side in away mode, or paused, are not listed: they are not meant
to ring.

### POST `/api/alarms/missed/dismiss`

- Body: `{ "ids": ["..."] }`, up to 50 ids from the list above. Removes
  them and answers `204 No Content`. Unknown ids are ignored; any other key
  returns `400`.

---

## `/api/base-control`

Adjustable base control over Bluetooth. It has not been tested with a base.
The base's position is kept in memory as the base reports it.

### GET `/api/base-control`

Current base status. `isMoving` reads `false` once no position update has
arrived for 15 seconds.

```json
{
  "head": 30,
  "feet": 0,
  "isMoving": false,
  "lastUpdate": "2026-04-26T10:12:34Z",
  "isConfigured": true
}
```

### POST `/api/base-control`

Moves the base to a position.

#### Request body

| Field | Range | Required | Default |
|---|---|---|---|
| `head`     | 0 to 60 (degrees) | yes | none |
| `feet`     | 0 to 45 (degrees) | yes | none |
| `feedRate` | 30 to 100         | no  | 50   |

```json
{ "head": 25, "feet": 10, "feedRate": 50 }
```

#### Response

```json
{ "success": true, "position": { "head": 25, "feet": 10, "feedRate": 50 } }
```

### POST `/api/base-control/preset`

Moves to a preset defined in `server/src/8sleep/basePresets.ts`: `flat`,
`sleep`, `relax` or `read`. Any other name returns `400`.

```json
{ "preset": "relax" }
```

#### Response

```json
{ "success": true, "preset": "relax", "position": { "head": 30, "feet": 15, "feedRate": 50 } }
```

### POST `/api/base-control/stop`

Stops any base movement.

#### Response

```json
{ "success": true, "message": "Stop command sent" }
```

---

## `/api/jobs`

### POST

- Runs one or more jobs now. Returns `204 No Content` once they have
  started.

#### Request body

An array of job keys:

```json
["analyzeSleepLeft", "analyzeSleepRight"]
```

Valid keys:

- `analyzeSleepLeft` and `analyzeSleepRight`: run sleep detection over the
  last 24 hours.
- `biometricsCalibrationLeft` and `biometricsCalibrationRight`: recalibrate
  the capacitance sensor's presence thresholds over the last 2 hours. This
  manual run skips the occupied-bed check, so run it only with an empty bed.
  Scheduled calibration uses a separate 6-hour lookback.
- `reboot`: restarts the Pod now (`sudo /sbin/reboot`).
- `update`: starts `free-sleep-update.service`, the same as `/api/update`.
  This key cannot confirm a bed in use, so it is refused with `409` while a
  side is on, an alarm is due within 15 minutes, or the bed's state cannot
  be read (see [`/api/update`](#apiupdate)).

`reboot` and `update` cannot be in the same request (`400`). While an
update, rollback or switch is starting or running, `reboot` is refused; once
a reboot has been issued, update, rollback, switch and further reboots are
refused until the Pod restarts (or for 5 minutes if it does not). These
refusals answer `409` with a `message`.

Repeated keys in one request run once. If an analysis or calibration for the
same side is already queued or running, the request returns `409` and
nothing starts.

---

## `/api/metrics/sleep`

Sleep records are periods in bed found by the nightly analysis.

### GET

- Returns the sleep records that overlap a range, oldest first.
- Query parameters, all optional: `side` (`left` or `right`), `startTime`
  and `endTime` (ISO 8601). A malformed value returns `400`.
- Without either date bound, the range is the last 90 days through now,
  including records overlapping its start. An explicit `startTime` or
  `endTime` keeps its supplied range without this limit.

#### Response

```json
[
  {
    "id": 1,
    "side": "left",
    "entered_bed_at": "2026-10-05T22:04:00-07:00",
    "left_bed_at": "2026-10-06T06:31:00-07:00",
    "sleep_period_seconds": 30420,
    "times_exited_bed": 1,
    "present_intervals": [
      ["2026-10-05T22:04:00-07:00", "2026-10-06T03:10:00-07:00"],
      ["2026-10-06T03:14:00-07:00", "2026-10-06T06:31:00-07:00"]
    ],
    "not_present_intervals": [
      ["2026-10-06T03:10:00-07:00", "2026-10-06T03:14:00-07:00"]
    ]
  }
]
```

Times are ISO 8601 in the Pod's time zone. `sleep_period_seconds` is time in
bed, and `times_exited_bed` counts trips out of bed.

### PUT `/api/metrics/sleep/:id`

- Edits a sleep record, for example a bedtime that was off because of a
  presence-detection glitch. Send only the fields to change: `side`,
  `entered_bed_at`, `left_bed_at`, `sleep_period_seconds`,
  `times_exited_bed`, `present_intervals` or `not_present_intervals`, with
  times as ISO 8601 strings with an offset. When either bed time changes,
  `sleep_period_seconds` and `times_exited_bed` are recalculated unless the
  body sets them. Returns the updated record.
- `:id` must be a positive whole number (`400` otherwise); `404` if no
  record has it. An `id` in the body is ignored.
- Returns `400` if `left_bed_at` would be before `entered_bed_at`, for
  negative counts, reversed intervals, or times before 1970 or after 2038.
  Returns `409` if another record on the same side already starts at the
  new `entered_bed_at`.

### DELETE `/api/metrics/sleep/:id`

- Removes a sleep record, for naps or false detections that should not
  count. Returns `204 No Content`, `400` for an id that is not a positive
  whole number, and `404` if no record has it.

---

## `/api/metrics/vitals`

> These are estimates from the bed's sensors. 0 means no estimate. `hrv` is
> SDNN in milliseconds and fails often; the app does not show it. With old
> tracking, rows have `estimator` null (or leave it out), and the current
> `breathing_rate` estimate does not track breathing, so the app does not
> show it. With New sleep tracking on, rows written by the newer estimators
> have `estimator` 2, and their `breathing_rate` (whole breaths per minute)
> and `resp_rate` (one decimal) come from a newer estimate that the app
> shows. See the Biometrics section of the README for how each estimate was
> checked.

### GET

- Returns vitals rows, about one a minute while someone is in bed, oldest
  first.
- Query parameters: `side` (optional), `startTime` (optional, ISO 8601,
  defaults to 24 hours before `endTime`) and `endTime` (optional, ISO 8601,
  defaults to now).
- The range can be at most 7 days long. A longer range, or a malformed
  `side`, `startTime` or `endTime`, returns `400`.

#### Response with New sleep tracking off

```json
[
  {
    "id": 1,
    "side": "left",
    "timestamp": 1739656800,
    "heart_rate": 62,
    "hrv": 0,
    "breathing_rate": 14
  }
]
```

#### Response with New sleep tracking on

```json
[
  {
    "id": 2,
    "side": "left",
    "timestamp": 1739656860,
    "heart_rate": 61,
    "hrv": 48,
    "breathing_rate": 14,
    "hr_quality": 0.82,
    "rmssd": 41.3,
    "sdnn": 47.9,
    "hrv_coverage": 0.9,
    "resp_rate": 13.6,
    "resp_quality": 0.71,
    "estimator": 2
  }
]
```

`timestamp` is epoch seconds, not an ISO 8601 string. With New sleep
tracking on, the newer columns are `null` on rows from the older estimators
and wherever an estimate failed its quality check.

---

## `/api/metrics/vitals/summary`

### GET

- Returns summary statistics for vitals over a range.
- Query parameters, all optional: `side`, `startTime` and `endTime`
  (ISO 8601). When both time bounds are missing, it summarizes the last
  90 days, ending now. A single bound leaves the other end unbounded. A
  malformed value returns `400`.
- An exact recorded night uses its retained summary after detail pruning.
  Larger ranges combine fully enclosed, non-overlapping retained nights with
  remaining detail. Arbitrary slices within a pruned night cannot be rebuilt.
- Retained nights also return optional `retained.avgHeartRate` and
  `retained.avgBreathingRate`, the rounded positive-only averages displayed
  by the app. The breathing value uses `resp_rate`. The ordinary summary
  fields keep their existing filters and rounding.
- Retention never deletes nightly summaries, sleep records, scores or
  movement. See [Metrics retention](../docs/METRICS_RETENTION.md) for the
  two settings and the limits of reusable database space.
- `avgHRV` averages only `hrv` values from 30 to 120.
- `avgBreathingRate` averages `breathing_rate` values from 5 to 20 with New
  sleep tracking off. With it on, it averages `resp_rate`, so nights without
  the newer estimate give 0.

#### Response

```json
{
  "avgHeartRate": 62,
  "minHeartRate": 54,
  "maxHeartRate": 80,
  "avgHRV": 45,
  "avgBreathingRate": 14
}
```

---

## `/api/metrics/movement`

### GET

- Movement totals per time bucket, derived from the vibration sensor by the
  nightly analysis. The sleep stage rules use them.
- Query parameters: `side`, `startTime`, `endTime` (all optional, ISO 8601).
  As with `/api/metrics/vitals`, `endTime` defaults to now and `startTime`
  to 24 hours before it, and a range longer than 7 days returns `400`.

#### Response

```json
[
  { "id": 1, "side": "left", "timestamp": 1739657100, "total_movement": 312 },
  { "id": 2, "side": "left", "timestamp": 1739657400, "total_movement": 87 }
]
```

---

## `/api/metrics/presence`

### GET

Presence on each side, kept in memory, so it resets when the server
restarts. Before the first observation, each side is `{ "present": false }`
with no timestamps; this means unobserved, not a confirmed empty bed.

#### Response after observations

```json
{
  "left": {
    "present": false,
    "stateChangedAt": "2025-12-18T00:05:00-08:00",
    "lastUpdatedAt": "2025-12-18T00:12:34-08:00",
    "lastPresenceAt": "2025-12-18T00:05:00-08:00"
  },
  "right": {
    "present": true,
    "stateChangedAt": "2025-12-17T22:00:00-08:00",
    "lastUpdatedAt": "2025-12-18T00:12:34-08:00",
    "lastPresenceAt": "2025-12-18T00:12:34-08:00"
  }
}
```

The server sets the timestamps, in the Pod's time zone:

- `stateChangedAt` records the first observation or the latest entry or
  exit. Repeated reports of the same state do not move it.
- `lastUpdatedAt` moves on every accepted report for that side, so clients
  can tell when the stream has stopped.
- `lastPresenceAt` moves on entry, while present and on exit. It is absent
  until presence has been observed. Presence auto-off uses it for the time
  since someone was in bed.

### POST

The biometrics service posts changes and a periodic heartbeat. Send at least
one side, each with a boolean `present`. Timestamps in the body are ignored.

```json
{ "left": { "present": true } }
```

Returns the current state for both sides (`200`). A side left out keeps its
state and timestamps. A body with no side, or a side without a boolean
`present`, returns `400`. Presence has no WebSocket push; clients poll this
route.

---

## `/api/metrics/sleep-stages`

The app no longer shows sleep stages. The route stays for API clients.

### GET

- Classifies each 5-minute bucket of a range as awake, REM, light or deep,
  from fixed rules over heart rate, HRV, breathing and movement. There is no
  machine learning, and the stages have not been compared with a sleep
  study. See [biometrics/DEVELOPER.md](../biometrics/DEVELOPER.md).
- Required query parameters: `side`, `startTime`, `endTime`. The range must
  be at most 48 hours, with `endTime` after `startTime` (`400` otherwise).

#### Response

```json
{
  "active": true,
  "epochs": [
    { "startUnix": 1739659200, "endUnix": 1739659500, "stage": "deep" },
    { "startUnix": 1739659500, "endUnix": 1739659800, "stage": "rem" }
  ],
  "totals":      { "awake": 0,    "rem": 5400, "light": 12000, "deep": 5100 },
  "percentages": { "awake": 0,    "rem": 24,   "light": 53,    "deep": 23 },
  "totalSeconds": 22500,
  "lowCoverage": false
}
```

- `totals` are seconds per stage.
- `lowCoverage` is `true` when fewer than 60% of the buckets have a heart
  rate reading, too few to find sleep onset and offset. The stage totals are
  then not a usable time asleep.
- `active` is `false`, with empty epochs and zero totals and no
  `lowCoverage`, when `features.sleepScore` or biometrics is off.

---

## `/api/metrics/sleep-score`

The app no longer shows the sleep score. The route stays for API clients.

### GET

- Returns a score from 0 to 100 for one sleep period, from two parts: time
  in bed (`duration`, 100 at 8 hours and 10 points less for each hour away
  from it) and trips out of bed (`continuity`, 100 with none and 15 points
  less for each). It uses the sleep record that covers the range, or the
  range itself when there is none.
- Required query parameters: `side`, `startTime`, `endTime`. The range must
  be at most 48 hours, with `endTime` after `startTime` (`400` otherwise).

#### Response

```json
{
  "active": true,
  "score": 92,
  "components": {
    "duration": { "score": 98, "weight": 0.4, "value": "7h 45m in bed", "available": true },
    "continuity": { "score": 85, "weight": 0.3, "value": "1 trip out of bed", "available": true },
    "hrv": { "score": 0, "weight": 0.15, "value": "", "available": false },
    "restingHr": { "score": 0, "weight": 0.15, "value": "54 bpm", "available": false }
  }
}
```

- Only parts with `available: true` count, and their weights are scaled to
  add up to 1, so the score is duration and continuity weighted 4 to 3.
- `hrv` and `restingHr` are kept in the response for older clients. Both are
  always `available: false` and carry no weight. `restingHr.value` is the
  lowest heart-rate estimate in the range, for information only.
- `active` is `false`, with `score: null` and empty `components`, when
  `features.sleepScore` or biometrics is off.

---

## `/api/services`

### GET

- Returns the Biometrics switch and the state of its background jobs.

#### Response

```json
{
  "biometrics": {
    "enabled": true,
    "jobs": {
      "installation": {
        "name": "Biometrics installation",
        "message": "",
        "status": "healthy",
        "description": "Whether or not biometrics was installed successfully",
        "timestamp": ""
      },
      "stream": {
        "name": "Biometrics stream",
        "message": "",
        "status": "healthy",
        "description": "Consumes the sensor data as a stream and calculates biometrics",
        "timestamp": "2025-11-01T17:14:50.003582+00:00"
      },
      "analyzeSleepLeft": {
        "name": "Analyze sleep - left",
        "message": "",
        "status": "healthy",
        "description": "Analyzes sleep period",
        "timestamp": "2025-11-01T17:01:27.317609+00:00"
      },
      "analyzeSleepRight": { "...": "same shape" },
      "calibrateLeft": { "...": "same shape" },
      "calibrateRight": { "...": "same shape" },
      "pumpLeft": { "...": "same shape" },
      "pumpRight": { "...": "same shape" }
    },
    "sensorTemps": {
      "ambient": 2250,
      "heatsink": 3120,
      "left": 2410,
      "right": 2380,
      "lastUpdated": "2026-04-26T10:12:34Z"
    }
  }
}
```

`sensorTemps` here holds raw readings in hundredths of a degree Celsius from
the biometrics service; `/api/deviceStatus` converts them.

### POST

- Changes the Biometrics switch or a job's state; send only the fields you
  want to change. Turning `biometrics.enabled` off stops and disables the
  biometrics stream service, and turning it on starts it. The switch is
  saved only once the service command has worked. Returns the full updated
  services object.
- Returns `409` with `{ "error": "..." }` while an update, rollback or switch
  is running, and `500` if the service command could not run, for example
  when biometrics was never installed (see the README) and the stream
  service does not exist.
- The biometrics jobs also post here to report their state. A job `message`
  longer than 4,000 characters is shortened to its start and end.

#### Request body

```json
{ "biometrics": { "enabled": false } }
```

---

## `/api/serverStatus`

### GET

- Returns the state of each part of Nightstand. Each entry is
  `{ name, status, description, message, timestamp? }`, where `status` is
  one of `not_started`, `started`, `healthy`, `restarting`, `retrying`,
  `waiting_for_data` or `failed`.
- The full response is cached for 15 seconds. Concurrent requests share
  one refresh, including the database integrity check. Reading status
  writes `servicesDB.json` only when stream health changes.
- `biometricsInstallation` is always present. The `analyzeSleep*`,
  `biometricsCalibration*`, `biometricsStream` and `pumpHealth*` entries are
  present only while biometrics is on. `biometricsStream` reads `failed`
  when the stream has not reported for 5 minutes.
- `database` runs a quick integrity check. When migrations this version
  ships were never applied, it is `failed` and carries
  `unappliedMigrations`, the migration names.
- `rhythmsSchedule` is present only while `features.rhythms` is on. Its
  `message` gives the number of jobs the last rebuild planned, that no time
  zone is set, which side could not be planned, or why the weekly schedule
  is running instead.
- `waterTank` is `healthy` while the tank sensor reads ok and `failed` once
  it has read low for about 30 seconds; its `timestamp` is when the current
  state began. It stays `not_started` until the first reading.
- `buttonMonitor` is `healthy` with the message `Off in Settings > Features`
  while `features.coverButtons` is off. On, it is `healthy` while the newest
  RAW file in `/persistent` was written in the last 15 seconds and `failed`
  with the reason otherwise: no RAW file, a file that stopped growing, or a
  click that could not be applied.

#### Response

```json
{
  "alarmSchedule": { "name": "Alarm schedule", "status": "healthy", "description": "", "message": "" },
  "database": { "name": "Database", "status": "healthy", "description": "Connection to SQLite DB", "message": "" },
  "express": { "name": "Express", "status": "healthy", "description": "The back-end server", "message": "" },
  "franken": { "name": "Franken sock", "status": "healthy", "description": "Socket service for controlling the hardware", "message": "" },
  "frankenMonitor": { "name": "Franken monitor", "status": "healthy", "description": "Handles gestures and monitoring the status", "message": "" },
  "buttonMonitor": { "name": "Cover buttons", "status": "healthy", "description": "Reads ignored cover clicks from the RAW files", "message": "Off in Settings > Features", "timestamp": "2026-09-20T18:04:11-07:00" },
  "jobs": { "name": "Job scheduler", "status": "healthy", "description": "Scheduling service for temperature changes, alarms, and maintenance", "message": "" },
  "logger": { "name": "Logger", "status": "healthy", "description": "Logging service", "message": "" },
  "powerSchedule": { "name": "Power schedule", "status": "healthy", "description": "Power on/off schedule", "message": "" },
  "primeSchedule": { "name": "Prime schedule", "status": "healthy", "description": "Daily prime job", "message": "" },
  "rebootSchedule": { "name": "Reboot schedule", "status": "healthy", "description": "Daily system reboots", "message": "" },
  "systemDate": { "name": "System date", "status": "healthy", "description": "Whether or not the system date is correct. Scheduling jobs depend on this.", "message": "" },
  "temperatureSchedule": { "name": "Temperature schedule", "status": "healthy", "description": "Temperature adjustment schedule", "message": "" },
  "waterTank": { "name": "Water tank", "status": "healthy", "description": "Water level in the tank", "message": "", "timestamp": "2026-09-20T18:04:11-07:00" },
  "biometricsInstallation": { "name": "Biometrics installation", "status": "healthy", "description": "Whether or not biometrics was installed successfully", "message": "", "timestamp": "" },
  "biometricsStream": { "name": "Biometrics stream", "status": "healthy", "description": "Consumes the sensor data as a stream and calculates biometrics", "message": "", "timestamp": "2025-11-01T17:11:50.430377+00:00" },
  "analyzeSleepLeft": { "...": "same shape" },
  "analyzeSleepRight": { "...": "same shape" },
  "biometricsCalibrationLeft": { "...": "same shape" },
  "biometricsCalibrationRight": { "...": "same shape" },
  "pumpHealthLeft": { "...": "same shape" },
  "pumpHealthRight": { "...": "same shape" }
}
```

### GET `/api/serverStatus/alive`

- Answers `204` with no body while the server and its event loop are
  running. It reads and writes nothing, so the health check can ask every
  minute.

---

## `/api/logs`

### GET `/api/logs`

- Lists the `.log` files in `/persistent/free-sleep-data/logs` and
  `/var/log`, newest first.

```json
{ "logs": ["free-sleep-stream.log", "free-sleep.log", "sleep-analyzer.log"] }
```

### GET `/api/logs/:filename`

- Streams a log file as server-sent events (`text/event-stream`): first its
  last 1,000 lines, then new lines as they are written. Each event is
  `{ "message": "..." }`. The in-app log viewer uses it. A name that is not
  a plain `.log` file name in those folders gets one event saying the file
  was not found.

---

## `/api/storage`

### GET

- Disk use of the data folder's partition (`df`), and what is using it:
  logs and the RAW archive (`du`), and the SQLite files.

#### Response

```json
{
  "mountPath": "/persistent/free-sleep-data/",
  "totalBytes": 31138512896,
  "usedBytes": 8388608000,
  "availableBytes": 22749904896,
  "usedPercent": 26.9,
  "breakdown": {
    "logsBytes": 15728640,
    "biometricsArchiveBytes": 4194304000,
    "databaseBytes": 52428800
  }
}
```

---

## `/api/memory`

### GET

- System memory use, read from `/proc/meminfo` (or Node's `os.totalmem()`
  and `os.freemem()` where that file does not exist, such as on a Mac).

#### Response

```json
{
  "totalBytes": 2058354688,
  "usedBytes": 891289600,
  "availableBytes": 1167065088,
  "usedPercent": 43.3
}
```

---

## `/api/metrics/server`

### GET

- In-process server metrics, for debugging on the Pod
  (`curl localhost:3000/api/metrics/server`).

#### Response (values are a snapshot)

```json
{
  "franken": {
    "commandLatencyMs": { "count": 8231, "p50": 18, "p95": 47, "avg": 20, "max": 210 },
    "timeouts": 0,
    "lastRoundtripAt": "2026-04-26T10:12:34.000Z",
    "queueDepth": 0
  },
  "ws": { "clientCount": 1 },
  "jobs": { "executions": { "ok": 28, "fail": 0 } },
  "uptimeSeconds": 7521,
  "memory": { "rssMb": 93, "heapUsedMb": 61 }
}
```

---

## `/api/calibration`

### GET

- The capacitance sensor's calibration state for each side.

#### Response

```json
{
  "left": {
    "state": "calibrated",
    "summary": "Learned from a 45 min empty-bed window.",
    "quality": 0.92,
    "calibratedAt": 1745704351,
    "lastRunStatus": "ok",
    "capFormat": "capSense2"
  },
  "right": {
    "state": "none",
    "summary": "Not calibrated yet. This happens automatically once the sensors record a stretch of empty bed.",
    "quality": null,
    "calibratedAt": null,
    "lastRunStatus": null,
    "capFormat": null
  }
}
```

- `state` is `none` (no profile yet), `imported` (carried over from an
  earlier version by the migration tool, confidence unknown), or
  `calibrated` (produced by an empty-bed run on this install).
- `capFormat` is the capacitance record format the Pod writes, such as
  `capSense2` or `capSense`, from the newest calibration run that recorded
  one; `null` means none has been recorded yet.

---

## `/api/changelog`

### GET

- Returns the installed `CHANGELOG.md` as entries for the in-app changelog.
  It is parsed once per server process, since the file changes only when a
  new release is installed.

#### Response

```json
{
  "entries": [
    { "version": "3.6.0", "date": "2026-10-04", "body": "### Added\n- ..." }
  ]
}
```

---

## `/api/update`

The update, rollback and switch routes below, like `update` and `reboot` in
`/api/jobs`, return `409` with a `message` when another update, rollback,
switch or a reboot is already under way, and `500` with a `message` when the
operation could not be started, for example when its service or sudo rule
is missing.

Update, rollback and switch restart Nightstand, and schedules and alarms
stop for up to five minutes while they run. They are refused while the bed
may be in use, unless the request sets `confirmInUse: true`:

```json
{
  "error": "A side is on. The bed keeps its current temperature, but schedules and alarms stop for up to five minutes.",
  "message": "A side is on. The bed keeps its current temperature, but schedules and alarms stop for up to five minutes.",
  "reasons": ["left-on"]
}
```

That is a `409`. `reasons` lists `left-on`, `right-on`, `alarm-soon` (an
alarm is due within 15 minutes) and `status-unknown` (the bed's state cannot
be read, which counts as in use). `error` and `message` carry the same text.
Just before the services stop, the scripts check again unless the request
was confirmed.

### GET `/api/update/in-use`

- Returns `{ "reasons": [...] }`, the same reasons, empty when the bed is
  not in use. The app reads it to decide whether to ask first.

### POST `/api/update`

- Starts an update through `free-sleep-update.service`. Returns
  `204 No Content` once the update has started, not once it has finished.
  The server stops and starts again during the update; check the running
  version when it is back, or read `/api/update/last-result`.

#### Request body

Optional. With no `targetVersion`, the updater installs the newest release
allowed by the saved channel.

```json
{ "targetVersion": "3.6.0", "allowDowngrade": false, "confirmInUse": false }
```

`targetVersion` is `MAJOR.MINOR.PATCH`. `allowDowngrade` allows a version
older than the one running. Any other key returns `400`.

### GET `/api/update/last-result`

- How the last update, rollback or switch ended, written by its script.
  Returns `404` until one has been recorded.

```json
{
  "runId": "...",
  "operation": "update",
  "outcome": "success",
  "from": "3.5.1",
  "to": "3.6.0",
  "message": "",
  "finishedAt": "2026-10-10T19:02:11Z"
}
```

`operation` is `update`, `rollback` or `switch`. `outcome` is `success`,
`up-to-date`, `stopped`, `rolled-back` or `failed`.

### GET `/api/update/rollback-info`

- Whether an instant rollback is available (a `free-sleep-prev` tree kept by
  the last update) and which version it would roll back to.

```json
{ "available": true, "version": "3.5.1" }
```

### POST `/api/update/rollback`

- Starts a rollback to the saved `free-sleep-prev` tree. Returns
  `204 No Content` once it has started. It restores the application code
  and its firewall rules, not an earlier database or Eight Sleep's firmware.
  Check the running version afterwards.
- Body: optional, `{ "confirmInUse": true }`. Any other key returns `400`.

### POST `/api/update/switch-to-upstream`

- Switches the Pod to upstream
  [throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep),
  keeping the data folder. It installs the upstream commit recorded in
  `releases.json` when one is recorded, otherwise upstream's `main`. This is
  not a firmware reset or a return to Eight Sleep's software. Upstream has
  no button to return to Nightstand; use the migration tool. Returns
  `204 No Content` once the switch has started.
- Body: optional, `{ "confirmInUse": true }`. Any other key returns `400`.

### POST `/api/update/revert-to-stock`

- The old name of `/api/update/switch-to-upstream`, kept for apps from before the rename. Same request, responses and behavior.

### POST `/api/update/prepare-to-stop`

- Called by the update, rollback and switch scripts just before they stop the
  server, after every check that could still cancel the operation. It
  answers only requests from the Pod itself (loopback); any other address
  gets `403`.
- Body: `{ "reason": "downgrade" }`, where `reason` is `downgrade`,
  `rollback` or `revert`, and an optional `handBack` (default `true`).
  Anything else is refused with `400`.
- It always clears the server's record of upcoming alarms, so they are not
  reported as missed when this version comes back. With `handBack: false`,
  which the scripts send when the next version continues Rhythms sleeps
  itself, that is all it does.
- Always answers `204 No Content` once the work is done, including when the
  work failed (the failure is logged). On a stock install running only the
  updater, it does nothing.
- With `handBack: true` it also prepares the Pod for a version that may not
  know Rhythms or a schedule pause:
  - A side running a Rhythms sleep is handed to the weekly schedule. When
    the weekly schedule also has a night in progress, the Pod is told to
    stop at that night's end instead; otherwise the side stays on until the
    firmware off time it was last given for that sleep, and that sleep's
    remaining alarms do not ring once the server stops.
  - When that sleep's alarm already rang and the weekly night still has an
    alarm ahead, `scheduleOverrides.alarm` on that side is set to
    `{ "disabled": true, "timeOverride": "", "expiresAt": <the weekly night's end> }`.
  - A paused side whose weekly night (in progress, or starting within a day)
    has its last alarm still paused when due gets the same override,
    expiring at that night's end, because older versions ignore a pause.
  - A side that already has an unexpired alarm override is left alone.
    These overrides stay in `settingsDB.json` for the next version, which
    skips that side's weekly alarms until they expire.

---

## Partial updates

`POST /api/deviceStatus`, `/api/settings`, `/api/schedules` and
`/api/services` take partial bodies: send only the fields you want to
change. `/api/deviceStatus` sends only those fields to the Pod;
`/api/settings` and `/api/services` merge them into what is stored (a tap
gesture is replaced whole); `/api/schedules` works per day as described
above. `POST /api/rhythms` is different: each side sent replaces the stored
side.

```json
{
  "left": {
    "targetTemperatureF": 88
  }
}
```

---

## WebSocket, `/ws/events`

A live push channel. The app uses it instead of polling device status.
Connect with a browser `WebSocket`; no library is needed. The Origin filter
above applies, and a refused origin gets `403`.

```
ws://<POD_IP>:3000/ws/events
```

### Frame format

Every frame is a JSON envelope:

```json
{ "channel": "device-status", "payload": { }, "ts": "2026-04-26T10:12:34.000Z" }
```

On connect, the server first sends one `{ "channel": "hello", "payload": { "ts": "..." } }`
frame; clients can ignore it.

### Channels

| Channel | When it is sent | Payload |
|---|---|---|
| `device-status`  | The gesture monitor reads the bed every 2 seconds and sends the status when anything in it changed (temperature, `isOn`, water level and so on) | The full status, the same shape as `GET /api/deviceStatus` plus each side's `taps` |
| `service-health` | An entry in `/api/serverStatus` changes (Franken monitor health, job scheduler status, water tank) | Only the entries that changed |
| `job-event`      | A scheduled job starts, succeeds or fails (alarms, temperature changes, prime, sleep analysis, calibration) | `{ jobName, status: "started" \| "ok" \| "fail", message? }` |

### Heartbeat

The server pings every 15 seconds and drops sockets that did not answer the
previous ping. Browsers answer pings on their own.

### When disconnected

The app's `app/src/api/eventStream.ts` reconnects with exponential backoff,
up to 30 seconds. While disconnected, its React Query hooks fall back to
their own HTTP polling.

### Server-side polling

The gesture monitor reads the hardware socket every 2 seconds whether or not
a client is connected, because the same loop detects tap gestures, and those
need to respond when nobody has the app open.
