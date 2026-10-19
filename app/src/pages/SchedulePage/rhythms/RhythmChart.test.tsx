import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NightLog } from '@api/rhythmsSchema';
import { palette } from '@design/tokens';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { fahrenheitToDisplay } from '@lib/temperatureConversions';
import RhythmChart from './RhythmChart';
import { BLOCK_OPACITY, rhythmOverlay } from './rhythmOverlay';

const offDays = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right.rhythms['off-days'];
const at = (date: string, hours: number) => new Date(Date.parse(`${date}T23:00:00.000Z`) + hours * 3_600_000).toISOString();
const night = (date: string, changes: NightLog['changes'] = []): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, samePlan: true, start: at(date, 0), endMin: 480,
  plan: [{ offsetMin: 0, temperatureF: 82 }, { offsetMin: 240, temperatureF: 79 }], changes,
  sets: [{ at: at(date, 0), temperatureF: 82 }, { at: at(date, 4), temperatureF: 79 }, { at: at(date, 8), temperatureF: null }],
});
const change = (date: string, hours: number, targetF: number, fromF = 82) =>
  ({ at: at(date, hours), fromF, targetF, plannedF: 82, held: false, source: 'api' as const });
const dates = Array.from({ length: 6 }, (_, index) => `2026-10-0${index + 1}`);
const draw = (log: NightLog[], format: 'fahrenheit' | 'level' = 'fahrenheit') => render(<RhythmChart
  rhythm={ offDays }
  log={ log }
  today="2026-10-12"
  timeZone="UTC"
  format={ format }
  trackingOn={ false }
  captionId="caption"/>);
const path = (container: HTMLElement, selector: string) => container.querySelector(selector);

describe('the chart on a rhythm card', () => {
  it('draws the schedule as one line with its labels, hidden from screen readers, and no sentence before a first night', () => {
    const { container } = draw([]);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const schedule = path(container, '[data-schedule]');
    expect(schedule?.getAttribute('d')).toMatch(/^M 0 /);
    expect(schedule).toHaveAttribute('stroke', palette.step.plan);
    expect(schedule).toHaveAttribute('stroke-width', '2');
    expect(schedule).toHaveAttribute('fill', 'none');
    expect(container.querySelectorAll('path')).toHaveLength(1);
    // The middle of 75 and 86 is 80.5, which rounds to 81.
    for (const label of ['86°F', '81', '75', '11:00 PM', '3:00 AM', '7:00 AM']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(document.getElementById('caption')).toBeEmptyDOMElement();
  });

  it('draws where a typical night differs as a tinted block with a dashed edge, its value inside, and says so', () => {
    const log = dates.map((date, index) => night(date, index < 4 ? [change(date, 0.75, 79), change(date, 6.5, 84, 79)] : []));
    const { container } = draw(log);
    const blocks = [...container.querySelectorAll('[data-block]')];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveAttribute('fill', palette.step.cool);
    expect(blocks[0]).toHaveAttribute('fill-opacity', String(BLOCK_OPACITY));
    // From 11:45 PM to 3:00 AM, between 79 and 82: a rectangle closed on the schedule.
    expect(blocks[0].getAttribute('d')).toBe('M 9.38 63.64 H 50 V 36.36 H 9.38 Z');
    expect(blocks[1]).toHaveAttribute('fill', palette.step.warm);
    const edges = [...container.querySelectorAll('[data-typical]')];
    expect(edges[0]).toHaveAttribute('stroke', palette.step.cool);
    expect(edges[0]).toHaveAttribute('stroke-dasharray', '3 2');
    expect(edges[0].getAttribute('d')).toBe('M 9.38 36.36 V 63.64 H 50');
    // The schedule sits between the blocks and their edges, so the dashes show where they cross it.
    const order = [...container.querySelectorAll('path')].map(element => element.getAttributeNames().find(name => name.startsWith('data-')));
    expect(order).toEqual(['data-block', 'data-block', 'data-schedule', 'data-typical', 'data-typical']);
    const labels = [...container.querySelectorAll('[data-block-label]')];
    expect(labels.map(label => label.textContent)).toEqual(['79°F', '84°F']);
    expect(labels[0]).toHaveAttribute('aria-hidden', 'true');
    expect(document.getElementById('caption'))
      .toHaveTextContent('On half or more nights you turned it down to 79°F around 11:45 PM and up to 84°F around 5:30 AM.');
  });

  it('prints no value in a block too narrow or too flat for it', () => {
    const narrow = dates.map(date => night(date, [change(date, 7.25, 84, 79)]));
    expect(draw(narrow).container.querySelectorAll('[data-block-label]')).toHaveLength(0);
    // 83 and 82 share a level, so the block has no height in level format and the sentence says both in °F.
    const flat = dates.map(date => night(date, [change(date, 0.75, 83)]));
    const { container } = draw(flat, 'level');
    expect(container.querySelectorAll('[data-block]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-block-label]')).toHaveLength(0);
    expect(screen.getByText('On half or more nights you turned it up to 83°F around 11:45 PM.')).toBeInTheDocument();
  });

  it('prints no value where a schedule step runs through the middle of the block', () => {
    // 85 is held all night, so the block spans the 4 AM step and its middle sits next to it.
    const held = dates.map(date => ({ ...night(date), sets: [
      { at: at(date, 0), temperatureF: 82 }, { at: at(date, 0.75), temperatureF: 85 }, { at: at(date, 8), temperatureF: null },
    ] }));
    const { container } = draw(held);
    expect(container.querySelectorAll('[data-block]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-block-label]')).toHaveLength(0);
  });

  it('says the nights match when nothing differs, and counts them before there are five', () => {
    draw(dates.map(date => night(date)));
    expect(document.getElementById('caption')).toHaveTextContent('Your nights match the schedule.');
    expect(document.querySelectorAll('[data-block]')).toHaveLength(0);
    draw(dates.slice(0, 2).map(date => night(date, [change(date, 0.75, 79)])));
    expect(screen.getByText('2 nights so far.')).toBeInTheDocument();
  });

  it('plots in display units, so a level label sits where its value is drawn', () => {
    const { container } = draw([], 'level');
    const { loF, hiF, plan } = rhythmOverlay({ rhythm: offDays, log: [], today: '2026-10-12', timeZone: 'UTC', trackingOn: false });
    const [lo, hi] = [loF, hiF].map(f => fahrenheitToDisplay(f, 'level'));
    const drawn = Number(path(container, '[data-schedule]')?.getAttribute('d')?.match(/^M \S+ (\S+)/)?.[1]);
    expect(drawn).toBeCloseTo(((hi - fahrenheitToDisplay(plan[0].f, 'level')) / (hi - lo)) * 100, 1);
    // The middle label is the level halfway between the ends, drawn halfway down.
    expect(screen.getByText(String(Math.round((lo + hi) / 2)))).toBeInTheDocument();
  });
});
