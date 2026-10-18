import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-rhythms-routes-'));
mkdirSync(path.join(folder, 'lowdb'));
// An existing settings file, so Rhythms starts off as on an updated Pod.
writeFileSync(path.join(folder, 'lowdb', 'settingsDB.json'), '{}');
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const calls = [];
let enableResult = { converted: true };
let runRebuild = false;
mock.module(new URL('../../jobs/jobScheduler.js', import.meta.url).href, {
    namedExports: { setupJobs: async () => { calls.push(['setupJobs']); } },
});
mock.module(new URL('../../jobs/rhythms/enable.js', import.meta.url).href, {
    namedExports: {
        enableRhythms: async (rebuild) => {
            calls.push(['enable', typeof rebuild]);
            if (runRebuild)
                await rebuild();
            return enableResult;
        },
    },
});
mock.module(new URL('../../jobs/rhythms/handoff.js', import.meta.url).href, {
    namedExports: {
        disableRhythms: async (options, rebuild) => {
            calls.push(['disable', options, typeof rebuild]);
            if (runRebuild)
                await rebuild();
            return { sides: [] };
        },
    },
});
const { default: settingsDB } = await import('../../db/settings.js');
let server;
let url;
before(async () => {
    const app = express();
    app.use(express.json());
    app.use((await import('./rhythms.js')).default);
    app.use((await import('../settings/settings.js')).default);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
    rmSync(folder, { recursive: true, force: true });
});
beforeEach(() => {
    calls.length = 0;
    enableResult = { converted: true };
    runRebuild = false;
});
const post = (route, body) => fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
describe('POST /rhythms/enable', () => {
    it('turns Rhythms on through the handoff module', async () => {
        const response = await post('/rhythms/enable', {});
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { converted: true });
        assert.deepEqual(calls, [['enable', 'function']]);
    });
    it('answers 409 when the data cannot be used', async () => {
        enableResult = { error: 'newer data' };
        const response = await post('/rhythms/enable');
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: 'newer data' });
    });
    it('rejects a body with keys', async () => {
        assert.equal((await post('/rhythms/enable', { force: true })).status, 400);
        assert.deepEqual(calls, []);
    });
});
describe('POST /rhythms/disable', () => {
    it('passes the power-off choice through and defaults it to false', async () => {
        assert.equal((await post('/rhythms/disable', { powerOffNow: true })).status, 200);
        assert.equal((await post('/rhythms/disable')).status, 200);
        assert.deepEqual(calls, [['disable', { powerOffNow: true }, 'function'], ['disable', { powerOffNow: false }, 'function']]);
    });
    it('rejects anything else', async () => {
        assert.equal((await post('/rhythms/disable', { powerOffNow: 'yes' })).status, 400);
        assert.equal((await post('/rhythms/disable', { extra: 1 })).status, 400);
        assert.deepEqual(calls, []);
    });
});
describe('rebuild', () => {
    it('both routes rebuild the jobs with setupJobs', async () => {
        runRebuild = true;
        assert.equal((await post('/rhythms/enable', {})).status, 200);
        assert.equal((await post('/rhythms/disable', {})).status, 200);
        assert.deepEqual(calls, [
            ['enable', 'function'], ['setupJobs'],
            ['disable', { powerOffNow: false }, 'function'], ['setupJobs'],
        ]);
    });
});
describe('POST /settings', () => {
    it('refuses to flip the Rhythms flag directly', async () => {
        const response = await post('/settings', { features: { rhythms: true } });
        assert.equal(response.status, 409);
        assert.match(JSON.stringify(await response.json()), /rhythms\/enable/);
        await settingsDB.read();
        assert.equal(settingsDB.data.features.rhythms, false);
        assert.equal((await post('/settings', { features: { rhythms: false } })).status, 200);
    });
});
//# sourceMappingURL=rhythmsSwitchRoutes.test.js.map