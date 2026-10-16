// One JSON line per finished Smart Schedule sleep, kept next to the lowdb
// folder (never inside it, so the job watcher ignores it).
import { readFile, rename, writeFile } from 'node:fs/promises';
import config from '../../config.js';
import logger from '../../logger.js';
import type { SleepSummary } from './curveController.js';

export const HISTORY_FILE_NAME = 'rhythms-history.jsonl';
export const HISTORY_RETENTION_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export const historyPath = (): string => `${config.dbFolder}${HISTORY_FILE_NAME}`;

export type SleepHistoryRecord = SleepSummary & {
  onsetEstimate: string | null;
  onsetNote: string;
};

function isRecent(line: string, cutoff: number): boolean {
  try {
    const parsed = JSON.parse(line) as { powerOff?: unknown };
    const at = typeof parsed.powerOff === 'string' ? Date.parse(parsed.powerOff) : Number.NaN;
    return Number.isFinite(at) && at >= cutoff;
  } catch {
    return false;
  }
}

// Rewrites the file with the lines `keep` accepts plus `add`, through a
// temporary file. Throws; callers decide how to report a failure.
export async function appendPruned(file: string, keep: (line: string) => boolean, add: string[]): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = existing.split('\n').filter(line => line.trim() !== '' && keep(line));
  lines.push(...add);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8');
  await rename(temporary, file);
}

// Appends one record and drops records whose sleep ended more than 90 days
// ago. Never throws: history must not affect the engine.
export async function appendHistory(
  record: SleepHistoryRecord,
  options: { path?: string; now?: Date } = {},
): Promise<void> {
  try {
    const cutoff = (options.now ?? new Date()).getTime() - HISTORY_RETENTION_DAYS * DAY;
    await appendPruned(options.path ?? historyPath(), line => isRecent(line, cutoff), [JSON.stringify(record)]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`smart schedule: history not written: ${message}`);
  }
}
