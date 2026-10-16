import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';
import { lastDeviceStatus, noteDeviceStatus } from './lastDeviceStatus.js';

const read = { waterLevel: 'true' } as DeviceStatus;
afterEach(() => mock.restoreAll());

describe('lastDeviceStatus', () => {
  it('returns a recent read', () => {
    const now = mock.method(Date, 'now', () => 1_000_000);
    noteDeviceStatus(read);
    now.mock.mockImplementation(() => 1_010_000);
    assert.equal(lastDeviceStatus(), read);
  });

  it('reads as unknown once the read is older than ten seconds', () => {
    const now = mock.method(Date, 'now', () => 1_000_000);
    noteDeviceStatus(read);
    now.mock.mockImplementation(() => 1_010_001);
    assert.equal(lastDeviceStatus(), undefined);
  });
});
