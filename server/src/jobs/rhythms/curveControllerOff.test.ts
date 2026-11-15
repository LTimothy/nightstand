import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import moment from 'moment-timezone';
import type { AlarmSchedule, Side } from '../../db/schedulesSchema.js';
import { DEFAULT_SMART, type SmartSchedule } from '../../db/rhythmsSchema.js';
import type { PresenceSnapshot } from './confirmation.js';
import { withPowerOff, type ResolvedSleep } from './resolve.js';
import { applySmartCurve } from './smartSleep.js';
import {
  CurveController, liveCurveState, startCurveController, stopCurveController, type CurveControllerDeps, type SleepSummary,
} from './curveController.js';

const TZ = 'America/Los_Angeles';
const MINUTE = 60_000;
const DATE = '2026-09-29';
const NEXT = '2026-09-30';
const local = (text: string) => moment.tz(text, 'YYYY-MM-DD HH:mm', TZ).toDate();
const t = (hhmm: string) => local(`${NEXT} ${hhmm}`);
const hhmm = (date: Date) => moment(date).tz(TZ).format('HH:mm');
const iso = (time: string) => t(time).toISOString();

const ALARM: AlarmSchedule = {
  time: '06:30', enabled: true, alarmTemperature: 82, vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60,
};

// 22:45 to 07:30 with a 06:30 wake, as resolveNight builds it before the curve.
function nightSleep(side: Side, smart: SmartSchedule, alarmAt: string | null): ResolvedSleep {
  const start = local(`${DATE} 22:45`);
  const end = t('07:30');
  const alarms = alarmAt === null ? [] : [{ kind: 'alarm' as const, at: t(alarmAt), alarm: { ...ALARM, time: alarmAt }, index: 0 }];
  return {
    side, date: DATE, rhythmId: 'workday', start, end, wake: t('06:30'),
    night: { temperatures: {}, alarm: ALARM, alarms: [], power: { on: '22:45', off: '07:30', onTemperature: 80, enabled: true } },
    mode: 'smart', smart, ...(smart.offWhenUp ? { offWhenUp: true as const } : {}),
    events: [{ kind: 'power-on', at: start, temperatureF: 80 }, ...alarms, { kind: 'power-off', at: end }],
  };
}

// The next sleep on the side: a two hour nap from `start` the same morning.
function laterSleep(side: Side, start: string): ResolvedSleep {
  const at = t(start);
  const end = new Date(at.getTime() + 120 * MINUTE);
  return {
    side, date: NEXT, rhythmId: 'nap', start: at, end, wake: end,
    night: { temperatures: {}, alarm: ALARM, alarms: [], power: { on: start, off: hhmm(end), onTemperature: 80, enabled: true } },
    mode: 'manual',
    events: [{ kind: 'power-on', at, temperatureF: 80 }, { kind: 'power-off', at: end }],
  };
}

// The same night set by hand: no Smart Schedule, "When I get up" kept on the sleep.
function asManual(sleep: ResolvedSleep): ResolvedSleep {
  const manual: ResolvedSleep = { ...sleep, mode: 'manual' };
  delete manual.smart;
  return manual;
}

type Stream = (now: Date) => Partial<Record<Side, boolean>>;
type Options = {
  // Smart Schedule settings per side; a side left out has no sleep.
  smart?: Partial<Record<Side, Partial<SmartSchedule>>>;
  // The alarm of each side's sleep, null for none; 06:30 when left out.
  alarms?: Partial<Record<Side, string | null>>;
  away?: Record<Side, boolean>;
  paused?: (now: Date) => boolean;
  start?: string;
  laterStart?: string;
  restart?: string;
  // What the live wiring adds to the sleep's own alarms: ringing, one-time and override alarms.
  jobsPending?: (now: Date) => boolean;
  // May throw, as a failed read of the Pod would.
  sideOn?: (now: Date, side: Side) => boolean | null;
  // The off and timer writes for this side are rejected, until failUntil when given.
  failWrites?: Side;
  failUntil?: string;
  wired?: boolean;
  // Sides whose sleep is a manual rhythm; "When I get up" still comes from `smart`.
  manual?: Side[];
  // Runs as the module's controller, so liveCurveState reads it.
  active?: boolean;
};

function harness(options: Options = {}) {
  let smartBySide: Partial<Record<Side, Partial<SmartSchedule>>> = options.smart ?? { left: { offWhenUp: true } };
  let laterStart = options.laterStart;
  let away = options.away ?? { left: false, right: false };
  let clock = local(options.start ?? `${NEXT} 06:00`);
  // A retime starts a rebuild, which empties the job list until it is done (by the next minute here).
  let rebuilding = false;
  const alarmFor = (side: Side): string | null => {
    const value = options.alarms?.[side];
    return value === undefined ? '06:30' : value;
  };
  const presence: PresenceSnapshot = { left: { present: false }, right: { present: false } };
  const offs: Array<[Side, string]> = [];
  const arms: Array<[Side, string, string]> = [];
  const failed: Array<[Side, 'off' | 'arm', string]> = [];
  const applied: Array<[Side, number, string]> = [];
  const history: SleepSummary[] = [];
  let retimes = 0;
  let sleepsFail = false;
  const failing = (side: Side) => side === options.failWrites && (!options.failUntil || clock < t(options.failUntil));

  const resolveWith = (owner: CurveController, side: Side): ResolvedSleep[] => {
    const over = smartBySide[side];
    if (!over) return [];
    const planned = nightSleep(side, { ...DEFAULT_SMART, ...over }, alarmFor(side));
    const night = withPowerOff(options.manual?.includes(side) ? asManual(planned) : planned, owner.powerOffFor(side, DATE));
    const sleeps = [applySmartCurve(night, TZ, owner.coolStartFor(side, DATE))];
    if (laterStart) sleeps.push(laterSleep(side, laterStart));
    return sleeps;
  };

  const create = options.active ? startCurveController : (deps: CurveControllerDeps) => new CurveController(deps);
  const controller: CurveController = create({
    now: () => clock,
    presence: () => presence,
    awayMode: () => away,
    isPaused: (_side, now) => options.paused?.(now) ?? false,
    sleeps: (side, from, to) => {
      if (sleepsFail) throw new Error('schedule unreadable');
      return resolveWith(controller, side).filter(sleep => sleep.start < to && sleep.end > from);
    },
    applyLevel: async (side, level) => { applied.push([side, level, hhmm(clock)]); },
    retime: () => {
      retimes += 1;
      rebuilding = true;
    },
    recordHistory: async summary => { history.push(summary); },
    ...(options.wired === false ? {} : {
      smartOff: {
        sideIsOn: async side => (options.sideOn ? options.sideOn(clock, side) : true),
        // Rejected later, as a write the Pod never takes is.
        powerOff: async side => {
          const at = hhmm(clock);
          await Promise.resolve();
          if (failing(side)) {
            failed.push([side, 'off', at]);
            throw new Error('write failed');
          }
          offs.push([side, at]);
          return true;
        },
        armTimer: async (side, until) => {
          const at = hhmm(clock);
          await Promise.resolve();
          if (failing(side)) {
            failed.push([side, 'arm', at]);
            throw new Error('write failed');
          }
          arms.push([side, hhmm(until), at]);
          return true;
        },
        alarmPending: () => rebuilding || (options.jobsPending?.(clock) ?? false),
        nextRestart: after => {
          const at = options.restart ? t(options.restart) : null;
          return at && at > after ? at : null;
        },
      },
    }),
  });

  // Mirrors POST /api/metrics/presence: stateChangedAt moves only on a change.
  const report = (side: Side, present: boolean) => {
    const stamp = moment(clock).tz(TZ).format();
    const current = presence[side];
    if (!current.stateChangedAt || current.present !== present) current.stateChangedAt = stamp;
    current.present = present;
    current.lastUpdatedAt = stamp;
  };

  const runUntil = async (time: string, stream: Stream = () => ({})) => {
    const end = t(time).getTime();
    while (clock.getTime() < end) {
      clock = new Date(clock.getTime() + MINUTE);
      rebuilding = false;
      const reports = stream(clock);
      for (const side of ['left', 'right'] as const) {
        const value = reports[side];
        if (value !== undefined) report(side, value);
      }
      await controller.tick();
    }
  };

  // What the power-off job asks, with the sleep it was planned with.
  const decide = (side: Side = 'left') => {
    const [sleep] = resolveWith(controller, side);
    assert.ok(sleep, `no ${side} sleep`);
    return controller.decideOff(side, sleep, clock);
  };

  return {
    controller, offs, arms, failed, applied, history, runUntil, decide, report,
    retimes: () => retimes,
    now: () => clock,
    curve: () => resolveWith(controller, 'left')[0]?.smartCurve,
    setSmart: (next: Partial<Record<Side, Partial<SmartSchedule>>>) => { smartBySide = next; },
    setLaterStart: (next: string) => { laterStart = next; },
    setAway: (next: Record<Side, boolean>) => { away = next; },
    failSleeps: (fail: boolean) => { sleepsFail = fail; },
    last: (side: Side = 'left') => history.filter(item => item.side === side).at(-1),
  };
}

const before = (time: string) => (now: Date) => now < t(time);
const inBed = (time: string): Stream => now => ({ left: before(time)(now) });
const always: Stream = () => ({ left: true });

describe('"When I get up" at the set off', () => {
  it('turns off at the set time when the bed is empty, and logs it', async () => {
    const h = harness();
    await h.runUntil('07:30', inBed('07:25'));
    assert.equal(h.decide(), 'off');
    await h.runUntil('07:31', inBed('07:25'));
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('07:30'));
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'set-time');
    assert.equal(h.last()?.actualOff, iso('07:30'));
    assert.equal(h.last()?.powerOff, iso('07:30'));
    assert.equal(h.last()?.offWhenUp, true);
  });

  it('turns off at the set time when presence is stale', async () => {
    const h = harness();
    await h.runUntil('07:30');
    assert.equal(h.decide(), 'off');
    await h.runUntil('07:31');
    assert.equal(h.last()?.offReason, 'stale');
  });

  it('turns off at the set time when there is no room before the next sleep', async () => {
    const h = harness({ laterStart: '08:00' });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'off');
    await h.runUntil('07:31', always);
    assert.equal(h.last()?.offReason, 'no-room');
  });

  it('turns off at the set time without the wiring', async () => {
    const h = harness({ wired: false });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'off');
    assert.equal(h.controller.powerOffFor('left', DATE), undefined);
    await h.runUntil('07:31', always);
    assert.equal(h.last()?.offReason, 'set-time');
    assert.equal(h.last()?.offWhenUp, false);
  });

  it('logs a decision that threw as its own outcome, off at the set time', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    h.failSleeps(true);
    assert.throws(() => h.decide(), /schedule unreadable/);
    h.failSleeps(false);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('07:30'));
    await h.runUntil('07:31', always);
    assert.equal(h.last()?.offReason, 'decision-failed');
    assert.equal(h.last()?.actualOff, iso('07:30'));
  });

  it('logs a sleep paused at the set off as paused', async () => {
    const h = harness({ paused: now => now >= t('07:30') });
    await h.runUntil('07:45', always);
    assert.equal(h.last()?.offReason, 'paused');
    assert.equal(h.last()?.actualOff, null);
  });
});

describe('"When I get up" past the set off', () => {
  it('stays on while in bed, steps the timer, and turns off 10 minutes after getting up', async () => {
    const h = harness();
    await h.runUntil('07:30', inBed('08:10'));
    assert.equal(h.decide(), 'keep');
    assert.equal(h.retimes() > 0, true);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('10:30'));
    await h.runUntil('08:30', inBed('08:10'));
    assert.deepEqual(h.arms[0], ['left', '07:46', '07:31']);
    for (const [, until, at] of h.arms) assert.equal(t(until).getTime() - t(at).getTime(), 15 * MINUTE);
    assert.deepEqual(h.offs, [['left', '08:20']]);
    assert.equal(h.last()?.offReason, 'got-up');
    assert.equal(h.last()?.actualOff, iso('08:20'));
    assert.equal(h.last()?.powerOff, iso('07:30'));
    assert.deepEqual(h.applied, []);
  });

  it('does not count a short trip out of bed', async () => {
    const h = harness();
    const stream: Stream = now => ({ left: now < t('08:00') || (now >= t('08:05') && now < t('08:30')) });
    await h.runUntil('07:30', stream);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:45', stream);
    assert.deepEqual(h.offs, [['left', '08:40']]);
  });

  it('turns off at the latest, 3 hours after the set off, and never arms past it', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', always);
    assert.deepEqual(h.offs, [['left', '10:30']]);
    assert.deepEqual(h.arms.at(-1), ['left', '10:30', '10:16']);
    assert.equal(h.last()?.offReason, 'cap');
    assert.equal(h.last()?.actualOff, iso('10:30'));
    assert.equal(h.decide(), 'off');
  });

  it('stays clear of the next sleep and of the daily restart', async () => {
    const nap = harness({ laterStart: '09:00' });
    await nap.runUntil('07:30', always);
    assert.equal(nap.decide(), 'keep');
    await nap.runUntil('08:31', always);
    assert.deepEqual(nap.offs, [['left', '08:30']]);

    const restart = harness({ restart: '08:15' });
    await restart.runUntil('07:30', always);
    assert.equal(restart.decide(), 'keep');
    await restart.runUntil('07:46', always);
    assert.deepEqual(restart.offs, [['left', '07:45']]);
  });

  it('moves the latest earlier when the next sleep is moved earlier', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    h.setLaterStart('09:00');
    await h.runUntil('08:31', always);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:30'));
    assert.deepEqual(h.offs, [['left', '08:30']]);
  });

  it('re-arms the timer when the latest moves before the armed step', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    assert.deepEqual(h.arms.at(-1), ['left', '08:11', '07:56']);
    // A nap at 08:35 puts the latest at 08:05, before the step armed to 08:11.
    h.setLaterStart('08:35');
    await h.runUntil('08:06', always);
    assert.deepEqual(h.arms.at(-1), ['left', '08:05', '08:01']);
    assert.deepEqual(h.offs, [['left', '08:05']]);
    assert.equal(h.last()?.offReason, 'cap');
  });

  it('turns off at once, and logs that minute, when an edit puts the latest in the past', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    // A nap at 08:20 puts the latest at 07:50, already past.
    h.setLaterStart('08:20');
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, [['left', '08:01']]);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:01'));
    assert.equal(h.last()?.offReason, 'cap');
    assert.equal(h.last()?.actualOff, iso('08:01'));
  });

  it('never turns off a next sleep that has already started', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    // An edit moves the next sleep to 08:00, so it has powered on and the side is its own.
    h.setLaterStart('08:00');
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'stopped');
    assert.equal(h.last()?.actualOff, iso('08:01'));
  });

  it('turns off at once when presence goes stale', async () => {
    const h = harness();
    const stream: Stream = now => (now < t('08:00') ? { left: true } : {});
    await h.runUntil('07:30', stream);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:10', stream);
    assert.deepEqual(h.offs, [['left', '08:05']]);
    assert.equal(h.last()?.offReason, 'stale');
  });

  it('stops when the side is found off, without writing', async () => {
    const h = harness({ sideOn: now => now < t('08:00') });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'side-off');
    assert.equal(h.last()?.actualOff, iso('08:00'));
  });

  it('never arms a side it cannot read', async () => {
    const h = harness({ sideOn: () => null });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    assert.deepEqual(h.arms, []);
    assert.deepEqual(h.offs, []);
  });

  it('turns a side it cannot read off at the latest', async () => {
    const h = harness({ sideOn: () => null });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', always);
    assert.deepEqual(h.arms, []);
    assert.deepEqual(h.offs, [['left', '10:30']]);
    assert.equal(h.last()?.offReason, 'cap');
    assert.equal(h.last()?.actualOff, iso('10:30'));
  });

  it('turns a side it cannot read off at once when presence goes stale', async () => {
    const h = harness({ sideOn: () => null });
    const stream: Stream = now => (now < t('08:00') ? { left: true } : {});
    await h.runUntil('07:30', stream);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:10', stream);
    assert.deepEqual(h.offs, [['left', '08:05']]);
    assert.equal(h.last()?.offReason, 'stale');
    assert.equal(h.last()?.actualOff, iso('08:05'));
  });

  it('keeps the set time for a side it cannot read when presence is stale at the set off', async () => {
    const h = harness({ sideOn: () => null });
    await h.runUntil('07:30', now => (now < t('07:20') ? { left: true } : {}));
    assert.equal(h.decide(), 'off');
    await h.runUntil('07:31');
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'stale');
    assert.equal(h.last()?.actualOff, iso('07:30'));
  });

  it('a failed read of one side counts as unreadable and the other side still runs', async () => {
    const h = harness({
      smart: { left: { offWhenUp: true }, right: { offWhenUp: true } },
      sideOn: (_now, side) => {
        if (side === 'left') throw new Error('read failed');
        return true;
      },
    });
    const both: Stream = () => ({ left: true, right: true });
    await h.runUntil('07:30', both);
    assert.equal(h.decide('left'), 'keep');
    assert.equal(h.decide('right'), 'keep');
    await h.runUntil('08:00', both);
    assert.deepEqual(h.arms.filter(([side]) => side === 'left'), []);
    assert.deepEqual(h.arms.filter(([side]) => side === 'right')[0], ['right', '07:46', '07:31']);
    assert.deepEqual(h.offs, []);
    assert.equal(h.controller.isExtended('left', DATE), true);
  });

  it('a rejected write changes nothing and is tried again on the next tick, and the other side still runs', async () => {
    const h = harness({ smart: { left: { offWhenUp: true }, right: { offWhenUp: true } }, failWrites: 'left', failUntil: '08:12' });
    const stream: Stream = now => ({ left: now < t('08:00'), right: true });
    await h.runUntil('07:30', stream);
    assert.equal(h.decide('left'), 'keep');
    assert.equal(h.decide('right'), 'keep');
    await h.runUntil('08:15', stream);
    // No step landed, so each tick tries again.
    assert.deepEqual(h.failed.filter(([, kind]) => kind === 'arm').map(([, , at]) => at).slice(0, 3), ['07:31', '07:32', '07:33']);
    // Up since 08:00: the off is tried each tick until it lands, and only then logged.
    assert.deepEqual(h.failed.filter(([, kind]) => kind === 'off'), [['left', 'off', '08:10'], ['left', 'off', '08:11']]);
    assert.deepEqual(h.offs, [['left', '08:12']]);
    assert.equal(h.last('left')?.offReason, 'got-up');
    assert.equal(h.last('left')?.actualOff, iso('08:12'));
    assert.deepEqual(h.arms.filter(([side]) => side === 'right')[0], ['right', '07:46', '07:31']);
    assert.equal(h.controller.isExtended('right', DATE), true);
  });

  it('counts a step as armed only once the Pod takes it', async () => {
    const h = harness({ failWrites: 'left', failUntil: '07:33' });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('07:40', always);
    assert.deepEqual(h.failed.map(([, , at]) => at), ['07:31', '07:32']);
    assert.deepEqual(h.arms[0], ['left', '07:48', '07:33']);
  });

  it('tries an early off again on the next tick when the Pod rejects it', async () => {
    const h = harness({ alarms: { left: null }, failWrites: 'left', failUntil: '06:52' });
    await h.runUntil('06:55', inBed('06:40'));
    assert.deepEqual(h.failed, [['left', 'off', '06:50'], ['left', 'off', '06:51']]);
    assert.deepEqual(h.offs, [['left', '06:52']]);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('06:52'));
    assert.equal(h.last()?.offReason, 'got-up');
  });

  it('a restart forgets the extension: it neither keeps the side on nor writes', async () => {
    const h = harness({ start: `${NEXT} 08:00` });
    await h.runUntil('09:00', always);
    assert.deepEqual(h.arms, []);
    assert.deepEqual(h.offs, []);
    assert.equal(h.controller.powerOffFor('left', DATE), undefined);
    assert.deepEqual(h.history, []);
  });
});

describe('"When I get up" after the wake time', () => {
  it('turns off 10 minutes after getting up, once no alarm is left', async () => {
    const h = harness({ alarms: { left: null } });
    await h.runUntil('06:55', inBed('06:40'));
    assert.deepEqual(h.offs, [['left', '06:50']]);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('06:50'));
    assert.equal(h.last()?.offReason, 'got-up');
    assert.equal(h.last()?.actualOff, iso('06:50'));
    assert.equal(h.last()?.powerOff, iso('07:30'));
  });

  it('counts from the wake time, not from an earlier exit', async () => {
    const h = harness({ alarms: { left: null } });
    await h.runUntil('06:45', () => ({ left: false }));
    assert.deepEqual(h.offs, [['left', '06:40']]);
  });

  it('waits for an alarm still ahead, from the sleep itself', async () => {
    const h = harness({ alarms: { left: '07:00' } });
    await h.runUntil('07:05', inBed('06:35'));
    assert.deepEqual(h.offs, [['left', '07:02']]);
  });

  it('never turns off while an alarm rings', async () => {
    const h = harness({ alarms: { left: null }, jobsPending: now => now >= t('06:40') && now < t('06:45') });
    await h.runUntil('06:50', inBed('06:30'));
    assert.deepEqual(h.offs, [['left', '06:45']]);
  });

  it('both sides in one tick: a rebuild after the first off leaves the second its own alarm', async () => {
    const h = harness({
      smart: { left: { offWhenUp: true }, right: { offWhenUp: true } },
      alarms: { left: null, right: '07:00' },
    });
    await h.runUntil('07:05', () => ({ left: false, right: false }));
    assert.deepEqual(h.offs, [['left', '06:40'], ['right', '07:02']]);
  });

  it('waits while the jobs are re-planned', async () => {
    const h = harness({ smart: { left: { offWhenUp: true }, right: { offWhenUp: true } }, alarms: { left: null, right: null } });
    await h.runUntil('06:45', () => ({ left: false, right: false }));
    // The left off starts a rebuild in the same tick, so the right side waits a minute.
    assert.deepEqual(h.offs, [['left', '06:40'], ['right', '06:41']]);
  });

  it('restarts the count when they get back into bed', async () => {
    const h = harness({ alarms: { left: null } });
    const stream: Stream = now => ({ left: now < t('06:35') || (now >= t('06:42') && now < t('06:50')) });
    await h.runUntil('07:05', stream);
    assert.deepEqual(h.offs, [['left', '07:00']]);
  });

  it('restarts the count for a return to bed between two ticks', async () => {
    const h = harness({ alarms: { left: null } });
    await h.runUntil('06:40', inBed('06:35'));
    // In and out again before the next look: only the newer change time shows it.
    h.report('left', true);
    h.report('left', false);
    await h.runUntil('06:55', inBed('06:35'));
    assert.deepEqual(h.offs, [['left', '06:50']]);
  });

  it('stays off once off, even back in bed', async () => {
    const h = harness({ alarms: { left: null } });
    const stream: Stream = now => ({ left: now < t('06:40') || now >= t('06:55') });
    await h.runUntil('07:40', stream);
    assert.deepEqual(h.offs, [['left', '06:50']]);
    assert.deepEqual(h.arms, []);
    assert.equal(h.controller.status('left', h.now()), null);
    assert.equal(h.history.length, 1);
  });

  it('counts a failed alarm check as an alarm still to come', async () => {
    const h = harness({
      alarms: { left: null },
      jobsPending: now => {
        if (now < t('06:45')) throw new Error('check failed');
        return false;
      },
    });
    await h.runUntil('06:50', inBed('06:30'));
    assert.deepEqual(h.offs, [['left', '06:45']]);
  });

  it('holds the wake level instead of dropping to the base when out of bed', async () => {
    const up = harness({ alarms: { left: null } });
    await up.runUntil('06:39', inBed('06:31'));
    assert.deepEqual(up.applied, []);
    assert.equal(up.curve()?.points.at(-1)?.phase, 'wake');

    const plain = harness({ alarms: { left: null }, smart: { left: {} } });
    await plain.runUntil('06:39', inBed('06:31'));
    assert.deepEqual(plain.applied, [['left', 0, '06:31']]);
  });
});

describe('"When I get up" with pause, holds, away mode and both sides', () => {
  it('never turns off early while paused', async () => {
    const h = harness({ alarms: { left: null }, paused: () => true });
    await h.runUntil('07:20', inBed('06:30'));
    assert.deepEqual(h.offs, []);
  });

  it('a pause while kept on sets the timer to the latest and leaves the side to it', async () => {
    const h = harness({ paused: now => now >= t('08:00') });
    await h.runUntil('07:30', inBed('08:10'));
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', inBed('08:10'));
    assert.deepEqual(h.arms.at(-1), ['left', '10:30', '08:00']);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'paused');
    assert.equal(h.last()?.actualOff, iso('10:30'));
  });

  it('a pause right after the keep, on a side it cannot read, writes nothing and logs nothing early', async () => {
    const h = harness({ paused: now => now >= t('07:31'), sideOn: () => null });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('09:00', always);
    assert.deepEqual(h.offs, []);
    assert.deepEqual(h.history, []);
    await h.runUntil('10:31', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'paused');
    assert.equal(h.last()?.actualOff, iso('10:30'));
  });

  it('tries the pause timer again on the next tick when the Pod rejects it', async () => {
    const h = harness({ paused: now => now >= t('08:00'), failWrites: 'left', failUntil: '08:03' });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', always);
    assert.deepEqual(h.failed.filter(([, , at]) => at >= '08:00').map(([, , at]) => at), ['08:00', '08:01', '08:02']);
    assert.deepEqual(h.arms.filter(([, , at]) => at >= '08:00'), [['left', '10:30', '08:03']]);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'paused');
    assert.equal(h.last()?.actualOff, iso('10:30'));
  });

  it('keeps trying the pause timer while the Pod rejects it, and leaves the side to it', async () => {
    const h = harness({ paused: now => now >= t('08:00'), failWrites: 'left' });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', always);
    const during = h.failed.filter(([, kind, at]) => kind === 'arm' && at >= '08:00').map(([, , at]) => at);
    assert.deepEqual(during.slice(0, 3), ['08:00', '08:01', '08:02']);
    assert.equal(during.at(-1), '10:29');
    assert.deepEqual(h.arms, []);
    assert.deepEqual(h.failed.filter(([, kind]) => kind === 'off'), []);
    assert.equal(h.last()?.offReason, 'paused');
    assert.equal(h.last()?.actualOff, iso('10:30'));
  });

  it('records a side found off at a pause as off then, without writing', async () => {
    const h = harness({ paused: now => now >= t('08:00'), sideOn: now => now < t('08:00') });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.deepEqual(h.arms.filter(([, , at]) => at >= '08:00'), []);
    assert.equal(h.last()?.offReason, 'side-off');
    assert.equal(h.last()?.actualOff, iso('08:00'));
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:00'));
  });

  it('lets presence decide again once a pause ends before the latest off', async () => {
    const h = harness({ paused: now => now >= t('08:00') && now < t('08:30') });
    await h.runUntil('07:30', inBed('08:40'));
    assert.equal(h.decide(), 'keep');
    await h.runUntil('09:00', inBed('08:40'));
    assert.deepEqual(h.arms.filter(([, , at]) => at === '08:00' || at === '08:30'), [['left', '10:30', '08:00'], ['left', '08:45', '08:30']]);
    assert.deepEqual(h.offs, [['left', '08:50']]);
  });

  it('a manual change while kept on holds to the off, and getting up still turns it off', async () => {
    const h = harness();
    await h.runUntil('07:30', inBed('08:30'));
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', inBed('08:30'));
    assert.equal(h.controller.noteManualChange('left', h.now()), 'held');
    assert.equal(h.controller.status('left', h.now())?.holdUntil?.toISOString(), iso('10:30'));
    await h.runUntil('08:45', inBed('08:30'));
    assert.deepEqual(h.offs, [['left', '08:40']]);
  });

  it('reads both sides when the other side is away, and writes the present side', async () => {
    const h = harness({ away: { left: false, right: true } });
    const stream: Stream = now => ({ right: now < t('08:00') });
    await h.runUntil('07:30', stream);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:15', stream);
    assert.deepEqual(h.offs, [['left', '08:10']]);
  });

  it('keeps two sides apart: one when up, one at its set time', async () => {
    const h = harness({ smart: { left: { offWhenUp: true }, right: {} } });
    const stream: Stream = () => ({ left: true, right: true });
    await h.runUntil('07:30', stream);
    assert.equal(h.decide('left'), 'keep');
    assert.equal(h.decide('right'), 'off');
    await h.runUntil('07:45', stream);
    assert.equal(h.controller.powerOffFor('right', DATE), undefined);
    assert.equal(h.last('right')?.offReason, 'set-time');
    assert.equal(h.last('right')?.offWhenUp, false);
    assert.equal(h.arms.length > 0, true);
    assert.equal(h.arms.every(([side]) => side === 'left'), true);
  });

  it('stops keeping the side on when the rhythm no longer turns off when up', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    h.setSmart({ left: {} });
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.last()?.offReason, 'stopped');
    assert.equal(h.last()?.actualOff, iso('08:01'));
  });

  it('says when it turns off at the latest while presence is fresh, before and while kept on', async () => {
    const h = harness({ laterStart: '09:00' });
    await h.runUntil('07:00', always);
    assert.equal(h.controller.status('left', h.now())?.offBy?.toISOString(), iso('08:30'));
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('07:35', always);
    assert.equal(h.controller.status('left', h.now())?.offBy?.toISOString(), iso('08:30'));

    const plain = harness({ smart: { left: {} } });
    await plain.runUntil('07:00', always);
    assert.equal(plain.controller.status('left', plain.now())?.offBy, null);
  });

  it('says when it turns off right after the keep, before the next tick', async () => {
    const h = harness();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    for (const at of [h.now(), new Date(h.now().getTime() + 59_000)]) {
      assert.equal(h.controller.status('left', at)?.offBy?.toISOString(), iso('10:30'));
    }
  });

  it('promises nothing while presence is stale, since the set time then applies', async () => {
    const h = harness();
    await h.runUntil('07:00');
    assert.notEqual(h.controller.status('left', h.now()), null);
    assert.equal(h.controller.status('left', h.now())?.offBy, null);
  });
});

describe('"When I get up" on a rhythm set by hand', () => {
  const manual = (options: Options = {}) => harness({ manual: ['left'], ...options });

  it('turns a manual sleep off once the person has been up 10 minutes after the wake', async () => {
    const h = manual({ alarms: { left: null } });
    await h.runUntil('06:55', inBed('06:40'));
    assert.deepEqual(h.offs, [['left', '06:50']]);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('06:50'));
  });

  it('keeps a manual sleep on past its set off while someone is in bed, then off when up', async () => {
    const h = manual();
    await h.runUntil('07:30', inBed('08:10'));
    assert.equal(h.decide(), 'keep');
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('10:30'));
    await h.runUntil('08:30', inBed('08:10'));
    assert.deepEqual(h.arms[0], ['left', '07:46', '07:31']);
    assert.deepEqual(h.offs, [['left', '08:20']]);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:20'));
  });

  it('never changes the temperature of a manual sleep it keeps on', async () => {
    // Up early, then a short trip out of bed after the wake: either can drop a Smart Schedule sleep to its base.
    const stream: Stream = now => ({
      left: now < t('05:00') || (now >= t('05:30') && now < t('06:35')) || (now >= t('06:40') && now < t('08:10')),
    });
    const h = manual({ start: `${DATE} 22:30`, smart: { left: { offWhenUp: true, upEarly: true } } });
    await h.runUntil('07:30', stream);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:30', stream);
    assert.deepEqual(h.offs, [['left', '08:20']]);
    assert.deepEqual(h.applied, []);
  });

  it('shows the latest off on the live view for a manual sleep', async () => {
    const h = manual({ laterStart: '09:00', active: true });
    try {
      await h.runUntil('07:00', always);
      const live = liveCurveState('left', h.now());
      assert.equal(live?.phase, null);
      assert.equal(live?.nextChange, null);
      assert.equal(live?.hold, null);
      assert.equal(live?.baseSince, null);
      assert.equal(live?.offWhenUp?.by, iso('08:30'));
    } finally {
      stopCurveController();
    }
  });

  it('adds no history line for a manual sleep', async () => {
    const h = manual();
    await h.runUntil('07:30', inBed('08:10'));
    assert.equal(h.decide(), 'keep');
    await h.runUntil('11:00', inBed('08:10'));
    assert.deepEqual(h.offs, [['left', '08:20']]);
    assert.deepEqual(h.history, []);
  });

  it('does not follow a manual rhythm without the choice', async () => {
    const h = manual({ smart: { left: {} } });
    await h.runUntil('07:00', always);
    assert.equal(h.controller.status('left', h.now()), null);
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'off');
    assert.equal(h.controller.powerOffFor('left', DATE), undefined);
    await h.runUntil('08:00', always);
    assert.deepEqual(h.offs, []);
    assert.deepEqual(h.arms, []);
  });

  it('leaves a manual sleep kept on to its timer while paused', async () => {
    const h = manual({ paused: now => now >= t('08:00') });
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('10:31', always);
    assert.deepEqual(h.arms.at(-1), ['left', '10:30', '08:00']);
    assert.deepEqual(h.offs, []);
    assert.equal(h.controller.isExtended('left', DATE), false);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('10:30'));
  });

  it('stops following a manual sleep when away mode turns on', async () => {
    const h = manual();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    h.setAway({ left: true, right: false });
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.controller.isExtended('left', DATE), false);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:01'));
  });

  it('hands a manual sleep to its timer when the choice is turned off mid-extension', async () => {
    const h = manual();
    await h.runUntil('07:30', always);
    assert.equal(h.decide(), 'keep');
    await h.runUntil('08:00', always);
    const retimes = h.retimes();
    h.setSmart({ left: {} });
    await h.runUntil('08:05', always);
    assert.deepEqual(h.offs, []);
    assert.equal(h.retimes() > retimes, true);
    assert.equal(h.controller.isExtended('left', DATE), false);
    assert.equal(h.controller.powerOffFor('left', DATE)?.toISOString(), iso('08:01'));
  });
});
