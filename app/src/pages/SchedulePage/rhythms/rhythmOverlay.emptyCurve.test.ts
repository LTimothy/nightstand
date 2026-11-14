import { describe, expect, it, vi } from 'vitest';
import type { NightLog } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { rhythmOverlay } from './rhythmOverlay';

// Saved power times always give a curve, so an empty one is stubbed in.
vi.mock('./smartPreview', async original => {
  const actual = await original<typeof import('./smartPreview')>();
  return {
    ...actual,
    previewCurves: (input: Parameters<typeof actual.previewCurves>[0]) => ({ ...actual.previewCurves(input), points: [], series: [] }),
  };
});

describe('a Smart rhythm card with an empty curve', () => {
  it('draws no blocks and never throws, with hand changes in the nights', () => {
    const workday = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).left.rhythms.workday;
    const log: NightLog[] = Array.from({ length: 5 }, (_, index) => {
      const date = `2026-09-${10 + index}`;
      const on = Date.parse(`${date}T22:30:00.000Z`);
      return {
        date, rhythmId: 'workday', tonight: false, excluded: false, samePlan: true, start: new Date(on).toISOString(), endMin: 495,
        plan: [{ offsetMin: 0, temperatureF: 80 }],
        changes: [{ at: new Date(on + 15 * 60_000).toISOString(), fromF: 80, targetF: 90, plannedF: 80, held: false, source: 'api' }],
      };
    });
    const overlay = () => rhythmOverlay({ rhythm: workday, log, today: '2026-10-12', timeZone: 'UTC', trackingOn: false });
    expect(overlay).not.toThrow();
    expect(overlay()).toMatchObject({ plan: [], nights: 5, blocks: [] });
  });
});
