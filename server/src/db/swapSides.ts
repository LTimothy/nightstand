// Moves each person's settings, schedules, rhythms and suggestion notes to the
// other side. Calibration and sleep history stay with the side that recorded them.
import { readFile, rm } from 'node:fs/promises';
import config from '../config.js';
import settingsDB, { updateSettings } from './settings.js';
import schedulesDB, { updateSchedules } from './schedules.js';
import { parseRhythms, RhythmsStateError, updateRhythms } from './rhythms.js';
import type { RhythmsDB } from './rhythmsSchema.js';
import type { Schedules } from './schedulesSchema.js';
import type { Settings } from './settingsSchema.js';
import { legacyFingerprint } from '../jobs/rhythms/fingerprint.js';
import { changesPath, flushHandChanges, replaceChangesText } from '../jobs/rhythms/handChanges.js';
import { writeTextDurably } from './durableFile.js';
import { journalPath, writeSwapFiles, type SwapJournal } from './sideSwapReplay.js';
import logger from '../logger.js';
import { setSideSwaps, sideSwaps, sideSwapsPath } from './sideSwaps.js';

export type SwapFiles = { settings: Settings; schedules: Schedules; rhythms: string | null; notes: string | null; swaps: number[] };

const flipNote = (line: string) => {
  try {
    const note = JSON.parse(line) as { side?: unknown };
    if (note.side !== 'left' && note.side !== 'right') return line;
    return JSON.stringify({ ...note, side: note.side === 'left' ? 'right' : 'left' });
  } catch {
    return line;
  }
};

export function swapped(files: SwapFiles, now: number): SwapFiles {
  const { left, right } = files.settings;
  // A default name names the side, not the person.
  const settings = {
    ...files.settings,
    left: { ...right, name: right.name === 'Right' ? 'Left' : right.name },
    right: { ...left, name: left.name === 'Left' ? 'Right' : left.name },
  };
  const schedules = { ...files.schedules, left: files.schedules.right, right: files.schedules.left };
  let rhythms: string | null = null;
  if (files.rhythms !== null) {
    const load = parseRhythms(files.rhythms);
    if (load.state !== 'ok') throw new RhythmsStateError(load.state);
    // The stored JSON, so keys this version does not know survive.
    const raw = JSON.parse(files.rhythms) as RhythmsDB;
    const matched = raw.legacyFingerprint === legacyFingerprint(files.schedules);
    rhythms = JSON.stringify({
      ...raw, left: raw.right, right: raw.left,
      legacyFingerprint: matched ? legacyFingerprint(schedules) : raw.legacyFingerprint,
    }, null, 2);
  }
  const notes = files.notes === null ? null : files.notes.split('\n').map(flipNote).join('\n');
  return { settings, schedules, rhythms, notes, swaps: [...files.swaps, now] };
}

const readText = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

// shortcut: a setting saved between the read and the apply is overwritten; the bed is idle during a swap, so revisit if it shows up.
async function applyLive(next: SwapFiles): Promise<void> {
  await updateSettings(draft => { draft.left = next.settings.left; draft.right = next.settings.right; });
  await updateSchedules(draft => { draft.left = next.schedules.left; draft.right = next.schedules.right; });
  if (next.rhythms !== null) {
    const rhythms = JSON.parse(next.rhythms) as RhythmsDB;
    await updateRhythms(draft => {
      draft.left = rhythms.left;
      draft.right = rhythms.right;
      draft.legacyFingerprint = rhythms.legacyFingerprint;
    });
  }
  await replaceChangesText(next.notes);
  await writeTextDurably(sideSwapsPath(), JSON.stringify(next.swaps));
}

export async function swapSides(now = Math.floor(Date.now() / 1000), apply = applyLive): Promise<void> {
  await settingsDB.read();
  await schedulesDB.read();
  await flushHandChanges();
  const next = swapped({
    settings: settingsDB.data,
    schedules: schedulesDB.data,
    rhythms: await readText(`${config.lowDbFolder}rhythmsDB.json`),
    notes: await readText(changesPath()),
    swaps: sideSwaps(),
  }, now);
  const journal: SwapJournal = next;
  await writeTextDurably(journalPath(), JSON.stringify(journal));
  try {
    await apply(next);
  } catch (error) {
    // Half applied: finish from the journal now, or at the next start if this fails too.
    logger.error(`Side swap step failed, finishing from the journal: ${error instanceof Error ? error.message : String(error)}`);
    await writeSwapFiles(journal);
    await settingsDB.read();
    await schedulesDB.read();
  }
  setSideSwaps(next.swaps);
  await rm(journalPath(), { force: true });
}
