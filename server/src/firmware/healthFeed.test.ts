import assert from 'node:assert/strict';
import { it } from 'node:test';
import { HealthFeed } from './healthFeed.js';
import type { HealthRecord } from './firmwareSchema.js';

const record = (code: HealthRecord['code'], timestamp: number, details: HealthRecord['details'] = {}): HealthRecord => ({
  kind: 'health', code, side: null, details, timestamp, receivedAt: timestamp, source: 'RAW', sequence: timestamp, index: 0,
});
const session = 'a'.repeat(32);

it('is not interrupted in the first 120 s after the stream starts', () => {
  const feed = new HealthFeed();
  feed.beginSession(session, 1000);
  feed.observe(record('moisture', 1090), session, 1090);
  assert.equal(feed.snapshot(1100).interrupted, false);
  assert.equal(feed.snapshot(1120).interrupted, true);
});

it('keeps bus 1 and bus 3 timeouts as two incidents', () => {
  const feed = new HealthFeed();
  feed.observe(record('bus-timeout', 100, { bus: 1 }), session, 100);
  feed.observe(record('bus-timeout', 101, { bus: 3 }), session, 101);
  feed.observe(record('bus-timeout', 102, { bus: 1 }), session, 102);
  const incidents = feed.snapshot(102).incidents;
  assert.equal(incidents.length, 2);
  assert.equal(incidents.find(item => item.details.bus === 1)?.count, 2);
});

it('keeps ports 1-1.2 and 1-1.3 as two incidents', () => {
  const feed = new HealthFeed();
  feed.observe(record('device-missing', 100, { port: '1-1.2' }), session, 100);
  feed.observe(record('device-missing', 101, { port: '1-1.3' }), session, 101);
  assert.equal(feed.snapshot(101).incidents.length, 2);
});

it('marks periodic reprints as diagnostic', () => {
  const feed = new HealthFeed();
  const codes = ['sensor-reset', 'presence-low', 'pump-interlock', 'water-calibration', 'pump-stopped', 'bus-timeout'] as const;
  codes.forEach((code, index) => feed.observe(record(code, 100 + index), session, 100 + index));
  assert.ok(feed.snapshot(110).incidents.every(item => item.severity === 'diagnostic'));
  feed.observe(record('moisture', 111), session, 111);
  assert.equal(feed.snapshot(111).incidents.find(item => item.code === 'moisture')?.severity, 'info');
});
