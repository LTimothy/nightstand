// Notes for suggestions from hand changes: one JSON line per hand change
// during a Rhythms sleep and per Rhythms power-on. Kept next to the lowdb
// folder, never inside it, so the job watcher ignores it.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, rm } from 'node:fs/promises';
import config from '../../config.js';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import type { DailySchedule, Side } from '../../db/schedulesSchema.js';
import type { Rhythm } from '../../db/rhythmsSchema.js';
import type { Settings } from '../../db/settingsSchema.js';
import { levelAt, levelToF, phaseAt, type CurvePoint } from '../../db/smartCurve.js';
import { NOTE_DAYS } from '../../db/suggestionRules.js';
import { MAX_TEMPERATURE_F, MIN_TEMPERATURE_F } from '../../routes/deviceStatus/deviceStatusSchema.js';
import { isSchedulePaused } from '../schedulePause.js';
import { isTempScheduleOverridden } from '../scheduleOverride.js';
import { currentSleep, drivingSide, engineActivation, scheduledTemperatureNow } from '../scheduleQueries.js';
import { smartCurveStatus, smartTemperatureGate } from './curveController.js';
import { appendPruned } from './history.js';
import { canonicalJson } from './night.js';
import { parseLine, type ChangeLine, type DismissLine, type ExcludeLine, type Line, type NightLine, type RestoreLine } from './learn.js';
import type { ResolvedSleep } from './resolve.js';

export const CHANGES_FILE_NAME = 'rhythms-changes.jsonl';
export const changesPath = (): string => `${config.dbFolder}${CHANGES_FILE_NAME}`;
const DAY = 24 * 60 * 60 * 1000;

// Any edit to the bedtime, the on temperature, a step or the Smart base gives a new key, and the evidence restarts.
export function planKeyOf(night: DailySchedule, mode: 'manual' | 'smart', baseLevel: number): string {
  const plan = { on: night.power.on, onF: night.power.onTemperature, t: night.temperatures, base: mode === 'smart' ? baseLevel : null };
  return createHash('sha256').update(canonicalJson(plan)).digest('hex').slice(0, 12);
}

export const rhythmPlanKey = (rhythm: Rhythm): string => planKeyOf(rhythm.night, rhythm.temperatureMode, rhythm.smart.baseLevel);

export const noteId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const warn = (error: unknown) => logger.warn(`suggestions: notes not written: ${messageOf(error)}`);

// Every write and the delete go through one queue, so they never interleave.
let chain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

export const flushHandChanges = (): Promise<void> => chain;

const appendLines = (lines: object[]) =>
  appendFile(changesPath(), lines.map(line => `${JSON.stringify(line)}\n`).join(''), 'utf8');

export function appendNoteLines(lines: Array<DismissLine | RestoreLine | ExcludeLine>): Promise<void> {
  return enqueue(() => appendLines(lines));
}

export function forgetHandChanges(): Promise<void> {
  return enqueue(async () => {
    await rm(changesPath(), { force: true });
    await rm(`${changesPath()}.tmp`, { force: true });
  });
}

export async function readChanges(): Promise<Line[]> {
  let text = '';
  try {
    text = await readFile(changesPath(), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return text.split('\n').flatMap(line => {
    const parsed = line.trim() ? parseLine(line) : null;
    return parsed ? [parsed] : [];
  });
}

// A line this version cannot read may belong to a later release, so only non-JSON is dropped.
function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

// A refusal must not quietly expire, so dismissals stay while their rhythm exists.
function keepFor(now: Date): (text: string) => boolean {
  const cutoff = now.getTime() - NOTE_DAYS * DAY;
  const engine = engineActivation();
  return text => {
    const line = parseLine(text);
    if (!line) return isJsonObject(text);
    if (line.kind === 'dismiss' || line.kind === 'restore') {
      return !engine.active || Object.hasOwn(engine.db[line.side].rhythms, line.rhythmId);
    }
    return Date.parse(line.at) >= cutoff;
  };
}

export function recordNight(side: Side, sleep: ResolvedSleep, now: Date = new Date()): void {
  try {
    if (settingsDB.data.features?.rhythmSuggestions !== true || !sleep.rhythmId) return;
    const line: NightLine = {
      v: 1, kind: 'night', at: now.toISOString(), side, rhythmId: sleep.rhythmId, mode: sleep.mode,
      planKey: planKeyOf(sleep.night, sleep.mode, sleep.smart?.baseLevel ?? 0), date: sleep.date,
      sleepStart: sleep.start.toISOString(), sleepEnd: sleep.end.toISOString(),
    };
    void enqueue(() => appendPruned(changesPath(), keepFor(now), [JSON.stringify(line)])).catch(warn);
  } catch (error: unknown) {
    warn(error);
  }
}

export type HandChange = {
  targetF: number; // the value written, before rounding
  fromF: number | null; // the bed's target just before; null when unknown
  on: boolean | null; // the side's on state as far as the caller knows
  setsOn: boolean; // the same request turned the side on
  source: 'api' | 'tap';
};

// The level a Smart vote is measured against: the first hold point, else the last cool-down point.
function nightLevelF(points: CurvePoint[], baseLevel: number): number {
  const level = points.find(point => point.phase === 'hold') ?? points.filter(point => point.phase === 'cooldown').at(-1);
  return levelToF(level?.level ?? baseLevel);
}

function changeLine(settings: Settings, side: Side, change: HandChange, now: Date): ChangeLine | null {
  if (settings.features?.rhythmSuggestions !== true || !settings.timeZone) return null;
  const driver = drivingSide(settings, side);
  if (!driver || isSchedulePaused(settings, driver, now) || !engineActivation().active) return null;
  const sleep = currentSleep(driver, now);
  if (!sleep?.rhythmId || change.on === false) return null;
  const targetF = Math.round(Math.min(MAX_TEMPERATURE_F, Math.max(MIN_TEMPERATURE_F, change.targetF)));
  const baseLevel = sleep.smart?.baseLevel ?? 0;
  const curve = sleep.mode === 'smart' && sleep.smartCurve ? sleep.smartCurve.points : null;
  const curveF = curve ? levelToF(levelAt(curve, now) ?? baseLevel) : null;
  const plannedF = curve === null ? scheduledTemperatureNow(driver, now)
    : smartTemperatureGate(driver, sleep.date, now) === 'base' ? levelToF(baseLevel) : curveF;
  if (plannedF === null) return null;
  // The app's power button sends the schedule's own temperature with the power-on.
  if (change.setsOn && (targetF === plannedF || targetF === curveF)) return null;
  const holdUntil = curve ? smartCurveStatus(driver, now)?.holdUntil ?? null : null;
  return {
    v: 1, kind: 'change', at: now.toISOString(), side: driver, rhythmId: sleep.rhythmId, mode: sleep.mode,
    planKey: planKeyOf(sleep.night, sleep.mode, baseLevel), date: sleep.date,
    sleepStart: sleep.start.toISOString(), sleepEnd: sleep.end.toISOString(),
    offsetMin: Math.max(0, Math.floor((now.getTime() - sleep.start.getTime()) / 60_000)),
    plannedF,
    holdF: curve ? nightLevelF(curve, baseLevel) : null,
    fromF: change.fromF === null ? null : Math.round(change.fromF),
    targetF,
    phase: curve ? phaseAt(curve, now) : null,
    held: curve ? holdUntil !== null && holdUntil.getTime() > now.getTime() : isTempScheduleOverridden(driver),
    source: change.source,
  };
}

// Builds the line now and writes it later, so the device write never waits on the file.
export function recordHandChange(side: Side, change: HandChange, now: Date = new Date()): void {
  try {
    const line = changeLine(settingsDB.data, side, change, now);
    if (line) void enqueue(() => appendLines([line])).catch(warn);
  } catch (error: unknown) {
    warn(error);
  }
}
