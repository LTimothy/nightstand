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
describe('otherSlotSupported', async () => {
    const config = (await import('../config.js')).default;
    const { PrivilegedCommandError } = await import('./privilegedCommand.js');
    let fresh = 0;
    // A fresh module each time, so each test starts with nothing cached.
    const load = async () => {
        config.remoteDevMode = false;
        fresh += 1;
        return (await import(`./otherSlot.js?fresh=${fresh}`)).otherSlotSupported;
    };
    const counted = (fail) => {
        const calls = [];
        const run = async () => { calls.push(1); if (fail)
            throw fail; };
        return { calls, run };
    };
    it('caches a supported slot', async () => {
        const supported = await load();
        const t = counted();
        assert.equal(await supported(t.run), true);
        assert.equal(await supported(t.run), true);
        assert.equal(t.calls.length, 1);
    });
    it('caches an unsupported slot', async () => {
        const supported = await load();
        const t = counted(new PrivilegedCommandError('Unable to start systemd-journald.service.'));
        assert.equal(await supported(t.run), false);
        assert.equal(await supported(t.run), false);
        assert.equal(t.calls.length, 1);
    });
    it('asks again when the sudo rule is not there yet', async () => {
        const supported = await load();
        const t = counted(new PrivilegedCommandError('Cannot run systemd-journald.service: its service or sudo permission is missing.'));
        assert.equal(await supported(t.run), null);
        assert.equal(await supported(t.run), null);
        assert.equal(t.calls.length, 2);
    });
    it('answers null in remote dev mode without running anything', async () => {
        const supported = await load();
        config.remoteDevMode = true;
        const t = counted();
        assert.equal(await supported(t.run), null);
        assert.equal(t.calls.length, 0);
    });
});
//# sourceMappingURL=otherSlot.test.js.map