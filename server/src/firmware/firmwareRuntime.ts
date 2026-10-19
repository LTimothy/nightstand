import { FirmwareTelemetry } from './firmwareTelemetry.js';
import type { FirmwareFeatures } from './firmwareSchema.js';
import eventBus from '../events/eventBus.js';
export const firmwareTelemetry = new FirmwareTelemetry();
let lastSummary = '';

export function firmwareHealthSummary(features: FirmwareFeatures, enabled: boolean, now = Date.now() / 1000) {
  const data = firmwareTelemetry.snapshot(features, enabled, now);
  const summary = firmwareTelemetry.summary(features, enabled, now, data);
  const signature = JSON.stringify({ summary, incidents: data.incidents.map(item => ({
    code: item.code, side: item.side, firstSeen: item.firstSeen, recoveredAt: item.recoveredAt,
    freshness: item.freshness,
    count: item.severity === 'warning' ? item.count : undefined,
  })) });
  if (signature !== lastSummary) {
    lastSummary = signature;
    eventBus.emit('service-health', { firmwareHealth: summary });
  }
  return summary;
}

export function observeFirmwareDevice(state: { left: { isOn: boolean }; right: { isOn: boolean }; isPriming: boolean }) {
  firmwareTelemetry.observeDevice({ left: state.left.isOn, right: state.right.isOn, priming: state.isPriming }, Date.now() / 1000);
}
