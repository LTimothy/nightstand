import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import RhythmList from './RhythmList';

const left = createDemoRhythms(new Date('2026-09-28T19:00:00Z')).left;

it('describes each rhythm and opens it', async () => {
  const onOpen = vi.fn();
  const { user } = renderWithProviders(<RhythmList
    sideData={ left }
    today="2026-09-28"
    disabled={ false }
    onOpen={ onOpen }
    onNew={ () => {} }
    onUse={ () => {} }/>);
  const workday = screen.getByRole('button', { name: 'Edit Workday' });
  expect(workday).toHaveTextContent('10:30 PM to 6:45 AM · Smart Schedule');
  expect(workday).toHaveTextContent('Used on Sun to Thu');
  await user.click(workday);
  expect(onOpen).toHaveBeenCalledWith('workday');
});

it('stops at twelve rhythms per side', () => {
  const rhythms = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
    [`r-${index}`, { ...left.rhythms.weekend, id: `r-${index}`, name: `Rhythm ${index}` }]));
  renderWithProviders(<RhythmList
    sideData={ { ...left, rhythms } }
    today="2026-09-28"
    disabled={ false }
    onOpen={ () => {} }
    onNew={ () => {} }
    onUse={ () => {} }/>);
  expect(screen.getByRole('button', { name: 'New rhythm' })).toBeDisabled();
  expect(screen.getByText('A side can have up to 12 rhythms.')).toBeInTheDocument();
});

it('draws each rhythm\'s nights inside its card and describes the card by the caption', () => {
  // Workday powers on at 22:30; the chart works in UTC here.
  const night = {
    date: '2026-09-27', rhythmId: 'workday', tonight: false, excluded: false, samePlan: true, start: '2026-09-27T22:30:00.000Z',
    plan: [{ offsetMin: 0, temperatureF: 83 }], endMin: 495, changes: [],
    sets: [{ at: '2026-09-27T22:30:00.000Z', temperatureF: 80 }, { at: '2026-09-28T06:45:00.000Z', temperatureF: null }],
  };
  renderWithProviders(<RhythmList
    sideData={ left }
    today="2026-09-28"
    disabled={ false }
    chart={ { log: [night], timeZone: 'UTC', format: 'fahrenheit', trackingOn: false } }
    onOpen={ () => {} }
    onNew={ () => {} }
    onUse={ () => {} }/>);
  const workday = screen.getByRole('button', { name: 'Edit Workday' });
  expect(workday).toHaveAccessibleDescription(expect.stringContaining('Blue is tonight\'s curve. White is last night, 1 night so far.'));
  expect(workday).toHaveAccessibleDescription(expect.stringContaining('Last night: 80°F at 10:30 PM, off at 6:45 AM.'));
  expect(workday.querySelector('[data-schedule]')).not.toBeNull();
  expect(workday.querySelectorAll('[data-night]')).toHaveLength(1);
  const weekend = screen.getByRole('button', { name: 'Edit Weekend' });
  expect(weekend.querySelector('[data-schedule]')).not.toBeNull();
  expect(weekend.querySelectorAll('[data-night]')).toHaveLength(0);
  expect(weekend).not.toHaveAccessibleDescription();
});

it('keeps the cards without a chart while suggestions are off', () => {
  const { container } = renderWithProviders(<RhythmList
    sideData={ left }
    today="2026-09-28"
    disabled={ false }
    onOpen={ () => {} }
    onNew={ () => {} }
    onUse={ () => {} }/>);
  expect(container.querySelector('svg[aria-hidden="true"] [data-schedule]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Edit Workday' })).not.toHaveAttribute('aria-describedby');
});
