import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NightLog } from '@api/rhythmsSchema';
import { palette } from '@design/tokens';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import RhythmChart from './RhythmChart';

const offDays = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right.rhythms['off-days'];
const at = (date: string, hours: number) => new Date(Date.parse(`${date}T23:00:00.000Z`) + hours * 3_600_000).toISOString();
const night = (date: string, over: Partial<NightLog> = {}): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, samePlan: true, start: at(date, 0), endMin: 480,
  plan: [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }], changes: [],
  sets: [{ at: at(date, 0), temperatureF: 82 }, { at: at(date, 4), temperatureF: 79 }, { at: at(date, 8), temperatureF: null }], ...over,
});
const draw = (log: NightLog[]) => render(<RhythmChart
  rhythm={ offDays }
  log={ log }
  today="2026-10-12"
  timeZone="UTC"
  format="fahrenheit"
  trackingOn={ false }
  captionId="caption"/>);
const path = (container: HTMLElement, selector: string) => container.querySelector(selector);

describe('the chart on a rhythm card', () => {
  it('draws the schedule in the step colour on top, hidden from screen readers, with three labels each way', () => {
    const { container } = draw([]);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const schedule = path(container, '[data-schedule]');
    expect(schedule?.getAttribute('d')).toMatch(/^M 0 /);
    expect(schedule).toHaveAttribute('stroke', palette.step.cool);
    expect(container.querySelector('svg')?.lastElementChild).toBe(schedule);
    // The middle of 75 and 86 is 80.5, which rounds to 81.
    for (const label of ['86°F', '81', '75', '11:00 PM', '3:00 AM', '7:00 AM']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/^Blue is/)).toBeNull();
  });

  it('draws the nights in white, last night strongest, and captions the count', () => {
    const log = [
      night('2026-10-10', { changes: [{ at: at('2026-10-10', 0.75), fromF: 82, targetF: 81, plannedF: 82, held: false, source: 'api' }] }),
      night('2026-10-09', { samePlan: false, plan: [] }),
      night('2026-10-08'),
    ];
    const { container } = draw(log);
    const nights = [...container.querySelectorAll('[data-night]')];
    expect(nights.map(line => line.getAttribute('data-night'))).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    const last = path(container, '[data-night="2026-10-10"]');
    expect(last).toHaveAttribute('stroke', palette.text.primary);
    expect(last).toHaveAttribute('stroke-opacity', '1');
    expect(last).toHaveAttribute('stroke-width', '2');
    // The dimmest step is 40 percent, the least that keeps a 3:1 line on the card in every look.
    expect(path(container, '[data-night="2026-10-09"]')).toHaveAttribute('stroke-opacity', '0.4');
    expect(path(container, '[data-night="2026-10-08"]')).toHaveAttribute('stroke-opacity', '0.6');
    expect(path(container, '[data-night="2026-10-08"]')).toHaveAttribute('stroke-width', '1');
    const caption = document.getElementById('caption');
    expect(caption).toHaveTextContent('Blue is your schedule. White lines are the last 3 nights, brighter is more recent.');
    expect(caption).toHaveTextContent('Last night: 82°F, then 81°F at 11:45 PM, then 79°F at 3:00 AM, off at 7:00 AM.');
  });

  it('dims the eighth night and older', () => {
    const log = Array.from({ length: 9 }, (_, index) => night(`2026-10-0${index + 1}`));
    const { container } = draw(log);
    expect(path(container, '[data-night="2026-10-03"]')).toHaveAttribute('stroke-opacity', '0.6');
    expect(path(container, '[data-night="2026-10-02"]')).toHaveAttribute('stroke-opacity', '0.4');
  });

  it('says so with one night', () => {
    draw([night('2026-10-10')]);
    expect(document.getElementById('caption')).toHaveTextContent('Blue is your schedule. White is last night, 1 night so far.');
  });
});
