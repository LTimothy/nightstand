import type { Side } from '../db/schedulesSchema.js';
import eventBus from '../events/eventBus.js';

export const MAX_RECORD_AGE_SECONDS = 30;
const KEEP_SECONDS = 60;
let sent = new Map<string, number>();

// Pushes a RAW buttonEvent record once, so a replayed or late record fires nothing.
export function emitButtonRecord(
  record: { side: Side | null; control?: 'top' | 'bottom' | 'middle'; count: number; timestamp: number },
  nowSeconds: number,
): boolean {
  sent = new Map([...sent].filter(([, seen]) => nowSeconds - seen <= KEEP_SECONDS));
  if (!record.side || !record.control || nowSeconds - record.timestamp > MAX_RECORD_AGE_SECONDS) return false;
  const key = `${record.side}:${record.control}:${record.timestamp}`;
  if (sent.has(key)) return false;
  sent.set(key, nowSeconds);
  eventBus.emit('button', { side: record.side, button: record.control, clicks: record.count, source: 'record' });
  return true;
}

export function resetButtonRecordEvents() {
  sent = new Map();
}
