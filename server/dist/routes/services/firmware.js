import express from 'express';
import { z } from 'zod';
import { FirmwareBatchSchema } from '../../firmware/firmwareSchema.js';
import { firmwareTelemetry, firmwareHealthSummary } from '../../firmware/firmwareRuntime.js';
import settingsDB from '../../db/settings.js';
import servicesDB from '../../db/services.js';
import { noteButtonTap } from '../../8sleep/clickCounts.js';
export const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '');
export function createFirmwareRouter(store, readConfig) {
    const router = express.Router();
    router.post('/services/firmware', async (req, res) => {
        // Use the socket peer, never forwarded headers or Express's proxy-aware IP.
        if (!isLoopback(req.socket.remoteAddress)) {
            res.sendStatus(403);
            return;
        }
        if (Buffer.byteLength(JSON.stringify(req.body) ?? '') > 65536) {
            res.sendStatus(413);
            return;
        }
        const parsed = FirmwareBatchSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid firmware telemetry' });
            return;
        }
        const nowSeconds = Date.now() / 1000;
        for (const record of parsed.data.records) {
            if (record.kind === 'tap' && record.origin === 'buttonEvent')
                noteButtonTap(record, nowSeconds);
        }
        const config = await readConfig();
        if (config.enabled)
            store.ingest(parsed.data, config.features, Date.now() / 1000);
        if (store === firmwareTelemetry)
            firmwareHealthSummary(config.features, config.enabled);
        res.sendStatus(204);
    });
    router.post('/services/firmware/cooling/acknowledge', async (req, res) => {
        const parsed = z.object({ side: z.enum(['left', 'right']), since: z.number().finite().nonnegative() }).strict().safeParse(req.body);
        if (!parsed.success) {
            res.sendStatus(400);
            return;
        }
        const config = await readConfig();
        if (!config.features.coolingWarning) {
            res.sendStatus(404);
            return;
        }
        store.acknowledgeCooling(parsed.data.side, parsed.data.since);
        res.sendStatus(204);
    });
    router.get('/services/firmware/taps/export', async (_req, res) => {
        const config = await readConfig();
        if (!config.features.tapDiagnostics) {
            res.sendStatus(404);
            return;
        }
        const snapshot = store.snapshot(config.features, config.enabled, Date.now() / 1000);
        res.attachment('tap-diagnostics.json').json({
            exportedAt: new Date().toISOString(), availability: snapshot.availability, taps: snapshot.taps,
        });
    });
    router.get('/services/firmware', async (_req, res) => {
        const config = await readConfig();
        res.json(store.snapshot(config.features, config.enabled, Date.now() / 1000));
    });
    return router;
}
export default createFirmwareRouter(firmwareTelemetry, async () => {
    await Promise.all([settingsDB.read(), servicesDB.read()]);
    return { features: settingsDB.data.features, enabled: servicesDB.data.biometrics.enabled };
});
//# sourceMappingURL=firmware.js.map