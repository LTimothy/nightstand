import fs from 'node:fs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'bed-in-use-routes-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const TARGET_FILE = '/persistent/free-sleep-data/update-target.json';
const REQUEST_FILE = '/persistent/free-sleep-data/operation-request.json';
let reasons = [];
const started = [];
const targetWrites = [];
const requestWrites = [];
const switchTargets = [];
let requestWriteFails = false;
const writeFile = fs.promises.writeFile.bind(fs.promises);
mock.method(fs.promises, 'writeFile', async (...args) => {
    if (args[0] === TARGET_FILE)
        targetWrites.push(String(args[1]));
    else if (args[0] === REQUEST_FILE) {
        if (requestWriteFails)
            throw new Error('read-only');
        requestWrites.push(String(args[1]));
    }
    else
        await writeFile(...args);
});
const trigger = async (hooks = {}) => {
    await hooks.beforeStart?.();
    started.push('started');
};
for (const [file, name] of [
    ['update', 'triggerUpdateService'], ['rollback', 'triggerRollbackService'], ['revertToStock', 'triggerRevertToStockService'],
]) {
    mock.module(new URL(`../../jobs/${file}.js`, import.meta.url).href, { namedExports: { [name]: file === 'revertToStock'
                ? async (hooks = {}, request) => { switchTargets.push(request?.target); await trigger(hooks); }
                : trigger } });
}
let server;
let url;
let setInUseCheck;
let setResultFileForTests;
before(async () => {
    const app = express();
    app.use(express.json());
    const update = await import('./update.js');
    ({ setInUseCheck, setResultFileForTests } = update);
    setResultFileForTests(path.join(folder, 'update-result.json'));
    setInUseCheck(async () => reasons);
    app.use('/api/update', update.default);
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => {
    reasons = [];
    started.length = 0;
    targetWrites.length = 0;
    requestWrites.length = 0;
    switchTargets.length = 0;
    requestWriteFails = false;
});
const send = async (method, route, body) => {
    const response = await fetch(`${url}${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) };
};
const post = (route, body) => send('POST', route, body);
const routes = [
    ['/api/update', {}], ['/api/update/rollback', undefined],
    ['/api/update/switch-to-upstream', undefined], ['/api/update/revert-to-stock', undefined],
];
for (const [route, body] of routes) {
    describe(route, () => {
        it('refuses while the bed may be in use, without starting anything', async () => {
            reasons = ['left-on'];
            const response = await post(route, body);
            assert.equal(response.status, 409);
            assert.deepEqual(response.body.reasons, ['left-on']);
            assert.match(response.body.error, /^A side is on\./);
            assert.equal(started.length, 0);
        });
        it('refuses for each reason with its own text', async () => {
            for (const [reason, text] of [
                ['right-on', 'A side is on. The bed keeps its current temperature, but schedules and alarms stop for up to five minutes.'],
                ['alarm-soon', 'An alarm is due in the next 15 minutes. If it falls while Nightstand restarts, it will not ring.'],
                ['status-unknown', "Nightstand cannot read the bed's state right now, so someone may be using it."],
            ]) {
                reasons = [reason];
                const response = await post(route, body);
                assert.equal(response.status, 409);
                assert.equal(response.body.error, text);
            }
            assert.equal(started.length, 0);
        });
        it('goes ahead when confirmed', async () => {
            reasons = ['alarm-soon'];
            assert.equal((await post(route, { ...(body ?? {}), confirmInUse: true })).status, 204);
            assert.equal(started.length, 1);
        });
        it('does not take a confirmation that is not exactly true', async () => {
            reasons = ['status-unknown'];
            assert.equal((await post(route, { ...(body ?? {}), confirmInUse: false })).status, 409);
            for (const confirmInUse of ['true', 1]) {
                assert.equal((await post(route, { ...(body ?? {}), confirmInUse })).status, 400);
            }
            assert.equal(started.length, 0);
        });
        it('goes ahead without confirmation when the bed is idle', async () => {
            reasons = [];
            assert.equal((await post(route, body)).status, 204);
            assert.equal(started.length, 1);
        });
        // The script checks the bed again just before it stops the server,
        // unless the owner already confirmed.
        it('passes the confirmation on to the script', async () => {
            reasons = [];
            await post(route, body);
            reasons = ['left-on'];
            await post(route, { ...(body ?? {}), confirmInUse: true });
            assert.deepEqual(requestWrites.map(text => JSON.parse(text)), [
                { source: 'app', confirmInUse: false }, { source: 'app', confirmInUse: true },
            ]);
        });
        it('still starts when the request cannot be saved', async () => {
            requestWriteFails = true;
            assert.equal((await post(route, body)).status, 204);
            assert.equal(started.length, 1);
        });
    });
}
it('reports the reasons to the app', async () => {
    reasons = ['status-unknown'];
    assert.deepEqual((await send('GET', '/api/update/in-use')).body, { reasons: ['status-unknown'] });
    reasons = [];
    assert.deepEqual((await send('GET', '/api/update/in-use')).body, { reasons: [] });
});
it('rejects unknown fields on rollback and switch', async () => {
    for (const route of ['/api/update/rollback', '/api/update/switch-to-upstream', '/api/update/revert-to-stock']) {
        const response = await post(route, { confirmInUse: true, extra: 1 });
        assert.equal(response.status, 400);
    }
    assert.equal(started.length, 0);
});
it('never writes confirmInUse into the target file', async () => {
    await post('/api/update', { targetVersion: '3.6.0', confirmInUse: true });
    assert.equal(targetWrites.length, 1);
    assert.deepEqual(JSON.parse(targetWrites[0]), { version: '3.6.0', allowDowngrade: false });
});
it('does not write a target file for a refused update', async () => {
    reasons = ['left-on'];
    await post('/api/update', { targetVersion: '3.6.0' });
    assert.deepEqual(targetWrites, []);
});
it('treats a check that throws as the bed possibly being in use', async () => {
    setInUseCheck(async () => { throw new Error('boom'); });
    try {
        assert.deepEqual((await send('GET', '/api/update/in-use')).body, { reasons: ['status-unknown'] });
        assert.equal((await post('/api/update/rollback')).status, 409);
        assert.equal(started.length, 0);
    }
    finally {
        setInUseCheck(async () => reasons);
    }
});
it('refuses without a registered check, as the updater overlay has none', async () => {
    const fresh = await import(`./update.js?no-check=${Date.now()}`);
    const app = express();
    app.use(express.json());
    app.use('/api/update', fresh.default);
    const other = app.listen(0);
    await new Promise(resolve => other.once('listening', resolve));
    try {
        const base = `http://127.0.0.1:${other.address().port}/api/update`;
        const refused = await fetch(`${base}/rollback`, { method: 'POST' });
        assert.equal(refused.status, 409);
        assert.deepEqual((await refused.json()).reasons, ['status-unknown']);
        assert.equal(started.length, 0);
    }
    finally {
        other.closeAllConnections();
        await new Promise(resolve => other.close(() => resolve()));
    }
});
describe('GET /api/update/last-result', () => {
    const resultFile = () => path.join(folder, 'update-result.json');
    const record = {
        runId: '1f2e3d4c', operation: 'update', outcome: 'rolled-back', from: '3.5.1', to: '3.6.0',
        message: 'the new version did not pass its health check', finishedAt: '2026-10-02T03:04:05Z',
    };
    beforeEach(() => fs.rmSync(resultFile(), { force: true }));
    it('returns what the script wrote', async () => {
        fs.writeFileSync(resultFile(), JSON.stringify(record));
        const response = await send('GET', '/api/update/last-result');
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, record);
    });
    it('accepts a record with no versions', async () => {
        const bare = { ...record, from: null, to: null };
        fs.writeFileSync(resultFile(), JSON.stringify(bare));
        assert.deepEqual((await send('GET', '/api/update/last-result')).body, bare);
    });
    it('answers 404 when nothing has been recorded', async () => {
        assert.equal((await send('GET', '/api/update/last-result')).status, 404);
    });
    it('answers 404 for a file it cannot read as a result', async () => {
        for (const content of ['{not json', '{}', JSON.stringify({ ...record, outcome: 'exploded' }), JSON.stringify({ ...record, runId: 7 })]) {
            fs.writeFileSync(resultFile(), content);
            assert.equal((await send('GET', '/api/update/last-result')).status, 404, content);
        }
    });
});
const confirmedUpstream = {
    commit: 'e5172139874a274d1ced12c8da052ab2cbaa286d', version: '3.0.3',
    treeSha256: '59073c3b2b2c3db7d133ad5b33a3471bfbe83b15ec63e3143f3d42a11e0f628b', date: '2026-10-07',
};
for (const route of ['/api/update/switch-to-upstream', '/api/update/revert-to-stock']) {
    it(`${route} passes exactly the confirmed upstream record to the switch service`, async () => {
        for (const target of [confirmedUpstream, { commit: 'ca7dc543119ae964dd10815c8ae0c80ddb9a4f8f',
                date: '2026-10-02', treeSha256: 'a'.repeat(64) }]) {
            assert.equal((await post(route, { target, confirmInUse: true })).status, 204);
            assert.deepEqual(switchTargets.at(-1), target);
        }
    });
    it(`${route} rejects malformed or extra target fields before starting`, async () => {
        for (const target of [null, {}, { ...confirmedUpstream, commit: 'main' },
            { ...confirmedUpstream, date: '2026-02-30' }, { ...confirmedUpstream, extra: true }]) {
            assert.equal((await post(route, { target, confirmInUse: true })).status, 400);
        }
        assert.equal(started.length, 0);
    });
    it(`${route} retains the same target across the bed-use confirmation`, async () => {
        reasons = ['left-on'];
        assert.equal((await post(route, { target: confirmedUpstream })).status, 409);
        assert.deepEqual(switchTargets, []);
        assert.equal((await post(route, { target: confirmedUpstream, confirmInUse: true })).status, 204);
        assert.deepEqual(switchTargets, [confirmedUpstream]);
    });
}
//# sourceMappingURL=bedInUseRoutes.test.js.map