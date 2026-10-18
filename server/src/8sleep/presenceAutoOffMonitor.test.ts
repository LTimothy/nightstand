import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import moment from 'moment-timezone';

// Same isolated-temp-DATA_FOLDER pattern as db/services.test.ts.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-presence-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

type PresenceSide = { present: boolean; lastUpdatedAt?: string; lastPresenceAt?: string };

const presenceState: { left: PresenceSide; right: PresenceSide } = {
  left: { present: false },
  right: { present: false },
};

const deviceStatus: Record<string, { isOn: boolean }> = {
  left: { isOn: true },
  right: { isOn: false },
};

let powerOffCalls: unknown[] = [];
let statusThrows = false;

mock.module(new URL('./frankenServer.js', import.meta.url).href, {
  namedExports: {
    getDeviceStatusCoalesced: async () => {
      if (statusThrows) throw new Error('franken down');
      return deviceStatus;
    },
  },
});

mock.module(new URL('../routes/metrics/presence.js', import.meta.url).href, {
  namedExports: {
    getPresenceData: () => presenceState,
  },
});

mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: {
    updateDeviceStatus: async (update: unknown) => {
      powerOffCalls.push(update);
    },
  },
});

let settingsDB: typeof import('../db/settings.js')['default'];
let schedulesDB: typeof import('../db/schedules.js')['default'];
let startPresenceAutoOff: typeof import('./presenceAutoOffMonitor.js')['startPresenceAutoOff'];
let stopPresenceAutoOff: typeof import('./presenceAutoOffMonitor.js')['stopPresenceAutoOff'];

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const MINUTE = 60_000;
const pendingReads = new Set<Promise<void>>();

before(async () => {
  ({ default: settingsDB } = await import('../db/settings.js'));
  ({ default: schedulesDB } = await import('../db/schedules.js'));
  for (const db of [settingsDB, schedulesDB]) {
    const read = db.read.bind(db);
    mock.method(db, 'read', async () => {
      const pending = read();
      pendingReads.add(pending);
      try { await pending; } finally { pendingReads.delete(pending); }
    });
  }
  ({ startPresenceAutoOff, stopPresenceAutoOff } = await import('./presenceAutoOffMonitor.js'));
});

beforeEach(async () => {
  powerOffCalls = [];
  statusThrows = false;
  presenceState.left = { present: false };
  presenceState.right = { present: false };
  deviceStatus.left = { isOn: true };
  deviceStatus.right = { isOn: false };

  await settingsDB.read();
  settingsDB.data.timeZone = 'UTC';
  settingsDB.data.left.awayMode = false;
  settingsDB.data.right.awayMode = false;
  settingsDB.data.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
  settingsDB.data.right.scheduleOverrides.pause = { active: false, expiresAt: '' };
  settingsDB.data.features.presenceAutoOff = true;
  await settingsDB.write();

  await schedulesDB.read();
  for (const day of DAY_NAMES) {
    schedulesDB.data.left[day] = {
      ...schedulesDB.data.left[day],
      power: { on: '21:00', off: '09:00', enabled: false, onTemperature: 82 },
    };
  }
  await schedulesDB.write();
});

// Let the status promise start the real lowdb reads, then drain each read
// and its continuations before advancing the fake clock. A fixed sleep can
// leave a tick running into the next minute or test on a busy machine.
async function flush() {
  do {
    await Promise.all([...pendingReads]);
    await new Promise((resolve) => setImmediate(resolve));
  } while (pendingReads.size > 0);
}

// The monitor keeps module-level per-side state (prevIsOn / lastSeenOnAt)
// that survives between tests in the same file. One tick with both sides
// off clears it, so each test starts from a genuine off -> on transition.
async function resetMonitorState(startEpochMs: number) {
  const on = { left: deviceStatus.left, right: deviceStatus.right };
  deviceStatus.left = { isOn: false };
  deviceStatus.right = { isOn: false };
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: startEpochMs - MINUTE });
  startPresenceAutoOff();
  mock.timers.tick(MINUTE);
  await flush();
  stopPresenceAutoOff();
  mock.timers.reset();
  deviceStatus.left = on.left;
  deviceStatus.right = on.right;
  powerOffCalls = [];
}

async function runTicks(startEpochMs: number, tickCount: number, onBeforeTick?: (i: number) => void | Promise<void>) {
  await resetMonitorState(startEpochMs);
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: startEpochMs });
  try {
    startPresenceAutoOff();
    for (let i = 0; i < tickCount; i++) {
      await onBeforeTick?.(i);
      mock.timers.tick(MINUTE);
      // real (unmocked) macrotask turns so tick()'s async work completes
      await flush();
    }
  } finally {
    stopPresenceAutoOff();
    mock.timers.reset();
  }
}

const at = (iso: string) => moment.tz(iso, 'UTC').valueOf();

// The python stream re-POSTs the current presence state about once a minute
// (see _presence_heartbeat_interval), so while it is alive lastUpdatedAt keeps
// advancing even when nothing changes. Tests where auto-off is expected to
// fire have to model that: a fixture with a stale lastUpdatedAt means "the
// stream is down", and the monitor deliberately holds in that case.
const heartbeatAbsent = () => {
  presenceState.left = { present: false, lastUpdatedAt: moment.tz(Date.now(), 'UTC').format() };
};

describe('presenceAutoOffMonitor', () => {
  it('sanity: fires after the timeout when nobody is on the bed', async () => {
    // Side on at 14:00, no presence ever. Auto-off is meant to fire ~45min later.
    await runTicks(at('2026-03-02T14:00:00'), 50, heartbeatAbsent);
    assert.equal(powerOffCalls.length > 0, true, 'expected auto-off to fire for an empty bed');
  });

  it('never powers off while the presenceAutoOff feature is off', async () => {
    await settingsDB.read();
    settingsDB.data.features.presenceAutoOff = false;
    await settingsDB.write();
    await runTicks(at('2026-03-02T14:00:00'), 60, heartbeatAbsent);
    assert.deepEqual(powerOffCalls, [], 'powered off with the feature turned off');
  });

  it('measures idle time from the real power-on when the feature is turned back on', async () => {
    // Off for the first 40 minutes of an empty, powered-on side, then on.
    // The side has been idle since minute 0, so it should go off within a
    // few minutes of re-enabling rather than waiting another 45.
    await settingsDB.read();
    settingsDB.data.features.presenceAutoOff = false;
    await settingsDB.write();
    await runTicks(at('2026-03-02T14:00:00'), 50, async (i) => {
      heartbeatAbsent();
      if (i === 40) {
        settingsDB.data.features.presenceAutoOff = true;
        await settingsDB.write();
      }
    });
    assert.ok(powerOffCalls.length > 0, 'expected auto-off to fire soon after re-enabling');
  });

  it('does not power off while the presence stream is stale/unreported (unknown != absent)', async () => {
    // The python presence stream is down: it has never POSTed, so
    // presenceData is the module default {present:false} with no
    // lastPresenceAt. A user IS in the bed. Correct behavior: with no
    // presence evidence at all, the monitor must not shut the bed off.
    presenceState.left = { present: false }; // no lastUpdatedAt, no lastPresenceAt
    await runTicks(at('2026-03-02T14:00:00'), 60);
    assert.deepEqual(powerOffCalls, [], 'powered off with no presence data at all');
  });

  it('does not power off after a forward clock step (NTP sync after a bad-clock boot)', async () => {
    // Pod boots with a 2010 clock, user turns the side on and gets in bed,
    // then NTP steps the clock to 2026. Elapsed "no presence" time must be
    // measured from real elapsed time, not from the clock discontinuity.
    presenceState.left = { present: false, lastPresenceAt: moment.tz('2010-01-01T22:00:00', 'UTC').format() };
    await resetMonitorState(at('2010-01-01T22:01:00'));
    try {
      // First tick under the bad clock: the monitor records the side as on.
      mock.timers.enable({ apis: ['setInterval', 'Date'], now: at('2010-01-01T22:01:00') });
      startPresenceAutoOff();
      mock.timers.tick(MINUTE);
      await flush();
      stopPresenceAutoOff();
      mock.timers.reset();

      // NTP steps the clock to 2026, one minute of real time later. Same
      // process, so the monitor's per-side state carries over.
      mock.timers.enable({ apis: ['setInterval', 'Date'], now: at('2026-03-02T14:02:00') });
      startPresenceAutoOff();
      mock.timers.tick(MINUTE);
      await flush();
    } finally {
      stopPresenceAutoOff();
      mock.timers.reset();
    }
    assert.deepEqual(powerOffCalls, [], 'powered off because of an NTP clock step');
  });

  it('is suppressed inside an overnight power window (21:50 -> 09:50)', async () => {
    await schedulesDB.read();
    for (const day of DAY_NAMES) {
      schedulesDB.data.left[day].power = { on: '21:50', off: '09:50', enabled: true, onTemperature: 82 };
    }
    await schedulesDB.write();

    // 03:00 Monday, inside Sunday-night's window.
    await runTicks(at('2026-03-02T03:00:00'), 60);
    assert.deepEqual(powerOffCalls, [], 'auto-off fired inside the scheduled on-window');
  });

  it('is NOT suppressed all day by a morning power window (06:00 -> 09:00)', async () => {
    // A morning-only schedule. At 20:00, hours after the 09:00 off, the bed
    // is on with nobody in it: the safety net should still fire.
    await schedulesDB.read();
    for (const day of DAY_NAMES) {
      schedulesDB.data.left[day].power = { on: '06:00', off: '09:00', enabled: true, onTemperature: 82 };
    }
    await schedulesDB.write();

    await runTicks(at('2026-03-02T20:00:00'), 60, heartbeatAbsent);
    assert.equal(powerOffCalls.length > 0, true, 'auto-off suppressed long after the schedule window closed');
  });

  it('is NOT suppressed by a midday power window ending at 12:30', async () => {
    await schedulesDB.read();
    for (const day of DAY_NAMES) {
      schedulesDB.data.left[day].power = { on: '08:00', off: '12:30', enabled: true, onTemperature: 82 };
    }
    await schedulesDB.write();

    await runTicks(at('2026-03-02T18:00:00'), 60, heartbeatAbsent);
    assert.equal(powerOffCalls.length > 0, true, 'auto-off suppressed after a midday window closed');
  });

  it('does not power off a side whose schedule is paused', async () => {
    await settingsDB.read();
    settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
    await settingsDB.write();
    await runTicks(at('2026-03-02T14:00:00'), 50, heartbeatAbsent);
    assert.deepEqual(powerOffCalls, [], 'powered off a paused side');
  });

  it('acts again once the pause has ended', async () => {
    await settingsDB.read();
    settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-03-02T13:00:00Z' };
    await settingsDB.write();
    await runTicks(at('2026-03-02T14:00:00'), 50, heartbeatAbsent);
    assert.equal(powerOffCalls.length > 0, true, 'an ended pause still held off auto-off');
  });

  it('keeps a side left on in bed after a pause, then turns it off once they are up', async () => {
    await settingsDB.read();
    settingsDB.data.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-03-02T13:00:00Z' };
    await settingsDB.write();
    let offWhileInBed = false;
    await runTicks(at('2026-03-02T14:00:00'), 120, (i) => {
      const now = moment.tz(Date.now(), 'UTC').format();
      if (i < 60) {
        presenceState.left = { present: true, lastUpdatedAt: now, lastPresenceAt: now };
        offWhileInBed ||= powerOffCalls.length > 0;
      } else {
        presenceState.left = { ...presenceState.left, present: false, lastUpdatedAt: now };
      }
    });
    assert.equal(offWhileInBed, false, 'powered off while in bed');
    assert.equal(powerOffCalls.length > 0, true, 'stayed on once they were up');
  });

  it('still acts on a side whose partner is paused', async () => {
    await settingsDB.read();
    settingsDB.data.right.scheduleOverrides.pause = { active: true, expiresAt: '' };
    await settingsDB.write();
    await runTicks(at('2026-03-02T14:00:00'), 50, heartbeatAbsent);
    assert.equal(powerOffCalls.length > 0, true, 'the partner pause suppressed auto-off');
  });

  it('does not fire when the stream goes quiet after reporting a dropout', async () => {
    // User in bed since 01:00. At 02:00 the stream reports a dropout
    // (present=false) and then stops reporting entirely. Presence is unknown
    // from that point, so the monitor must hold rather than shut the bed off.
    presenceState.left = {
      present: true,
      lastPresenceAt: moment.tz('2026-03-02T02:00:00', 'UTC').format(),
    };
    await runTicks(at('2026-03-02T02:00:00'), 60, (i) => {
      if (i === 1) presenceState.left.present = false;
    });
    assert.deepEqual(powerOffCalls, [], 'powered off during a presence dropout');
  });

  it('stays out of a Rhythms sleep when Rhythms is active', async () => {
    const { setEngineActivation } = await import('../jobs/scheduleQueries.js');
    const { everyNight, testNight, testRhythmsDB } = await import('../jobs/rhythms/testSupport.js');
    await schedulesDB.read();
    setEngineActivation({ active: true, db: testRhythmsDB(schedulesDB.data, everyNight(testNight('13:00', '17:00'))) });
    try {
      // Every weekly window is disabled in beforeEach, so only the rhythm covers 14:00 to 15:00.
      await runTicks(at('2026-03-02T14:00:00'), 60, heartbeatAbsent);
      assert.deepEqual(powerOffCalls, [], 'auto-off fired inside a Rhythms sleep');
    } finally {
      setEngineActivation({ active: false, reason: 'flag-off' });
    }
  });

  it('stays out of a "When I get up" sleep kept on past its set off', async () => {
    const { setEngineActivation } = await import('../jobs/scheduleQueries.js');
    const { everyNight, testNight, testRhythmsDB } = await import('../jobs/rhythms/testSupport.js');
    const { startCurveController, stopCurveController } = await import('../jobs/rhythms/curveController.js');
    const { resolveSleeps } = await import('../jobs/rhythms/resolve.js');
    const { DEFAULT_SMART } = await import('../db/rhythmsSchema.js');
    await schedulesDB.read();
    const side = everyNight(testNight('13:00', '17:00'));
    side.rhythms['every-night'].temperatureMode = 'smart';
    side.rhythms['every-night'].smart = { ...DEFAULT_SMART, offWhenUp: true };
    const db = testRhythmsDB(schedulesDB.data, side);
    setEngineActivation({ active: true, db });
    const setOff = new Date(at('2026-03-02T17:00:00'));
    const inBed = { present: true, lastUpdatedAt: setOff.toISOString(), stateChangedAt: setOff.toISOString() };
    const controller = startCurveController({
      now: () => setOff,
      presence: () => ({ left: inBed, right: { present: false } }),
      awayMode: () => ({ left: false, right: false }),
      isPaused: () => false,
      sleeps: () => [],
      applyLevel: async () => {},
      retime: () => {},
      recordHistory: async () => {},
      smartOff: {
        sideIsOn: async () => true,
        powerOff: async () => true,
        armTimer: async () => true,
        alarmPending: () => false,
        nextRestart: () => null,
      },
    });
    try {
      const [sleep] = resolveSleeps({ db, side: 'left', timeZone: 'UTC', from: new Date(at('2026-03-02T16:00:00')), to: setOff });
      assert.equal(controller.decideOff('left', sleep, setOff), 'keep');
      // Kept on to 20:00 at the latest; the 45 minute rule stays out of it.
      await runTicks(at('2026-03-02T17:00:00'), 120, heartbeatAbsent);
      assert.deepEqual(powerOffCalls, [], 'auto-off fired while the sleep was kept on');
    } finally {
      stopCurveController();
      setEngineActivation({ active: false, reason: 'flag-off' });
    }
  });

  it('comes back right after a "When I get up" sleep turned off early', async () => {
    const { isInScheduledSleep, setEngineActivation } = await import('../jobs/scheduleQueries.js');
    const { everyNight, testNight, testRhythmsDB } = await import('../jobs/rhythms/testSupport.js');
    const { smartResolveHooks, startCurveController, stopCurveController } = await import('../jobs/rhythms/curveController.js');
    const { resolveSleeps } = await import('../jobs/rhythms/resolve.js');
    const { DEFAULT_SMART } = await import('../db/rhythmsSchema.js');
    await schedulesDB.read();
    const side = everyNight(testNight('13:00', '17:00'));
    const rhythm = side.rhythms['every-night'];
    rhythm.wake = '15:00';
    rhythm.temperatureMode = 'smart';
    rhythm.smart = { ...DEFAULT_SMART, offWhenUp: true };
    const db = testRhythmsDB(schedulesDB.data, side);
    setEngineActivation({ active: true, db });
    const upAt = new Date(at('2026-03-02T15:30:00'));
    const controller = startCurveController({
      now: () => upAt,
      presence: () => ({
        left: { present: false, lastUpdatedAt: upAt.toISOString(), stateChangedAt: new Date(at('2026-03-02T15:10:00')).toISOString() },
        right: { present: false },
      }),
      awayMode: () => ({ left: false, right: false }),
      isPaused: () => false,
      sleeps: (sleepSide, from, to) => resolveSleeps({ db, side: sleepSide, timeZone: 'UTC', from, to, ...smartResolveHooks }),
      applyLevel: async () => {},
      retime: () => {},
      recordHistory: async () => {},
      smartOff: {
        sideIsOn: async () => true,
        powerOff: async () => true,
        armTimer: async () => true,
        alarmPending: () => false,
        nextRestart: () => null,
      },
    });
    try {
      await controller.tick();
      assert.equal(controller.powerOffFor('left', '2026-03-02')?.toISOString(), upAt.toISOString());
      assert.equal(isInScheduledSleep('left', new Date(at('2026-03-02T15:31:00'))), false);
      // Without the early off the sleep would run to 17:00 and keep it out.
      await runTicks(at('2026-03-02T15:31:00'), 50, heartbeatAbsent);
      assert.ok(powerOffCalls.length > 0, 'auto-off stayed out after the early off');
    } finally {
      stopCurveController();
      setEngineActivation({ active: false, reason: 'flag-off' });
    }
  });
});
