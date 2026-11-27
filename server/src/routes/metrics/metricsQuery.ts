import moment from 'moment-timezone';
import { physicalSide } from '../../db/sideSwaps.js';

export interface MetricsQuery {
  side?: 'left' | 'right';
  start?: number;
  end?: number;
}

const unixTime = (value: unknown): number | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const time = moment(value, moment.ISO_8601, true);
  return time.isValid() ? time.unix() : null;
};

// Returns null when a value would reach the database query as NaN, an array or an unknown side.
export function parseMetricsQuery(query: Record<string, unknown>): MetricsQuery | null {
  const { side, startTime, endTime } = query;
  if (side !== undefined && side !== '' && side !== 'left' && side !== 'right') return null;
  const start = unixTime(startTime);
  const end = unixTime(endTime);
  if (start === null || end === null) return null;
  return { side: side || undefined, start, end } as MetricsQuery;
}

export interface RowsQuery {
  side?: 'left' | 'right';
  start: number;
  end: number;
}

// Vitals and movement come back one row per stored minute or bucket, so a
// request without a range used to load every row ever stored. On a Pod
// with ten months of vitals that took 5 seconds and over 200 MB.
export const DEFAULT_ROWS_SECONDS = 24 * 3600;
// An hour of slack lets 7 local days across a daylight saving change through.
export const MAX_ROWS_SECONDS = 7 * 24 * 3600 + 3600;
export const ROWS_QUERY_ERROR = 'Invalid side, startTime or endTime, or a range longer than 7 days';

// A missing endTime means now and a missing startTime a day before the end.
// A reversed range is passed through and finds nothing, as before.
export function parseRowsQuery(query: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): RowsQuery | null {
  const range = parseMetricsQuery(query);
  if (!range) return null;
  const end = range.end ?? now;
  const start = range.start ?? end - DEFAULT_ROWS_SECONDS;
  if (end - start > MAX_ROWS_SECONDS) return null;
  return { side: range.side, start, end };
}

export interface NightQuery {
  side: 'left' | 'right';
  start: number;
  end: number;
}

// Stages and scores build one entry per five minutes of the range, so an
// unbounded range could exhaust the Pod's memory.
export const MAX_NIGHT_SECONDS = 48 * 3600;

export function parseNightQuery(query: Record<string, unknown>): NightQuery | null {
  const range = parseMetricsQuery(query);
  if (!range?.side || range.start === undefined || range.end === undefined) return null;
  if (range.end <= range.start || range.end - range.start > MAX_NIGHT_SECONDS) return null;
  // A night is read from the side it was recorded on.
  return { side: physicalSide(range.side, range.start), start: range.start, end: range.end };
}
