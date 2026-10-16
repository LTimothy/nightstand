import { expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import type { NightLog, SuggestionsResponse } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import NotesSheet from './NotesSheet';

const right = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right;
const plan = [{ offsetMin: 0, temperatureF: 82 }];
const night = (date: string, over: Partial<NightLog> = {}): NightLog => ({
  date, rhythmId: 'off-days', tonight: false, excluded: false, plan, endMin: 480, changes: [], ...over,
});
const data: SuggestionsResponse = {
  enabled: true,
  nights: {
    'off-days': { counted: 2, needed: 5, changed: 1, earlier: false, reason: 'few-nights' },
    'night-shift': { counted: 0, needed: 5, changed: 0, earlier: false, reason: 'few-nights' },
  },
  suggestions: [],
  dismissed: [],
  log: [
    night('2026-10-11', { tonight: true }),
    night('2026-10-10', { changes: [
      { at: '2026-10-11T00:31:00.000Z', fromF: 82, targetF: 79, plannedF: 82, held: false, source: 'api' },
      { at: '2026-10-11T04:00:00.000Z', fromF: 79, targetF: 82, plannedF: 82, held: true, source: 'tap' },
    ] }),
    night('2026-10-09'),
    night('2026-10-08', { excluded: true, changes: [
      { at: '2026-10-09T00:10:00.000Z', fromF: 80, targetF: 78, plannedF: 82, held: false, source: 'api' },
    ] }),
  ],
};
const open = (props: Partial<Parameters<typeof NotesSheet>[0]> = {}) => renderWithProviders(<NotesSheet
  side="right"
  rhythms={ Object.values(right.rhythms) }
  data={ data }
  away={ false }
  format="fahrenheit"
  timeZone="UTC"
  onClose={ () => {} }
  { ...props }/>);

it('is titled by where it was opened from', () => {
  const { unmount } = open();
  expect(screen.getByRole('dialog', { name: 'Notes' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Night shift' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Off days' })).toBeInTheDocument();
  unmount();
  open({ forRhythm: 'off-days' });
  expect(screen.getByRole('dialog', { name: 'Notes for Off days' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Night shift' })).not.toBeInTheDocument();
});

it('lists every night with its changes, tags and count', () => {
  open({ forRhythm: 'off-days' });
  expect(screen.getByText(
    "2 nights since Off days' times or temperatures changed. Mark an unusual night as a one-off to leave it out.")).toBeInTheDocument();
  expect(screen.getByText('Tonight: no change')).toBeInTheDocument();
  expect(screen.getByText('Sat, Oct 10: 82°F to 79°F at 12:31 AM')).toBeInTheDocument();
  expect(screen.getByText('79°F to 82°F at 4:00 AM (planned 82°F) (while holding) (cover)')).toBeInTheDocument();
  expect(screen.getByText('Fri, Oct 9: no change')).toBeInTheDocument();
  expect(screen.getByText('Thu, Oct 8: 80°F to 78°F at 12:10 AM (planned 82°F) (not counted)')).toBeInTheDocument();
});

it('marks a night as a one-off with a toggle that keeps its name', async () => {
  const posted: unknown[] = [];
  server.use(http.post('*/rhythms/suggestions/exclude', async ({ request }) => {
    posted.push(await request.json());
    return new HttpResponse(null, { status: 204 });
  }));
  const { user } = open({ forRhythm: 'off-days' });
  const toggle = screen.getByRole('button', { name: 'One-off, Sat, Oct 10' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(toggle).toHaveTextContent('One-off');
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'One-off, Sat, Oct 10' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(posted).toEqual([{ side: 'right', rhythmId: 'off-days', date: '2026-10-10', excluded: true }]));
  expect(screen.getByText(/\(cover\) \(not counted\)$/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'One-off, Thu, Oct 8' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: /^One-off, Sun, Oct 11/ })).not.toBeInTheDocument();
});

it('puts the toggle back and says so when the night could not be saved', async () => {
  server.use(http.post('*/rhythms/suggestions/exclude', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
  const { user } = open({ forRhythm: 'off-days' });
  await user.click(screen.getByRole('button', { name: 'One-off, Fri, Oct 9' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that night. Try again.');
  expect(screen.getByRole('button', { name: 'One-off, Fri, Oct 9' })).toHaveAttribute('aria-pressed', 'false');
});

it('explains the rules, what counts, and an away side', () => {
  open({ away: true });
  expect(screen.getByText('Away. Counting resumes when this side is back.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'How suggestions work' })).toBeInTheDocument();
  expect(screen.getByText(/^After 5 nights, a change in the same direction/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'What counts' })).toBeInTheDocument();
  expect(screen.getByText(/^Only hand changes count/)).toBeInTheDocument();
});
