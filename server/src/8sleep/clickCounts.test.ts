import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';
import { claimClicks, markPending, noteButtonTap, onLateClicks, resetClickCounts } from './clickCounts.js';

const T = 1793122973;
const tap = (timestamp: number, count = 3, control: 'top' | 'bottom' | 'middle' = 'top', side: 'left' | 'right' | null = 'right') =>
  ({ side, control, count, timestamp });

beforeEach(resetClickCounts);

it('claims the count of a record that arrived first', () => {
  noteButtonTap(tap(T), T);
  assert.equal(claimClicks('right', 'tripleTap', T, T), 3);
  assert.equal(claimClicks('right', 'tripleTap', T, T), undefined);
});

it('matches a record one second off', () => {
  noteButtonTap(tap(T), T);
  assert.equal(claimClicks('right', 'tripleTap', T + 1, T + 1), 3);
});

it('ignores middle, null side and other sides', () => {
  noteButtonTap(tap(T, 3, 'middle'), T);
  noteButtonTap(tap(T, 3, 'top', null), T);
  noteButtonTap(tap(T, 3, 'top', 'left'), T);
  assert.equal(claimClicks('right', 'tripleTap', T, T), undefined);
  assert.equal(claimClicks('right', 'doubleTap', T, T), undefined);
});

it('fires late clicks once for a pending tap', () => {
  const calls: unknown[][] = [];
  const off = onLateClicks((...args) => calls.push(args));
  markPending('right', 'doubleTap', T, T);
  noteButtonTap(tap(T, 3, 'bottom'), T);
  noteButtonTap(tap(T, 3, 'bottom'), T);
  assert.deepEqual(calls, [['right', 'doubleTap', 2]]);
  off();
});

it('does not fire for a count of one or a stale pending tap', () => {
  const calls: unknown[][] = [];
  onLateClicks((...args) => calls.push(args));
  markPending('right', 'doubleTap', T, T);
  noteButtonTap(tap(T, 1, 'bottom'), T);
  resetClickCounts();
  markPending('right', 'doubleTap', T, T);
  noteButtonTap(tap(T + 11, 3, 'bottom'), T + 11);
  assert.deepEqual(calls, []);
});

it('a record with no tap never fires', () => {
  const calls: unknown[][] = [];
  onLateClicks((...args) => calls.push(args));
  noteButtonTap(tap(T, 3, 'bottom'), T);
  assert.deepEqual(calls, []);
});

it('keeps adjacent press groups apart', () => {
  noteButtonTap(tap(T, 3), T);
  noteButtonTap(tap(T + 1, 2), T + 1);
  assert.equal(claimClicks('right', 'tripleTap', T + 1, T + 1), 2);
  assert.equal(claimClicks('right', 'tripleTap', T, T + 1), 3);
});

it('ignores a record posted again after it was claimed', () => {
  noteButtonTap(tap(T, 3), T);
  assert.equal(claimClicks('right', 'tripleTap', T, T), 3);
  noteButtonTap(tap(T, 3), T);
  assert.equal(claimClicks('right', 'tripleTap', T + 1, T + 1), undefined);
});
