import assert from 'node:assert/strict';
import { beforeEach, it, mock } from 'node:test';
import fs from 'node:fs';
const requestFile = '/persistent/free-sleep-data/operation-request.json';
const writes = [];
const deletes = [];
let busy = false;
let failedStart = false;
let failedWrite = false;
let starts = 0;
mock.method(fs.promises, 'writeFile', async (...[path, content]) => {
    assert.equal(path, requestFile);
    if (failedWrite)
        throw new Error('read-only');
    writes.push(JSON.parse(String(content)));
});
mock.method(fs.promises, 'unlink', async (...[path]) => { deletes.push(path); });
mock.module('./privilegedCommand.js', { namedExports: {
        runPrivilegedCommand: async (_args, _unit, hooks) => {
            if (busy)
                throw new Error('already running');
            try {
                await hooks.beforeStart?.();
                if (failedStart)
                    throw new Error('start failed');
                starts++;
            }
            catch (error) {
                await hooks.onStartFailure?.();
                throw error;
            }
        },
    } });
const { triggerRevertToStockService } = await import('./revertToStock.js');
const target = { commit: 'a'.repeat(40), version: '3.0.3', treeSha256: 'b'.repeat(64), date: '2026-10-07' };
const start = (hooks = {}, confirmed = target) => triggerRevertToStockService(hooks, { target: confirmed, confirmInUse: true });
beforeEach(() => { writes.length = 0; deletes.length = 0; busy = false; failedStart = false; failedWrite = false; starts = 0; });
it('persists the confirmed switch record with the bed-use request inside admission', async () => {
    await start({ beforeStart: async () => {
            await fs.promises.writeFile(requestFile, JSON.stringify({ source: 'app', confirmInUse: true }));
        } }, target);
    assert.deepEqual(writes.at(-1), { source: 'app', confirmInUse: true, target });
    assert.equal(starts, 1);
});
it('refuses a confirmed switch when its target cannot be saved', async () => {
    failedWrite = true;
    await assert.rejects(start({}, target), /read-only/);
    assert.equal(starts, 0);
});
it('does not overwrite the running switch target on an admission refusal', async () => {
    busy = true;
    await assert.rejects(start({}, target), /already running/);
    assert.deepEqual(writes, []);
    assert.deepEqual(deletes, []);
});
it('removes a confirmed target when the service start fails', async () => {
    failedStart = true;
    await assert.rejects(start({}, target), /start failed/);
    assert.deepEqual(deletes, [requestFile]);
});
//# sourceMappingURL=revertToStockTarget.test.js.map