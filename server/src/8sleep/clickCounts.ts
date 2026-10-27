import type { Side } from '../db/schedulesSchema.js';
import type { Gesture } from '../db/settingsSchema.js';

const MAX_AGE_SECONDS = 10;
const MATCH_WINDOW_SECONDS = 1;
const GESTURE_BY_CONTROL = { top: 'tripleTap', bottom: 'doubleTap' } as const;

type Entry = { side: Side; gesture: Gesture; timestamp: number; seen: number; count?: number };
let records: Entry[] = [];
let pending: Entry[] = [];
const listeners = new Set<(side: Side, gesture: Gesture, extra: number) => void>();

const prune = (now: number) => {
  records = records.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
  pending = pending.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
};
const find = (list: Entry[], side: Side, gesture: Gesture, timestamp: number) => list.findIndex(entry =>
  entry.side === side && entry.gesture === gesture && Math.abs(entry.timestamp - timestamp) <= MATCH_WINDOW_SECONDS);

export function noteButtonTap(
  record: { side: Side | null; control?: 'top' | 'bottom' | 'middle'; count: number; timestamp: number },
  nowSeconds: number,
) {
  prune(nowSeconds);
  const gesture = record.control && record.control !== 'middle' ? GESTURE_BY_CONTROL[record.control] : undefined;
  if (!record.side || !gesture) return;
  const waiting = find(pending, record.side, gesture, record.timestamp);
  if (waiting >= 0) {
    pending.splice(waiting, 1);
    if (record.count > 1) listeners.forEach(listener => listener(record.side as Side, gesture, record.count - 1));
    return;
  }
  if (find(records, record.side, gesture, record.timestamp) < 0) {
    records.push({ side: record.side, gesture, timestamp: record.timestamp, seen: nowSeconds, count: record.count });
  }
}

// Returns the firmware's count for this tap and removes it, or undefined if no record arrived yet.
export function claimClicks(side: Side, gesture: Gesture, tapTimestamp: number, nowSeconds: number) {
  prune(nowSeconds);
  const index = find(records, side, gesture, tapTimestamp);
  if (index < 0) return undefined;
  return records.splice(index, 1)[0].count;
}

// A tap stepped once without a count; a record arriving soon fires the listeners with count - 1.
export function markPending(side: Side, gesture: Gesture, tapTimestamp: number, nowSeconds: number) {
  prune(nowSeconds);
  if (find(records, side, gesture, tapTimestamp) >= 0) return;
  pending.push({ side, gesture, timestamp: tapTimestamp, seen: nowSeconds });
}

export function onLateClicks(listener: (side: Side, gesture: Gesture, extra: number) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetClickCounts() {
  records = [];
  pending = [];
}
