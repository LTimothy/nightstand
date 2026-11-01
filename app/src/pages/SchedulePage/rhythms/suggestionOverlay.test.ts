import { describe, expect, it } from 'vitest';
import type { SuggestionRow, SuggestionVote } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { suggestionOverlay, unusualDates } from './suggestionOverlay';

const vote = (date: string, offsetMin: number, temperatureF: number): SuggestionVote => ({ date, offsetMin, temperatureF });
const votes = [vote('2026-10-24', 237, 78), vote('2026-10-26', 129, 65), vote('2026-10-27', 135, 76), vote('2026-10-31', 185, 77)];

const rhythm = structuredClone(createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right.rhythms['off-days']);
rhythm.night.power = { ...rhythm.night.power, on: '20:00', off: '07:00', onTemperature: 79 };
rhythm.night.temperatures = { '02:00': 79, '03:00': 80, '04:00': 81 };
const row = (over: Partial<Extract<SuggestionRow, { kind: 'step' }>> = {}): SuggestionRow => ({
  kind: 'step', key: 'k', direction: 'down', supporting: 4, firstNight: '2026-10-24', lastNight: '2026-10-31',
  supportingDates: votes.map(v => v.date), votes, time: '22:15', temperatureF: 77, plannedF: 79, ...over,
});

describe('unusualDates', () => {
  it('marks the night far from the others', () => expect(unusualDates(votes)).toEqual(['2026-10-26']));
  it('marks none without that night', () => expect(unusualDates(votes.filter(v => v.date !== '2026-10-26'))).toEqual([]));
  it('needs three votes', () => expect(unusualDates(votes.slice(0, 2))).toEqual([]));
  it('does not mark exactly 5°F off', () => {
    expect(unusualDates([vote('a', 0, 80), vote('b', 0, 80), vote('c', 0, 75)])).toEqual([]);
  });
});

describe('suggestionOverlay', () => {
  it('models the live case', () => {
    const model = suggestionOverlay(rhythm, [row()], 'fahrenheit');
    expect(model).toMatchObject({ endMin: 660, loF: 75, hiF: 85, ticks: [135, 660] });
    expect(model.blocks).toEqual([{ from: 135, to: 360, f: 77, farF: 79, schedule: [{ x: 135, f: 79 }], turned: 'down' }]);
    expect(model.dots).toEqual([
      { x: 237, f: 78, key: '2026-10-24' },
      { x: 129, f: 75, key: '2026-10-26', edge: 'bottom', label: '65°F' },
      { x: 135, f: 76, key: '2026-10-27' },
      { x: 185, f: 77, key: '2026-10-31' },
    ]);
  });
  it('labels an edge dot in the user\'s unit', () => {
    expect(suggestionOverlay(rhythm, [row()], 'level').dots[1].label).toBe('\u22126');
  });
  it('draws the start once for an on row', () => {
    const on: SuggestionRow = {
      kind: 'on', key: 'on:down', direction: 'down', supporting: 4, firstNight: '2026-10-24', lastNight: '2026-10-31',
      supportingDates: [], temperatureF: 77, plannedF: 79,
    };
    expect(suggestionOverlay(rhythm, [on], 'fahrenheit').ticks).toEqual([0, 660]);
  });
  it('drops the power-off label beside a late step', () => {
    expect(suggestionOverlay(rhythm, [row({ time: '06:00', temperatureF: 77, plannedF: 81 })], 'fahrenheit').ticks).toEqual([0, 600]);
  });
  it('draws no dots for a row without votes', () => {
    expect(suggestionOverlay(rhythm, [row({ votes: undefined })], 'fahrenheit').dots).toEqual([]);
  });
});
