import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SuggestionRow } from '@api/rhythmsSchema';
import SuggestionCard from './SuggestionCard';

const evidence = { firstNight: '2026-10-03', lastNight: '2026-10-15', supportingDates: ['2026-10-15'] };
const down: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', supporting: 9, ...evidence, time: '23:45', temperatureF: 79, plannedF: 82,
  thenBack: { time: '04:00', temperatureF: 82, supporting: 8 },
};
const up: SuggestionRow = {
  kind: 'step', key: 'step:up', direction: 'up', supporting: 7, ...evidence, time: '04:00', temperatureF: 84, plannedF: 82,
};

it('names every setting Add writes, with the count behind each, and offers a review', async () => {
  const onReview = vi.fn();
  const { container } = render(<SuggestionCard
    name="Off days"
    entry={ { rhythmId: 'off-days', near: false, rows: [down] } }
    counted={ 14 }
    format="fahrenheit"
    onReview={ onReview }/>);
  expect(screen.getByText('Suggestion from your changes')).toBeInTheDocument();
  expect(screen.getByText('Off days: 79°F at 11:45 PM, back to 82°F at 4:00 AM')).toBeInTheDocument();
  expect(screen.getByText('From 9 of 14 nights')).toBeInTheDocument();
  const review = screen.getByRole('button', { name: 'Review suggestion for Off days' });
  expect(review).toHaveTextContent('Review');
  expect(review).toHaveAttribute('data-review', 'off-days');
  expect(container.querySelector('svg')).toBeNull();
  await userEvent.click(review);
  expect(onReview).toHaveBeenCalledOnce();
});

it('puts two rows on one card, each with its own count', () => {
  render(<SuggestionCard
    name="Off days"
    entry={ { rhythmId: 'off-days', near: false, rows: [{ ...down, thenBack: undefined, time: '00:30' }, up] } }
    counted={ 14 }
    format="fahrenheit"
    onReview={ () => {} }/>);
  expect(screen.getByText('Off days')).toBeInTheDocument();
  expect(screen.getByText('79°F at 12:30 AM · 9 of 14 nights')).toBeInTheDocument();
  expect(screen.getByText('84°F at 4:00 AM · 7 of 14 nights')).toBeInTheDocument();
  expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
});
