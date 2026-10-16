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
import { NOTE_DAYS } from '../../db/suggestionRules.js';
import { engineActivation } from '../scheduleQueries.js';
import { appendPruned } from './history.js';
import { canonicalJson } from './night.js';
import { parseLine, type DismissLine, type ExcludeLine, type Line, type NightLine, type RestoreLine } from './learn.js';
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
