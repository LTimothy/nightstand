import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';

// Several 2 s polls: past this the monitor has stopped reading, so the
// snapshot says nothing reliable about the bed.
const MAX_AGE_MS = 10_000;

let last: { status: DeviceStatus; at: number } | undefined;

// The monitor's latest read, or undefined when there is none or it is stale.
export const lastDeviceStatus = (): DeviceStatus | undefined =>
  last && Date.now() - last.at <= MAX_AGE_MS ? last.status : undefined;

export function noteDeviceStatus(status: DeviceStatus): void {
  last = { status, at: Date.now() };
}
