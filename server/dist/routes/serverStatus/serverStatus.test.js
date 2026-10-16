import assert from 'node:assert/strict';
import { after, before, it, mock } from 'node:test';
import express from 'express';
import { performance } from 'node:perf_hooks';
// The health check uses liveness without refreshing the full status.
let statusReads = 0;
let now = 0;
let elapsed = 0;
let fail = false;
let refreshBarrier;
let observeRequest;
const status = { database: { status: 'healthy' } };
mock.method(Date, 'now', () => now);
mock.method(performance, 'now', () => elapsed);
mock.module(new URL('../../serverStatus.js', import.meta.url).href, { defaultExport: {
        toJSON: async () => {
            statusReads += 1;
            await refreshBarrier;
            if (fail)
                throw new Error('Status unavailable');
            return status;
        },
    } });
let server;
let url;
before(async () => {
    const app = express();
    app.use('/api/serverStatus', (_req, _res, next) => {
        next();
        observeRequest?.();
    });
    app.use('/api/serverStatus', (await import('./serverStatus.js')).default);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
it('answers the liveness check without reading the full status', async () => {
    const response = await fetch(`${url}/api/serverStatus/alive`);
    assert.equal(response.status, 204);
    assert.equal(statusReads, 0);
});
it('still serves the full status', async () => {
    const response = await fetch(`${url}/api/serverStatus`);
    assert.equal(response.status, 200);
    assert.equal(statusReads, 1);
});
it('shares a snapshot for 15 seconds, including concurrent requests', { timeout: 5_000 }, async () => {
    const get = async () => {
        const response = await fetch(`${url}/api/serverStatus`);
        assert.equal(response.status, 200);
        return response.json();
    };
    now = 14_999;
    elapsed = 14_999;
    status.database.status = 'failed';
    assert.deepEqual(await get(), { database: { status: 'healthy' } });
    assert.equal(statusReads, 1);
    now = 15_000;
    elapsed = 15_000;
    let releaseRefresh;
    refreshBarrier = new Promise(resolve => { releaseRefresh = resolve; });
    let arrivals = 0;
    const allArrived = new Promise(resolve => {
        observeRequest = () => { if (++arrivals === 3)
            resolve(); };
    });
    const responses = Promise.all([get(), get(), get()]);
    try {
        await allArrived;
        assert.equal(statusReads, 2);
    }
    finally {
        observeRequest = undefined;
        refreshBarrier = undefined;
        releaseRefresh();
    }
    const results = await responses;
    assert.deepEqual(results, Array(3).fill({ database: { status: 'failed' } }));
    assert.equal(statusReads, 2);
});
it('retries after a failed refresh instead of caching the rejection', async () => {
    now = 30_000;
    elapsed = 30_000;
    fail = true;
    assert.equal((await fetch(`${url}/api/serverStatus`)).status, 500);
    fail = false;
    assert.equal((await fetch(`${url}/api/serverStatus`)).status, 200);
    assert.equal(statusReads, 4);
});
it('expires the snapshot after a backward wall-clock correction', async () => {
    now -= 60_000;
    elapsed = 44_999;
    status.database.status = 'healthy';
    assert.deepEqual(await (await fetch(`${url}/api/serverStatus`)).json(), { database: { status: 'failed' } });
    assert.equal(statusReads, 4);
    now += 20_000;
    elapsed = 50_000;
    assert.deepEqual(await (await fetch(`${url}/api/serverStatus`)).json(), { database: { status: 'healthy' } });
    assert.equal(statusReads, 5);
});
//# sourceMappingURL=serverStatus.test.js.map