// A Pod 5 hub's middle button double press: another target for a few minutes, then back.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { DeepPartial } from 'ts-essentials';

import config from '../config.js';
import logger from '../logger.js';
import type { Side } from '../db/schedulesSchema.js';
import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { connectFrankenWithin } from './frankenServer.js';
import { wasSentSince } from './sentTargets.js';

type Boost = { boostF: number; previousF: number; endsAt: number; sentAt: number };

// Firmware batching can delay log records by 15 to 25 s.
const MAX_PRESS_AGE_MS = 30_000;
const MAX_RESTORE_AGE_MS = 12 * 60 * 60_000;
const SIDES = ['left', 'right'] as const;

const boosts: Partial<Record<Side, Boost>> = {};
const timers: Partial<Record<Side, ReturnType<typeof setTimeout>>> = {};
// Beside the lowdb folder, so the job watcher never sees it, and kept across a restart.
const boostPath = () => `${config.dbFolder}boost.json`;

let saving = Promise.resolve();
// One write at a time, so both sides never share the temp file; a failed write never blocks a restore.
function save(): Promise<void> {
  const file = boostPath();
  saving = saving
    .then(() => writeFile(`${file}.tmp`, JSON.stringify(boosts)))
    .then(() => rename(`${file}.tmp`, file))
    .catch((error: unknown) => {
      logger.warn(`[boost] could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    });
  return saving;
}

async function readSide(side: Side) {
  return (await (await connectFrankenWithin()).getDeviceStatus())[side];
}

// Restores the earlier target only if the bed is still exactly where the boost put it. A side turned off
// meanwhile is restored too, so its next power-on does not start at the boost level; a level write never turns
// a side on.
// A failure leaves the boost in place for the timer to try again.
export async function endBoost(side: Side): Promise<void> {
  const boost = boosts[side];
  if (!boost) return;
  clearTimeout(timers[side]);
  const status = await readSide(side);
  // A second press during the read replaced this boost.
  if (boosts[side] !== boost) return;
  if (!status || status.targetTemperatureF !== boost.boostF || wasSentSince(side, boost.boostF, boost.sentAt + 1)) {
    logger.info(`[boost] ${side} boost ended, target left as it is`);
  } else {
    logger.info(`[boost] ${side} boost ended, back to ${boost.previousF} F`);
    await updateDeviceStatus({ [side]: { targetTemperatureF: boost.previousF } } as DeepPartial<DeviceStatus>, { background: true });
  }
  if (boosts[side] === boost) {
    delete boosts[side];
    await save();
  }
}

const warnedEnds = new WeakSet<object>();

function endAt(side: Side, at: number): void {
  clearTimeout(timers[side]);
  timers[side] = setTimeout(() => {
    const boost = boosts[side];
    endBoost(side).catch((error: unknown) => {
      // One warning per boost keeps a long outage from writing a line every 30 s.
      const message = `[boost] ${side} end failed: ${error instanceof Error ? error.message : String(error)}`;
      if (boost && !warnedEnds.has(boost)) logger.warn(message);
      else logger.debug(message);
      if (boost) warnedEnds.add(boost);
      // The Pod did not answer: try again unless a newer boost replaced this one.
      if (boost && boosts[side] === boost && Date.now() - boost.endsAt < MAX_RESTORE_AGE_MS) endAt(side, Date.now() + 30_000);
    });
  }, Math.max(0, at - Date.now()));
  timers[side].unref?.();
}

// True when the boost target was written. A boost never turns a side on.
export async function startBoost(side: Side, boostF: number, minutes: number, pressAt: number): Promise<boolean> {
  const status = await readSide(side);
  if (!status?.isOn) {
    logger.info(`[boost] ${side} side is off, no boost`);
    return false;
  }
  const running = boosts[side];
  // A second press while the boost holds restarts it and keeps the first return target.
  const previousF = running && status.targetTemperatureF === running.boostF ? running.previousF : status.targetTemperatureF;
  logger.info(`[boost] ${side} ${previousF} -> ${boostF} F for ${minutes} min`);
  // Not a manual change: that would start a schedule hold for a few minutes' boost.
  await updateDeviceStatus({ [side]: { targetTemperatureF: boostF } } as DeepPartial<DeviceStatus>, { notAfter: pressAt + MAX_PRESS_AGE_MS });
  const sentAt = Date.now();
  boosts[side] = { boostF, previousF, endsAt: sentAt + minutes * 60_000, sentAt };
  endAt(side, boosts[side].endsAt);
  await save();
  return true;
}

const isBoost = (value: unknown): value is Boost => !!value && typeof value === 'object'
  && (['boostF', 'previousF', 'endsAt', 'sentAt'] as const).every(key => Number.isFinite((value as Record<string, unknown>)[key]));

export async function restoreBoosts(): Promise<void> {
  let stored: Partial<Record<Side, unknown>>;
  try {
    stored = JSON.parse(await readFile(boostPath(), 'utf8'));
  } catch {
    return;
  }
  for (const side of SIDES) {
    const boost = stored?.[side];
    if (!isBoost(boost) || Date.now() - boost.endsAt > MAX_RESTORE_AGE_MS) continue;
    boosts[side] = boost;
    endAt(side, boost.endsAt);
  }
}
