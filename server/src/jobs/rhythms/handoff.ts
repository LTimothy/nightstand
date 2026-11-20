import moment from 'moment-timezone';
import logger from '../../logger.js';
import settingsDB, { updateSettings } from '../../db/settings.js';
import schedulesDB from '../../db/schedules.js';
import type { Settings } from '../../db/settingsSchema.js';
import type { Schedules, Side } from '../../db/schedulesSchema.js';
import type { RhythmsDB } from '../../db/rhythmsSchema.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import { getDeviceStatusCoalesced, isFrankenConnected } from '../../8sleep/frankenServer.js';
import { updateDeviceStatus } from '../../routes/deviceStatus/updateDeviceStatus.js';
import { hasAlarmOccurrence } from '../alarmScheduler.js';
import { isAlarmPaused, isSchedulePaused } from '../schedulePause.js';
import { noteManualPowerChange } from '../manualPowerChange.js';
import { drivingSide, engineActivation } from '../scheduleQueries.js';
import { resolveLegacySleeps, resolveSleeps, turnsOffWhenUp, type PowerOffFor, type ResolvedSleep } from './resolve.js';
import { alarmOccurrenceId, firmwareSeconds, forgetArmedEnds, holdForHandBack } from './runEvent.js';
import { keepSleepAlarms } from './scheduleRhythms.js';
import { smartPowerOffFor } from './curveController.js';

export type HandoffAction = 'legacy-takes-over' | 'kept-on-until' | 'powered-off' | 'none';
export type SideHandoff = { side: Side; action: HandoffAction; until?: string; alarmOverrideSet: boolean; deviceUpdateFailed?: true };
export type HandoffReport = { sides: SideHandoff[] };
export type HandoffPlan = {
  side: Side; action: HandoffAction; until?: Date; alarmOverrideExpiresAt?: string; keptSleep?: ResolvedSleep;
  // A "When I get up" sleep's timer runs past its end, so the handoff sets it to the end.
  rearm?: true;
};
export type LeaveReason = 'downgrade' | 'rollback' | 'revert';

const DAY_MS = 24 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepAt(sleeps: ResolvedSleep[], now: Date): ResolvedSleep | undefined {
  const t = now.getTime();
  return sleeps.find(sleep => sleep.start.getTime() <= t && t < sleep.end.getTime());
}

export function planHandoff(input: {
  settings: Settings;
  schedules: Schedules;
  db: RhythmsDB;
  now: Date;
  powerOffNow: boolean;
  isOn: (side: Side) => boolean;
  alarmRang: (side: Side, occurrenceId: string) => boolean;
  powerOffFor?: PowerOffFor;
}): HandoffPlan[] {
  const { settings, schedules, db, now, powerOffNow, isOn, alarmRang, powerOffFor } = input;
  const timeZone = settings.timeZone || 'UTC';
  return SCHEDULE_SIDES.map((side): HandoffPlan => {
    const driver = drivingSide(settings, side);
    // An off side changes nothing, but with alarms ringing when off it still needs the alarm override.
    const off = !isOn(side);
    if (!driver || (off && !settings.features.alarmsWhenOff)) return { side, action: 'none' };
    const sleep = sleepAt(resolveSleeps({ db, side: driver, timeZone, from: now, to: now, powerOffFor }), now);
    if (!sleep) return { side, action: 'none' };
    if (powerOffNow && !off) return { side, action: 'powered-off' };
    let legacy = sleepAt(resolveLegacySleeps({ schedules, side: driver, timeZone, from: now, to: now }), now);
    // A Smart Schedule sleep turns on before its bedtime; during that time the
    // weekly night that starts by the bedtime takes over.
    const bedtime = sleep.smartCurve?.bedtime;
    if (!legacy && bedtime && now < bedtime) {
      legacy = resolveLegacySleeps({ schedules, side: driver, timeZone, from: now, to: bedtime })
        .find(night => night.start <= bedtime && night.end > now);
    }
    // Alarms ring only on the present side.
    if (!legacy) {
      if (off) return { side, action: 'none' };
      const rearm = turnsOffWhenUp(sleep);
      return {
        side, action: 'kept-on-until', until: sleep.end,
        ...(rearm ? { rearm: true as const } : {}),
        ...(side === driver ? { keptSleep: sleep } : {}),
      };
    }
    const plan: HandoffPlan = off ? { side, action: 'none' } : { side, action: 'legacy-takes-over', until: legacy.end };
    const rhythmAlarmRang = sleep.events.some(event => event.kind === 'alarm'
      && event.at.getTime() <= now.getTime()
      && alarmRang(driver, alarmOccurrenceId(driver, sleep, event.at, timeZone)));
    const legacyAlarmAhead = legacy.events.some(event => event.kind === 'alarm' && event.at.getTime() > now.getTime());
    const { expiresAt } = settings[side].scheduleOverrides.alarm;
    const overrideActive = expiresAt !== '' && moment(expiresAt).isAfter(now);
    if (side === driver && rhythmAlarmRang && legacyAlarmAhead && !overrideActive) {
      plan.alarmOverrideExpiresAt = moment.tz(legacy.end, timeZone).format();
    }
    return plan;
  });
}

// Older versions ignore a pause, so before leaving this version a paused side
// skips the alarms of its weekly night in progress, or of the next one within
// a day, when its last alarm is still paused when due: a missed wake alarm is
// worse than an extra one. The weekly night, because the older version runs
// the weekly schedule.
export function planPauseAlarmOverrides(input: {
  settings: Settings;
  schedules: Schedules;
  now: Date;
}): Array<{ side: Side; expiresAt: string }> {
  const { settings, schedules, now } = input;
  const timeZone = settings.timeZone || 'UTC';
  return SCHEDULE_SIDES.flatMap(side => {
    if (!isSchedulePaused(settings, side, now)) return [];
    const { expiresAt } = settings[side].scheduleOverrides.alarm;
    if (expiresAt !== '' && moment(expiresAt).isAfter(now)) return [];
    const night = resolveLegacySleeps({ schedules, side, timeZone, from: now, to: new Date(now.getTime() + DAY_MS) })
      .find(sleep => {
        const last = Math.max(...sleep.events.filter(event => event.kind === 'alarm').map(event => event.at.getTime()));
        return last > now.getTime() && isAlarmPaused(settings, side, new Date(last));
      });
    return night ? [{ side, expiresAt: moment.tz(night.end, timeZone).format() }] : [];
  });
}

function applyAlarmOverrides(draft: Settings, plans: HandoffPlan[]): void {
  for (const plan of plans) {
    if (!plan.alarmOverrideExpiresAt) continue;
    draft[plan.side].scheduleOverrides.alarm = { disabled: true, timeOverride: '', expiresAt: plan.alarmOverrideExpiresAt };
  }
}

// The rhythm power-on told the firmware to stop at the rhythm's end, so a
// weekly night that takes over gets its own end instead. These run inside a
// request, so they fail fast when the Pod is unreachable; returns the sides
// whose write failed.
async function applyHandoff(plans: HandoffPlan[], now: Date): Promise<Set<Side>> {
  const failed = new Set<Side>();
  for (const plan of plans) {
    try {
      if (plan.action === 'powered-off') {
        await settingsDB.read();
        const targets = settingsDB.data.left.awayMode || settingsDB.data.right.awayMode ? SCHEDULE_SIDES : [plan.side];
        for (const side of targets) noteManualPowerChange(side);
        await updateDeviceStatus({ [plan.side]: { isOn: false } });
      }
      if (plan.action === 'legacy-takes-over' && plan.until) {
        await updateDeviceStatus({ [plan.side]: { secondsRemaining: firmwareSeconds(plan.until, now) } });
        // Rhythms sends its end again if it takes back over: turned back on, or
        // still running once the hold before a stop has ended.
        forgetArmedEnds(plan.side);
      }
      if (plan.action === 'kept-on-until' && plan.rearm && plan.until) {
        await updateDeviceStatus({ [plan.side]: { secondsRemaining: firmwareSeconds(plan.until, now) } });
        forgetArmedEnds(plan.side);
      }
    } catch (error: unknown) {
      failed.add(plan.side);
      logger.error(`Rhythms handoff could not update the ${plan.side} side: ${errorMessage(error)}`);
    }
  }
  return failed;
}

export function toReport(plans: HandoffPlan[], failed: ReadonlySet<Side> = new Set()): HandoffReport {
  return {
    sides: plans.map(plan => ({
      side: plan.side,
      action: plan.action,
      ...(plan.until ? { until: plan.until.toISOString() } : {}),
      alarmOverrideSet: plan.alarmOverrideExpiresAt !== undefined,
      ...(failed.has(plan.side) ? { deviceUpdateFailed: true as const } : {}),
    })),
  };
}

function noHandoff(): HandoffPlan[] {
  return SCHEDULE_SIDES.map(side => ({ side, action: 'none' }));
}

async function readOnStates(): Promise<(side: Side) => boolean> {
  // A request must not wait for a reconnect, which getDeviceStatusCoalesced would.
  if (!isFrankenConnected()) {
    logger.warn('Rhythms handoff could not read the Pod, treating both sides as on: not connected');
    return () => true;
  }
  try {
    const status = await getDeviceStatusCoalesced();
    return side => status[side].isOn;
  } catch (error: unknown) {
    logger.warn(`Rhythms handoff could not read the Pod, treating both sides as on: ${errorMessage(error)}`);
    return () => true;
  }
}

async function planNow(powerOffNow: boolean, now: Date): Promise<HandoffPlan[]> {
  const engine = engineActivation();
  if (!engine.active) return noHandoff();
  await settingsDB.read();
  await schedulesDB.read();
  return planHandoff({
    settings: settingsDB.data,
    schedules: schedulesDB.data,
    db: engine.db,
    now,
    powerOffNow,
    isOn: await readOnStates(),
    alarmRang: hasAlarmOccurrence,
    powerOffFor: smartPowerOffFor,
  });
}

export async function prepareToLeaveRhythms(reason: LeaveReason): Promise<HandoffReport> {
  const now = new Date();
  // Before any write: the override write below starts a rebuild.
  holdForHandBack(now);
  const plans = await planNow(false, now);
  await settingsDB.read();
  await schedulesDB.read();
  for (const { side, expiresAt } of planPauseAlarmOverrides({ settings: settingsDB.data, schedules: schedulesDB.data, now })) {
    const plan = plans.find(item => item.side === side);
    if (plan && !plan.alarmOverrideExpiresAt) plan.alarmOverrideExpiresAt = expiresAt;
  }
  if (plans.some(plan => plan.alarmOverrideExpiresAt)) {
    await updateSettings(draft => { applyAlarmOverrides(draft, plans); });
  }
  const report = toReport(plans, await applyHandoff(plans, now));
  logger.info(`Rhythms handoff before ${reason}: ${JSON.stringify(report)}`);
  return report;
}

export async function disableRhythms(options: { powerOffNow: boolean }, rebuild: () => Promise<void>): Promise<HandoffReport> {
  const now = new Date();
  const plans = await planNow(options.powerOffNow, now);
  const hasOverrides = plans.some(plan => plan.alarmOverrideExpiresAt);
  await updateSettings(draft => {
    if (!draft.features.rhythms && !hasOverrides) return false;
    draft.features.rhythms = false;
    applyAlarmOverrides(draft, plans);
  });
  // The rhythm jobs end with the rebuild, so a sleep left running keeps its
  // alarms through memory; the rebuild schedules them.
  const timeZone = settingsDB.data.timeZone || 'UTC';
  for (const plan of plans) {
    if (plan.keptSleep) keepSleepAlarms(plan.side, plan.keptSleep, now, timeZone);
  }
  await rebuild();
  const report = toReport(plans, await applyHandoff(plans, now));
  logger.info(`Rhythms turned off: ${JSON.stringify(report)}`);
  return report;
}
