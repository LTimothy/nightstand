import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-side-swaps-'))}/`;
process.env.ENV = 'local';
const { loadSideSwaps, personWhere, physicalSide } = await import('./sideSwaps.js');

describe('personWhere', () => {
  it('filters by side alone with no swaps', () => {
    assert.deepEqual(personWhere('left', 'timestamp', []), { side: 'left' });
  });

  it('adds nothing without a side', () => {
    assert.deepEqual(personWhere(undefined, 'timestamp', [100]), {});
  });

  it('splits at one swap', () => {
    assert.deepEqual(personWhere('left', 'timestamp', [100]), { OR: [
      { side: 'right', timestamp: { lt: 100 } },
      { side: 'left', timestamp: { gte: 100 } },
    ] });
  });

  it('returns to the first side after two swaps', () => {
    assert.deepEqual(personWhere('left', 'entered_bed_at', [100, 200]), { OR: [
      { side: 'left', entered_bed_at: { lt: 100 } },
      { side: 'right', entered_bed_at: { gte: 100, lt: 200 } },
      { side: 'left', entered_bed_at: { gte: 200 } },
    ] });
  });
});

describe('physicalSide', () => {
  it('counts a time at the swap as after it', () => {
    assert.equal(physicalSide('left', 100, [100]), 'left');
    assert.equal(physicalSide('left', 99, [100]), 'right');
    assert.equal(physicalSide('right', 50, [100, 200]), 'right');
  });
});

describe('loadSideSwaps', () => {
  const file = (text?: string) => {
    const at = path.join(mkdtempSync(path.join(tmpdir(), 'swaps-')), 'side-swaps.json');
    if (text !== undefined) writeFileSync(at, text);
    return at;
  };

  it('reads nothing from a missing or invalid file', () => {
    assert.deepEqual(loadSideSwaps(file()), []);
    assert.deepEqual(loadSideSwaps(file('"x"')), []);
    assert.deepEqual(loadSideSwaps(file('[1, "a"]')), []);
  });

  it('sorts the times', () => {
    assert.deepEqual(loadSideSwaps(file('[200, 100]')), [100, 200]);
  });
});
