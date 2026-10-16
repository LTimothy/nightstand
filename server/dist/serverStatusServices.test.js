import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-status-services-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
mock.module(new URL('./db/prisma.js', import.meta.url).href, { namedExports: { prisma: {} } });
const { default: servicesDB, updateServices } = await import('./db/services.js');
const { default: serverStatus } = await import('./serverStatus.js');
after(() => rmSync(folder, { recursive: true, force: true }));
it('does not rewrite healthy or already failed stream status while polling', async () => {
    await updateServices({ biometrics: { enabled: true, jobs: { stream: {
                    status: 'healthy', message: '', timestamp: new Date().toISOString(),
                } } } });
    const writes = mock.method(servicesDB, 'write');
    await serverStatus.updateServices();
    await serverStatus.updateServices();
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(serverStatus.status.biometricsStream?.status, 'healthy');
    await updateServices({ biometrics: { jobs: { stream: {
                    timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
                } } } });
    writes.mock.resetCalls();
    await serverStatus.updateServices();
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(serverStatus.status.biometricsStream?.status, 'failed');
    writes.mock.resetCalls();
    await serverStatus.updateServices();
    assert.equal(writes.mock.callCount(), 0);
    await updateServices({ biometrics: { enabled: false } });
    writes.mock.resetCalls();
    await serverStatus.updateServices();
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(serverStatus.status.biometricsStream, undefined);
});
it('checks the stream timestamp after queued service updates', async () => {
    await updateServices({ biometrics: { enabled: true, jobs: { stream: {
                    status: 'healthy', message: '', timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
                } } } });
    const timestamp = new Date().toISOString();
    await Promise.all([
        updateServices({ biometrics: { jobs: { stream: { status: 'healthy', message: '', timestamp } } } }),
        serverStatus.updateServices(),
    ]);
    await servicesDB.read();
    assert.equal(servicesDB.data.biometrics.jobs.stream.timestamp, timestamp);
    assert.equal(serverStatus.status.biometricsStream?.status, 'healthy');
});
//# sourceMappingURL=serverStatusServices.test.js.map