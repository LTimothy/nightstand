import assert from 'node:assert/strict';
import { after, beforeEach, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-settings-other-slot-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const applied = [];
let failure = null;
mock.module(new URL('../../jobs/otherSlot.js', import.meta.url).href, {
    namedExports: {
        applyOtherSlot: async (on) => {
            applied.push(on);
            if (failure)
                throw failure;
        },
    },
});
const { default: settingsDB } = await import('../../db/settings.js');
const { OperationBusyError } = await import('../../jobs/privilegedCommand.js');
const { default: router } = await import('./settings.js');
const app = express();
app.use(express.json(), router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/settings`;
after(async () => {
    await new Promise(resolve => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
});
const post = async (otherSlotAccess) => {
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ features: { otherSlotAccess } }),
    });
    return { status: response.status, body: await response.json() };
};
const stored = async () => {
    await settingsDB.read();
    return settingsDB.data.features.otherSlotAccess;
};
beforeEach(() => {
    applied.length = 0;
    failure = null;
});
it('saves the switch only after the script succeeds, and runs nothing when it is unchanged', async () => {
    assert.equal((await post(true)).status, 200);
    assert.equal(await stored(), true);
    assert.equal((await post(true)).status, 200);
    assert.deepEqual(applied, [true]);
    assert.equal((await post(false)).status, 200);
    assert.equal(await stored(), false);
    assert.deepEqual(applied, [true, false]);
});
it('refuses a failed apply with the fixed message and keeps the stored switch', async () => {
    failure = new Error('exit 2');
    const on = await post(true);
    assert.equal(on.status, 500);
    assert.match(on.body.error ?? '', /^Could not prepare the other boot slot\. It needs an SSH key and a rewt password/);
    assert.equal(await stored(), false);
});
it('passes a busy refusal on as 409 with its own text', async () => {
    failure = new OperationBusyError('An update, rollback or switch is already running. Wait for it to finish.');
    const on = await post(true);
    assert.equal(on.status, 409);
    assert.equal(on.body.error, failure.message);
    assert.equal(await stored(), false);
});
//# sourceMappingURL=settingsOtherSlot.test.js.map