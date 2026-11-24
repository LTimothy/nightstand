import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-other-slot-'))}/`;
process.env.ENV = 'local';
const { applyOtherSlot, syncOtherSlot } = await import('./otherSlot.js');
const hold = async (work) => work();
function recorder(failing = []) {
    const calls = [];
    const run = async (action) => {
        calls.push(action);
        if (failing.includes(action))
            throw new Error(`${action} failed`);
    };
    return { calls, run };
}
describe('syncOtherSlot', () => {
    it('runs nothing when the switch is off', async () => {
        const t = recorder();
        await syncOtherSlot(false, t.run, hold);
        assert.deepEqual(t.calls, []);
    });
    it('only checks a slot that is already prepared', async () => {
        const t = recorder();
        await syncOtherSlot(true, t.run, hold);
        assert.deepEqual(t.calls, ['status']);
    });
    it('prepares the slot again when the check fails', async () => {
        const t = recorder(['status']);
        await syncOtherSlot(true, t.run, hold);
        assert.deepEqual(t.calls, ['status', 'access']);
    });
    it('never throws when preparing fails', async () => {
        const t = recorder(['status', 'access']);
        await assert.doesNotReject(syncOtherSlot(true, t.run, hold));
        assert.deepEqual(t.calls, ['status', 'access']);
    });
});
describe('applyOtherSlot', () => {
    it('prepares or puts back under the hold, and passes failures on', async () => {
        const t = recorder(['undo']);
        let held = 0;
        const counting = async (work) => { held += 1; return work(); };
        await applyOtherSlot(true, t.run, counting);
        await assert.rejects(applyOtherSlot(false, t.run, counting), /undo failed/);
        assert.deepEqual(t.calls, ['access', 'undo']);
        assert.equal(held, 2);
    });
});
//# sourceMappingURL=otherSlot.test.js.map