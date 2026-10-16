import assert from 'node:assert/strict';
import { it } from 'node:test';
import eventBus from '../events/eventBus.js';
import { firmwareTelemetry, firmwareHealthSummary } from './firmwareRuntime.js';
import { FirmwareBatchSchema } from './firmwareSchema.js';
it('publishes meaningful health transitions without broadcasting every repeated message', () => {
    const features = { firmwareTargetReadout: false, firmwareHealth: true, tapDiagnostics: false, coolingWarning: false };
    const messages = [];
    const unsubscribe = eventBus.subscribe('service-health', event => messages.push(event.payload));
    const identity = { timestamp: 100, receivedAt: 100, source: 'RAW', sequence: 1, index: 0 };
    try {
        firmwareTelemetry.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [
                { ...identity, kind: 'sensor' },
                { ...identity, kind: 'health', code: 'sensor-reset', side: 'left', details: {} },
            ] }), features, 100);
        firmwareHealthSummary(features, true, 100);
        assert.equal(messages.length, 1);
        firmwareTelemetry.ingest(FirmwareBatchSchema.parse({ session: 'a'.repeat(32), records: [
                { ...identity, timestamp: 110, receivedAt: 110, sequence: 2, kind: 'health',
                    code: 'sensor-reset', side: 'left', details: {} },
            ] }), features, 110);
        firmwareHealthSummary(features, true, 110);
        assert.equal(messages.length, 1);
        firmwareHealthSummary(features, true, 171);
        assert.equal(messages.length, 2);
        firmwareHealthSummary(features, false, 171);
        assert.equal(messages.length, 3);
        assert.deepEqual(messages[2], { firmwareHealth: {
                name: 'Firmware health', description: 'Selected firmware messages and sensor freshness.',
                status: 'waiting_for_data', message: 'Monitoring unavailable',
            } });
    }
    finally {
        unsubscribe();
    }
});
//# sourceMappingURL=firmwareRuntime.test.js.map