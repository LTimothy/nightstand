import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-swap-run-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { runSideSwap, SwapRefused } = await import('./swapSidesRun.js');
const { default: settingsDB } = await import('../db/settings.js');
const { holdJobRebuilds, setRebuildRelease } = await import('./rebuildState.js');
function fakes(reasons = [], pausedSide, expiresAt = '2099-01-01T00:00:00Z') {
    const calls = [];
    const settings = structuredClone(settingsDB.data);
    if (pausedSide)
        settings[pausedSide].scheduleOverrides.pause = { active: true, expiresAt };
    return { calls, deps: {
            inUse: async () => reasons,
            settings: async () => settings,
            holdOperations: async (work) => { calls.push('hold'); return work(); },
            holdJobRebuilds: async (work) => { calls.push('rebuilds held'); return work(); },
            swap: async () => { calls.push('swap'); },
            resume: async (side) => { calls.push(`resume ${side}`); },
            lastSwap: () => undefined,
            now: () => 1_000_000,
        } };
}
describe('runSideSwap', () => {
    it('swaps under both holds, then resumes both sides', async () => {
        const t = fakes();
        await runSideSwap(t.deps);
        assert.deepEqual(t.calls, ['hold', 'rebuilds held', 'swap', 'resume left', 'resume right']);
    });
    it('answers without waiting for a side to resume', async () => {
        const t = fakes();
        const swapped = runSideSwap({ ...t.deps, resume: () => new Promise(() => { }) }).then(() => 'done');
        const late = new Promise(resolve => setTimeout(() => resolve('waited'), 50));
        assert.equal(await Promise.race([swapped, late]), 'done');
    });
    for (const [reasons, message] of [
        [['left-on'], /both sides off/],
        [['status-unknown'], /cannot read the bed/],
        [['alarm-soon'], /alarm is due/],
    ]) {
        it(`refuses without swapping for ${reasons.join(', ')}`, async () => {
            const t = fakes(reasons);
            await assert.rejects(runSideSwap(t.deps), error => error instanceof SwapRefused && message.test(error.message));
            assert.deepEqual(t.calls, ['hold']);
        });
    }
    it('refuses a second swap within a minute, so a retry after a lost answer does not undo the first', async () => {
        const t = fakes();
        await assert.rejects(runSideSwap({ ...t.deps, lastSwap: () => 1_000_000 - 30 }), /swapped a moment ago/);
        assert.deepEqual(t.calls, ['hold']);
        await runSideSwap({ ...t.deps, lastSwap: () => 1_000_000 - 61 });
        assert.ok(t.calls.includes('swap'));
    });
    it('refuses while a pause flag is still set after its end time', async () => {
        const t = fakes([], 'left', '2000-01-01T00:00:00Z');
        await assert.rejects(runSideSwap(t.deps), /End the pause/);
    });
    it('refuses while a side is paused', async () => {
        const t = fakes([], 'right');
        await assert.rejects(runSideSwap(t.deps), /End the pause/);
        assert.deepEqual(t.calls, ['hold']);
    });
});
describe('holdJobRebuilds', () => {
    it('releases once, after the work', async () => {
        const order = [];
        setRebuildRelease(async () => { order.push('rebuild'); });
        await holdJobRebuilds(async () => { order.push('work'); });
        assert.deepEqual(order, ['work', 'rebuild']);
    });
});
//# sourceMappingURL=swapSidesRun.test.js.map