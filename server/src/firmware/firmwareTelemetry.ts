import { CoolingWarning } from './coolingWarning.js';
import type { StatusInfo } from '../routes/serverStatus/serverStatusSchema.js';
import { HealthFeed } from './healthFeed.js';
import {
  FIRMWARE_FRESH_SECONDS, FirmwareBatch, FirmwareFeatures, FirmwareTarget, TapRecord, Thermostat, WaterRecord, PumpRecord,
} from './firmwareSchema.js';

export class FirmwareTelemetry {
  private cooling = { left: new CoolingWarning(), right: new CoolingWarning() };
  private water: Partial<Record<'left' | 'right', WaterRecord>> = {};
  private pumps: Partial<Record<'left' | 'right', PumpRecord>> = {};
  private device?: { left: boolean; right: boolean; priming: boolean; timestamp: number };
  private session?: string;
  private targets: Partial<Record<'left' | 'right', Thermostat>> = {};
  private taps: TapRecord[] = [];
  private health = new HealthFeed();
  private seen = new Set<string>();

  ingest(batch: FirmwareBatch, features: FirmwareFeatures, now: number) {
    if (batch.session !== this.session) {
      this.session = batch.session;
      this.targets = {}; this.water = {}; this.pumps = {};
      this.cooling.left.reset(); this.cooling.right.reset();
    }
    if (features.firmwareHealth) this.health.beginSession(batch.session, now);
    for (const record of batch.records) {
      if (record.timestamp > now || now - record.timestamp > FIRMWARE_FRESH_SECONDS
          || record.receivedAt > now + 5 || now - record.receivedAt > FIRMWARE_FRESH_SECONDS) continue;
      const side = 'side' in record ? record.side : '';
      const source = record.sequence === null ? record.source : '';
      const candidate = record.kind === 'tap' ? `${record.origin}:${record.control ?? ''}` : '';
      const key = `${batch.session}:${source}:${record.sequence}:${record.index}:${record.kind}:${side}:${candidate}:${record.timestamp}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
      if (features.coolingWarning && record.kind === 'water'
          && (!this.water[record.side] || record.timestamp > this.water[record.side]!.timestamp)) this.water[record.side] = record;
      if (features.coolingWarning && record.kind === 'pump'
          && (!this.pumps[record.side] || record.timestamp > this.pumps[record.side]!.timestamp)) this.pumps[record.side] = record;
      if (record.kind === 'tap' && features.tapDiagnostics) {
        this.taps.push(record);
        this.taps = this.taps.filter(item => now - item.timestamp <= 1800).slice(-1000);
      }
      if (record.kind === 'sensor' && features.firmwareHealth) this.health.sensor(record.timestamp);
      if (record.kind === 'health' && features.firmwareHealth) this.health.observe(record, batch.session, now);
      if (record.kind === 'thermostat' && (features.firmwareTargetReadout || features.coolingWarning)) {
        if (!this.targets[record.side] || record.timestamp > this.targets[record.side]!.timestamp) this.targets[record.side] = record;
      }
    }
    if (features.coolingWarning) this.evaluateCooling(now);
    else { this.cooling.left.reset(); this.cooling.right.reset(); }
  }

  observeDevice(state: { left: boolean; right: boolean; priming: boolean }, now: number) {
    this.device = { ...state, timestamp: now };
    for (const side of ['left', 'right'] as const) if (!state[side] || state.priming) this.cooling[side].reset();
  }

  acknowledgeCooling(side: 'left' | 'right', since: number) { this.cooling[side].acknowledge(since); }

  private evaluateCooling(now: number) {
    for (const side of ['left', 'right'] as const) {
      const target = this.targets[side]; const water = this.water[side]; const pump = this.pumps[side];
      const state = this.device;
      if (!target || !water || !pump || !state || now - state.timestamp > 60
          || [target, water, pump].some(item => now - item.timestamp > 60)
          || Math.max(target.timestamp, water.timestamp, pump.timestamp) - Math.min(target.timestamp, water.timestamp, pump.timestamp) > 15) {
        this.cooling[side].reset();
        continue;
      }
      this.cooling[side].observe({ timestamp: water.timestamp, waterC: water.waterC,
        targetC: target.targetC, valid: target.valid, enabled: target.enabled, power: target.power,
        rpm: pump.rpm, water: pump.water, loopC: pump.loopC, isOn: state[side], priming: state.priming });
    }
  }

  summary(features: FirmwareFeatures, biometrics: boolean, now: number): StatusInfo | undefined {
    // On by default, so a Pod without Biometrics gets no row rather than one that can never fill.
    if (!features.firmwareHealth || !biometrics) return undefined;
    const data = this.snapshot(features, biometrics, now);
    const warnings = data.incidents.filter(item => item.severity === 'warning' && !item.recoveredAt && item.freshness === 'Recent');
    const message = data.interrupted ? 'Bed sensor readings are interrupted.'
      : warnings.length ? warnings.map(item => item.message).join(' ')
        : !data.sensorFresh ? 'No recent readings' : 'Recent sensor readings received.';
    return { name: 'Firmware health', description: 'Selected firmware messages and sensor freshness.',
      status: warnings.length ? 'failed' : !data.sensorFresh ? 'waiting_for_data' : 'healthy',
      message, ...(data.interrupted ? { status: 'failed' as const } : {}) };
  }

  snapshot(features: FirmwareFeatures, biometrics: boolean, now: number) {
    if (!features.coolingWarning || !biometrics) { this.cooling.left.reset(); this.cooling.right.reset(); }
    const cooling = { left: this.cooling.left.snapshot(now), right: this.cooling.right.snapshot(now) };
    const targets = {} as Record<'left' | 'right', FirmwareTarget>;
    for (const side of ['left', 'right'] as const) {
      const sample = features.firmwareTargetReadout && biometrics ? this.targets[side] : undefined;
      targets[side] = !sample ? { state: 'unavailable' } : {
        state: now - sample.timestamp > FIRMWARE_FRESH_SECONDS ? 'stale'
          : !sample.valid || sample.targetC === null ? 'unavailable' : !sample.enabled ? 'disabled' : 'available',
        targetC: sample.valid && sample.targetC !== null ? sample.targetC : undefined, timestamp: sample.timestamp,
      };
    }
    this.taps = this.taps.filter(item => now - item.timestamp <= 1800).slice(-1000);
    const health = this.health.snapshot(now);
    return { availability: biometrics ? 'Monitoring active' : 'Monitoring unavailable', targets, cooling,
      taps: features.tapDiagnostics ? this.taps.map(item => ({ ...item })) : [],
      incidents: features.firmwareHealth ? health.incidents : [], sensorFresh: biometrics && health.sensorFresh,
      interrupted: features.firmwareHealth && biometrics && health.interrupted };
  }
}
