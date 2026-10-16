import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FirmwareTelemetry } from './firmwareTelemetry.js';
import { FirmwareBatchSchema } from './firmwareSchema.js';

const features = { firmwareTargetReadout: true, firmwareHealth: false, tapDiagnostics: false, coolingWarning: false };
const sample = (timestamp = 100) => ({ kind: 'thermostat' as const, side: 'left' as const, targetC: 25.08,
  valid: true, enabled: true, power: -0.1, timestamp, receivedAt: timestamp, source: 'RAW' as const, sequence: 1, index: 0 });
it('reads the independent firmware target, marks stale, disabled and invalid readings', () => {
  const store = new FirmwareTelemetry();
  assert.equal(store.snapshot(features, true, 100).targets.left.state, 'unavailable');
  store.ingest({ session: 'a'.repeat(32), records: [sample()] }, features, 100);
  assert.equal(store.snapshot(features, true, 160).targets.left.state, 'available');
  assert.equal(store.snapshot(features, true, 161).targets.left.state, 'stale');
  store.ingest({ session: 'a'.repeat(32), records: [{ ...sample(162), enabled: false, sequence: 2 }] }, features, 162);
  assert.equal(store.snapshot(features, true, 162).targets.left.state, 'disabled');
  store.ingest({ session: 'a'.repeat(32), records: [{ ...sample(163), valid: false, sequence: 3 }] }, features, 163);
  assert.equal(store.snapshot(features, true, 163).targets.left.state, 'unavailable');
  assert.equal(store.snapshot(features, false, 163).availability, 'Monitoring unavailable');
});
it('rejects unbounded, non-finite, unknown and arbitrary text data', () => {
  for (const record of [{ ...sample(), targetC: NaN }, { ...sample(), valid: 1 }, { ...sample(), msg: 'private text' }]) {
    assert.equal(FirmwareBatchSchema.safeParse({ session: 'a'.repeat(32), records: [record] }).success, false);
  }
  assert.equal(FirmwareBatchSchema.safeParse({ session: 'a'.repeat(32), records: Array(129).fill(sample()) }).success, false);
});

it('accepts inner indexes beyond 1023 within the bounded RAW payload', () => {
  assert.equal(FirmwareBatchSchema.safeParse({ session: 'a'.repeat(32), records: [{ ...sample(), index: 1024 }] }).success, true);
  assert.equal(FirmwareBatchSchema.safeParse({ session: 'a'.repeat(32), records: [{ ...sample(), index: 1048576 }] }).success, false);
});
it('ignores replay, old and future thermal data and keeps the toggle off empty', () => {
  const store = new FirmwareTelemetry();
  store.ingest({ session: 'a'.repeat(32), records: [sample(1), sample(105)] }, features, 100);
  assert.equal(store.snapshot(features, true, 100).targets.left.state, 'unavailable');
  store.ingest({ session: 'a'.repeat(32), records: [sample()] }, features, 100);
  store.ingest({ session: 'a'.repeat(32), records: [{ ...sample(), targetC: 10 }] }, features, 100);
  assert.equal(store.snapshot(features, true, 100).targets.left.targetC, 25.08);
  assert.equal(store.snapshot({ ...features, firmwareTargetReadout: false }, true, 100).targets.left.state, 'unavailable');
});

const healthFeatures = { ...features, firmwareHealth: true };
const log = (code: string, timestamp: number, sequence: number, value?: number) => ({
  kind: 'health', code, timestamp, receivedAt: timestamp, source: 'RAW', sequence, index: 0, side: null, details: {},
  ...(value === undefined ? {} : { value }),
});
const ingestLog = (store: FirmwareTelemetry, record: ReturnType<typeof log>, session = 'a'.repeat(32)) => {
  store.ingest(FirmwareBatchSchema.parse({ session, records: [record] }), healthFeatures, record.timestamp);
};
it('baselines counters after either restart, counts increases and handles resets', () => {
  const store = new FirmwareTelemetry();
  ingestLog(store, log('samples-dropped', 100, 1, 500));
  assert.equal(store.snapshot(healthFeatures, true, 100).incidents.length, 0);
  ingestLog(store, log('samples-dropped', 101, 2, 502));
  assert.equal(store.snapshot(healthFeatures, true, 101).incidents[0].count, 2);
  ingestLog(store, log('samples-dropped', 102, 3, 0));
  ingestLog(store, log('samples-dropped', 103, 4, 1));
  assert.equal(store.snapshot(healthFeatures, true, 103).incidents[0].count, 3);
  ingestLog(store, log('samples-dropped', 104, 5, 900), 'b'.repeat(32));
  assert.equal(store.snapshot(healthFeatures, true, 104).incidents[0].count, 3);
  const restarted = new FirmwareTelemetry();
  ingestLog(restarted, log('write-failures', 105, 1, 42));
  assert.equal(restarted.snapshot(healthFeatures, true, 105).incidents.length, 0);
});
it('collapses repeats, deduplicates across sources and never calls silence recovery', () => {
  const store = new FirmwareTelemetry();
  const event = log('sensor-reset', 100, 1);
  ingestLog(store, event);
  store.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [{ ...event, source: 'NATS' }] }), healthFeatures, 100);
  ingestLog(store, log('sensor-reset', 110, 2));
  const incidents = store.snapshot(healthFeatures, true, 171).incidents;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].count, 2);
  assert.equal(incidents[0].freshness, 'No recent readings');
  assert.equal(incidents[0].recoveredAt, undefined);
  assert.equal(store.snapshot(healthFeatures, true, 171).sensorFresh, false);
});
it('expires and bounds incident summaries', () => {
  const store = new FirmwareTelemetry();
  for (let index = 0; index < 250; index++) ingestLog(store, log('sensor-reset', 100 + index * 1000, index));
  assert.ok(store.snapshot(healthFeatures, true, 249100).incidents.length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(store.snapshot(healthFeatures, true, 249100).incidents)) <= 256 * 1024);
  assert.equal(store.snapshot(healthFeatures, true, 249100 + 86401).incidents.length, 0);
});

it('retains separate sides and sources as tap diagnostics, deduplicates replay and bounds export history', () => {
  const store = new FirmwareTelemetry();
  const tapFlags = { ...features, tapDiagnostics: true };
  for (let index = 0; index < 1001; index++) {
    const timestamp = 1000 + index;
    const tap = { kind: 'tap', origin: 'tap-gesture', side: index % 2 ? 'left' : 'right', count: 2,
      timestamp, receivedAt: timestamp, source: 'RAW', sequence: index, index: 0 };
    const batch = FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [tap] });
    store.ingest(batch, tapFlags, timestamp);
    store.ingest(batch, tapFlags, timestamp);
  }
  const snapshot = store.snapshot(tapFlags, true, 2000);
  assert.equal(snapshot.taps.length, 1000);
  assert.equal(snapshot.taps[0].timestamp, 1001);
  assert.equal(store.snapshot(tapFlags, true, 3801).taps.length, 0);
  assert.equal(store.snapshot(features, true, 2000).taps.length, 0);
});

it('uses aligned measured Celsius for each side and requires managed device state', () => {
  const store = new FirmwareTelemetry();
  const flags = { ...features, coolingWarning: true };
  for (let elapsed = 0; elapsed <= 4900; elapsed += 10) {
    const timestamp = 100 + elapsed;
    store.observeDevice({ left: true, right: false, priming: false }, timestamp);
    for (const side of ['left', 'right'] as const) {
      const base = { timestamp, receivedAt: timestamp, source: 'RAW', sequence: elapsed, index: 0, side };
      const records = [
        { ...base, kind: 'thermostat', targetC: 24.5, power: -0.1, valid: true, enabled: true },
        { ...base, kind: 'pump', rpm: 200, water: true, loopC: 25 },
        { ...base, kind: 'water', waterC: elapsed <= 3600 ? 25 : 26 },
      ];
      store.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records }), flags, timestamp);
    }
  }
  const data = store.snapshot(flags, true, 5000);
  assert.equal(data.cooling.left.active, true);
  assert.equal(data.cooling.right.active, false);
  store.acknowledgeCooling('right', data.cooling.left.since!);
  assert.equal(store.snapshot(flags, true, 5000).cooling.left.notice, true);
  store.acknowledgeCooling('left', data.cooling.left.since!);
  assert.equal(store.snapshot(flags, true, 5000).cooling.left.notice, false);
  assert.equal(store.snapshot(flags, true, 5000).cooling.left.active, true);
  store.observeDevice({ left: true, right: false, priming: true }, 5000);
  assert.equal(store.snapshot(flags, true, 5000).cooling.left.active, false);
});

it('does not let logs refresh missing sensor telemetry and emits the corroborated interruption wording', () => {
  const store = new FirmwareTelemetry();
  store.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [{
    kind: 'sensor', timestamp: 100, receivedAt: 100, source: 'RAW', sequence: 1, index: 0,
  }] }), healthFeatures, 100);
  ingestLog(store, log('sensor-reset', 110, 2));
  // A reset message is not evidence that samples resumed.
  assert.equal(store.snapshot(healthFeatures, true, 171).sensorFresh, false);
  ingestLog(store, log('bus-timeout', 230, 3));
  assert.equal(store.summary(healthFeatures, true, 230)?.message, 'Bed sensor readings are interrupted.');
  assert.equal(store.summary(healthFeatures, false, 230)?.message, 'Monitoring unavailable');
});

it('preserves cooling history across thirty-second delivery batches and out-of-order records', () => {
  for (const step of [30, 60]) {
    const store = new FirmwareTelemetry();
    const flags = { ...features, coolingWarning: true };
    for (let elapsed = 0; elapsed <= 4920; elapsed += step) {
      const timestamp = 100 + elapsed;
      store.observeDevice({ left: true, right: false, priming: false }, timestamp);
      const base = { timestamp, receivedAt: timestamp, source: 'RAW', sequence: elapsed, index: 0, side: 'left' };
      store.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [
        { ...base, kind: 'water', waterC: elapsed <= 3600 ? 25 : 26 },
        { ...base, kind: 'pump', rpm: 200, water: true, loopC: 25 },
        { ...base, kind: 'thermostat', targetC: 24.5, power: -0.1, valid: true, enabled: true },
      ] }), flags, timestamp);
    }
    assert.equal(store.snapshot(flags, true, 5020).cooling.left.active, true, `cadence ${step}`);
  }
});

it('treats incidents retained across a stream restart as historical', () => {
  const store = new FirmwareTelemetry();
  ingestLog(store, log('samples-dropped', 100, 1, 500));
  ingestLog(store, log('samples-dropped', 101, 2, 502));
  ingestLog(store, log('samples-dropped', 102, 3, 900), 'b'.repeat(32));
  assert.equal(store.snapshot(healthFeatures, true, 102).incidents[0].freshness, 'Historical');
  assert.equal(store.summary(healthFeatures, true, 102)?.status, 'waiting_for_data');
});

const thermalOrders = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];
function thermalRecords(timestamp: number, side: 'left' | 'right', power = -0.1) {
  const base = { timestamp, receivedAt: timestamp, source: 'RAW', sequence: timestamp, index: 0, side };
  return FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [
    { ...base, kind: 'water', waterC: timestamp <= 3700 ? 25 : 26 },
    { ...base, kind: 'pump', rpm: 200, water: true, loopC: 25 },
    { ...base, kind: 'thermostat', targetC: 24.5, power, valid: true, enabled: true },
  ] }).records;
}
const coolingFlags = { ...features, coolingWarning: true };
function deliverThermal(store: FirmwareTelemetry, timestamp: number, side: 'left' | 'right',
  order: number[], power = -0.1, split = false) {
  store.observeDevice({ left: true, right: true, priming: false }, timestamp);
  const records = thermalRecords(timestamp, side, power);
  const ordered = order.map(index => records[index]);
  for (const batch of split ? ordered.map(record => [record]) : [ordered]) {
    store.ingest({ session: 'a'.repeat(32), records: batch }, coolingFlags, timestamp);
  }
}

it('clears cooling candidates when heating starts before, at or after the twenty-minute boundary in every record order', () => {
  for (const side of ['left', 'right'] as const) for (const order of thermalOrders) {
    for (const transition of [4900, 4910, 4920]) for (const split of [false, true]) {
      const store = new FirmwareTelemetry();
      for (let timestamp = 100; timestamp < transition; timestamp += 10) {
        deliverThermal(store, timestamp, side, order);
      }
      assert.equal(store.snapshot(coolingFlags, true, transition - 10).cooling[side].active, transition === 4920);
      deliverThermal(store, transition, side, order, 0.1, split);
      const finding = store.snapshot(coolingFlags, true, transition).cooling[side];
      assert.equal(finding.active, false, `${side}, ${order}, transition ${transition}, split ${split}`);
      assert.equal(finding.notice, false);
      for (let timestamp = transition + 10; timestamp <= transition + 1200; timestamp += 10) {
        deliverThermal(store, timestamp, side, order);
      }
      assert.equal(store.snapshot(coolingFlags, true, transition + 1200).cooling[side].active, false);
      deliverThermal(store, transition + 1210, side, order);
      assert.equal(store.snapshot(coolingFlags, true, transition + 1210).cooling[side].active, true);
    }
  }
});

it('starts cooling dwell from the latest thermostat when cooling begins in every record order', () => {
  for (const side of ['left', 'right'] as const) for (const order of thermalOrders) {
    const store = new FirmwareTelemetry();
    for (let timestamp = 100; timestamp <= 4900; timestamp += 10) {
      deliverThermal(store, timestamp, side, order, timestamp < 3710 ? 0.1 : -0.1);
    }
    assert.equal(store.snapshot(coolingFlags, true, 4900).cooling[side].active, false);
    deliverThermal(store, 4910, side, order);
    assert.equal(store.snapshot(coolingFlags, true, 4910).cooling[side].active, true, `${side}, ${order}`);
  }
});

it('uses the newest thermostat in a batch even when an older cooling record follows it', () => {
  for (const order of thermalOrders) {
    const store = new FirmwareTelemetry();
    for (let timestamp = 100; timestamp <= 4900; timestamp += 10) deliverThermal(store, timestamp, 'left', order);
    store.observeDevice({ left: true, right: false, priming: false }, 4910);
    const records = thermalRecords(4910, 'left', 0.1);
    const older = { ...thermalRecords(4905, 'left')[2], receivedAt: 4910 };
    store.ingest({ session: 'a'.repeat(32), records: [...order.map(index => records[index]), older] }, coolingFlags, 4910);
    assert.equal(store.snapshot(coolingFlags, true, 4910).cooling.left.active, false, `${order}`);
  }
});

it('keeps an incident that is still being reported a day after it began', () => {
  const store = new FirmwareTelemetry();
  ingestLog(store, log('sensor-reset', 1000, 1));
  ingestLog(store, log('sensor-reset', 1000 + 23 * 3600, 2));
  const incidents = store.snapshot(healthFeatures, true, 1000 + 25 * 3600).incidents;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].count, 2);
  assert.equal(incidents[0].firstSeen, 1000);
});
