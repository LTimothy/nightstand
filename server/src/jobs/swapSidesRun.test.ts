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
import type { InUseReason } from './bedInUse.js';

function fakes(reasons: InUseReason[] = [], pausedSide?: 'left' | 'right', expiresAt = '2099-01-01T00:00:00Z') {
  const calls: string[] = [];
  const settings = structuredClone(settingsDB.data);
  if (pausedSide) settings[pausedSide].scheduleOverrides.pause = { active: true, expiresAt };
  return { calls, deps: {
    inUse: async () => reasons,
    settings: async () => settings,
    holdOperations: async <T>(work: () => Promise<T>) => { calls.push('hold'); return work(); },
    holdJobRebuilds: async <T>(work: () => Promise<T>) => { calls.push('rebuilds held'); return work(); },
    swap: async () => { calls.push('swap'); },
    resume: async (side: string) => { calls.push(`resume ${side}`); },
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
    const swapped = runSideSwap({ ...t.deps, resume: () => new Promise<void>(() => {}) }).then(() => 'done');
    const late = new Promise(resolve => setTimeout(() => resolve('waited'), 50));
    assert.equal(await Promise.race([swapped, late]), 'done');
  });

  for (const [reasons, message] of [
    [['left-on'], /both sides off/],
    [['status-unknown'], /both sides off/],
    [['alarm-soon'], /alarm is due/],
  ] as Array<[InUseReason[], RegExp]>) {
    it(`refuses without swapping for ${reasons.join(', ')}`, async () => {
      const t = fakes(reasons);
      await assert.rejects(runSideSwap(t.deps), error => error instanceof SwapRefused && message.test(error.message));
      assert.deepEqual(t.calls, ['hold']);
    });
  }

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
    const order: string[] = [];
    setRebuildRelease(async () => { order.push('rebuild'); });
    await holdJobRebuilds(async () => { order.push('work'); });
    assert.deepEqual(order, ['work', 'rebuild']);
  });

  it('releases once for nested holds', async () => {
    let rebuilds = 0;
    setRebuildRelease(async () => { rebuilds += 1; });
    await holdJobRebuilds(() => holdJobRebuilds(async () => {}));
    assert.equal(rebuilds, 1);
  });
});
