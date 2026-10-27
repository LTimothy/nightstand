import type { Side } from '../db/schedulesSchema.js';
import type { Gesture } from '../db/settingsSchema.js';

const MAX_AGE_SECONDS = 10;
const MATCH_WINDOW_SECONDS = 1;
const GESTURE_BY_CONTROL = { top: 'tripleTap', bottom: 'doubleTap' } as const;

type Entry = { side: Side; gesture: Gesture; timestamp: number; seen: number; count?: number };
let records: Entry[] = [];
let pending: Entry[] = [];
let done = new Map<string, number>();
const listeners = new Set<(side: Side, gesture: Gesture, extra: number) => void>();

const keyOf = (side: Side, gesture: Gesture, timestamp: number) => `${side}:${gesture}:${timestamp}`;
const prune = (now: number) => {
  records = records.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
  pending = pending.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
  done = new Map([...done].filter(([, seen]) => now - seen <= MAX_AGE_SECONDS));
};
// Exact timestamp first, otherwise the closest entry within the match window.
const find = (list: Entry[], side: Side, gesture: Gesture, timestamp: number) => {
  let best = -1;
  list.forEach((entry, index) => {
    if (entry.side !== side || entry.gesture !== gesture) return;
    const gap = Math.abs(entry.timestamp - timestamp);
    if (gap > MATCH_WINDOW_SECONDS) return;
    if (best < 0 || gap < Math.abs(list[best].timestamp - timestamp)) best = index;
  });
  return best;
};

export function noteButtonTap(
  record: { side: Side | null; control?: 'top' | 'bottom' | 'middle'; count: number; timestamp: number },
  nowSeconds: number,
) {
  prune(nowSeconds);
  const gesture = record.control && record.control !== 'middle' ? GESTURE_BY_CONTROL[record.control] : undefined;
  if (!record.side || !gesture) return;
  const key = keyOf(record.side, gesture, record.timestamp);
  if (done.has(key) || records.some(entry => keyOf(entry.side, entry.gesture, entry.timestamp) === key)) return;
  const waiting = find(pending, record.side, gesture, record.timestamp);
  if (waiting >= 0) {
    pending.splice(waiting, 1);
    done.set(key, nowSeconds);
    if (record.count > 1) listeners.forEach(listener => listener(record.side as Side, gesture, record.count - 1));
    return;
  }
  records.push({ side: record.side, gesture, timestamp: record.timestamp, seen: nowSeconds, count: record.count });
}

// Returns the firmware's count for this tap and removes it, or undefined if no record arrived yet.
export function claimClicks(side: Side, gesture: Gesture, tapTimestamp: number, nowSeconds: number) {
  prune(nowSeconds);
  const index = find(records, side, gesture, tapTimestamp);
  if (index < 0) return undefined;
  const [claimed] = records.splice(index, 1);
  done.set(keyOf(side, gesture, claimed.timestamp), nowSeconds);
  return claimed.count;
}

// A tap stepped once without a count; a record arriving soon fires the listeners with count - 1.
export function markPending(side: Side, gesture: Gesture, tapTimestamp: number, nowSeconds: number) {
  prune(nowSeconds);
  pending.push({ side, gesture, timestamp: tapTimestamp, seen: nowSeconds });
}

export function onLateClicks(listener: (side: Side, gesture: Gesture, extra: number) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetClickCounts() {
  records = [];
  pending = [];
  done = new Map();
}
