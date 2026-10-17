import { expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SuggestionsResponse } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import SuggestionsSection from './SuggestionsSection';

const left = createDemoRhythms(new Date('2026-09-28T19:00:00Z')).left;
const data: SuggestionsResponse = {
  enabled: true,
  nights: {
    workday: { counted: 3, needed: 5, changed: 0, earlier: false, reason: 'few-nights' },
    weekend: { counted: 14, needed: 5, changed: 0, earlier: false, reason: 'no-change' },
  },
  suggestions: [],
  dismissed: [],
  log: [{
    date: '2026-09-27', rhythmId: 'weekend', tonight: false, excluded: false,
    plan: [{ offsetMin: 0, temperatureF: 80 }], endMin: 555, changes: [],
  }],
};
const query = (over: Partial<Parameters<typeof SuggestionsSection>[0]['suggestions']> = {}) =>
  ({ data, error: null, isError: false, refetch: vi.fn(), ...over }) as Parameters<typeof SuggestionsSection>[0]['suggestions'];
const show = (props: Partial<Parameters<typeof SuggestionsSection>[0]> = {}) => render(<SuggestionsSection
  sideData={ left }
  suggestions={ query() }
  away={ false }
  onShowNotes={ () => {} }
  { ...props }/>);

it('explains the rule and gives one line per rhythm', () => {
  show();
  expect(screen.getByRole('region', { name: 'Suggestions' })).toBeInTheDocument();
  expect(screen.getByText(/^Nightstand notes changes you make by hand during a rhythm\./)).toBeInTheDocument();
  expect(screen.getByText('Workday: 3 of 5 nights so far')).toBeInTheDocument();
  expect(screen.getByText('Weekend: no changes in 14 nights')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

it('leaves out a rhythm it has no counts for', () => {
  show({ suggestions: query({ data: { ...data, nights: { workday: data.nights.workday } } }) });
  expect(screen.queryByText(/^Weekend:/)).not.toBeInTheDocument();
});

it('says when the side is away', () => {
  show({ away: true });
  expect(screen.getByText('Away. Counting resumes when this side is back.')).toBeInTheDocument();
});

it('opens the notes only when there are nights to show', async () => {
  const onShowNotes = vi.fn();
  const { unmount } = show({ onShowNotes });
  await userEvent.click(screen.getByRole('button', { name: 'Show the nights' }));
  expect(onShowNotes).toHaveBeenCalledOnce();
  unmount();
  show({ suggestions: query({ data: { ...data, log: [] } }) });
  expect(screen.queryByRole('button', { name: 'Show the nights' })).not.toBeInTheDocument();
});

it('keeps the heading while loading and offers to try again after a failure', async () => {
  const { unmount } = show({ suggestions: query({ data: undefined }) });
  expect(screen.getByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
  expect(screen.queryByText(/^Nightstand notes/)).not.toBeInTheDocument();
  unmount();
  const refetch = vi.fn();
  show({ suggestions: query({ data: undefined, isError: true, error: new Error('down'), refetch }) });
  expect(screen.getByText('Could not load suggestions.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(refetch).toHaveBeenCalledOnce();
});

it('shows nothing for an older Pod without suggestions, or with them off', () => {
  const missing = new AxiosError('Not found', '404', undefined, undefined, { status: 404 } as AxiosResponse);
  const { container, unmount } = show({ suggestions: query({ data: undefined, isError: true, error: missing }) });
  expect(container).toBeEmptyDOMElement();
  unmount();
  const off = show({ suggestions: query({ data: { ...data, enabled: false } }) });
  expect(off.container).toBeEmptyDOMElement();
});
