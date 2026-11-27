// When the two sides last swapped people, as epoch seconds. Sleep history
// stays on the side that recorded it; this log lets a request for "the person
// on this side" read their earlier nights from the other side.
import { readFileSync } from 'node:fs';
import logger from '../logger.js';
import type { Side } from './schedulesSchema.js';

export const SIDE_SWAPS_FILE = 'side-swaps.json';
// config.dbFolder, read here so the metrics helpers load without config.
export const sideSwapsPath = (): string => `${process.env.DATA_FOLDER}${SIDE_SWAPS_FILE}`;

export function loadSideSwaps(path = sideSwapsPath()): number[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every(value => Number.isInteger(value))) return [...parsed as number[]].sort((a, b) => a - b);
  } catch {
    // Reported below.
  }
  logger.warn(`Ignoring ${path}: not a list of swap times`);
  return [];
}

let cached: number[] | undefined;

export const sideSwaps = (): number[] => (cached ??= loadSideSwaps());
export function setSideSwaps(swaps: number[]): void {
  cached = [...swaps].sort((a, b) => a - b);
}

const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');

// A time equal to a swap counts as after it.
export function physicalSide(side: Side, at: number, swaps = sideSwaps()): Side {
  return swaps.filter(swap => swap > at).length % 2 === 0 ? side : other(side);
}

// A Prisma filter for the rows of the person now on this side, by the given time column.
export function personWhere(side: Side | undefined, column: string, swaps = sideSwaps()): Record<string, unknown> {
  if (!side) return {};
  if (swaps.length === 0) return { side };
  const bounds = [undefined, ...swaps, undefined];
  return { OR: bounds.slice(1).map((to, index) => {
    const from = bounds[index];
    const range = { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lt: to }) };
    return { side: (swaps.length - index) % 2 === 0 ? side : other(side), [column]: range };
  }) };
}
