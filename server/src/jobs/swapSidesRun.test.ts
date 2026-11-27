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

const NOW = new Date('2026-11-27T12:00:00Z');
function fakes(reasons: InUseReason[] = [], pausedSide?: 'left' | 'right') {
  const calls: string[] = [];
  const settings = structuredClone(settingsDB.data);
  if (pausedSide) settings[pausedSide].scheduleOverrides.pause = { active: true, expiresAt: '2026-11-28T00:00:00Z' };
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
    await runSideSwap(t.deps, NOW);
    assert.deepEqual(t.calls, ['hold', 'rebuilds held', 'swap', 'resume left', 'resume right']);
  });

  for (const [reasons, message] of [
    [['left-on'], /both sides off/],
    [['status-unknown'], /both sides off/],
    [['alarm-soon'], /alarm is due/],
  ] as Array<[InUseReason[], RegExp]>) {
    it(`refuses without swapping for ${reasons.join(', ')}`, async () => {
      const t = fakes(reasons);
      await assert.rejects(runSideSwap(t.deps, NOW), error => error instanceof SwapRefused && message.test(error.message));
      assert.deepEqual(t.calls, ['hold']);
    });
  }

  it('refuses while a side is paused', async () => {
    const t = fakes([], 'right');
    await assert.rejects(runSideSwap(t.deps, NOW), /End the pause/);
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
