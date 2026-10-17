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

it('lists every night under its date, with its changes and the count', () => {
  open({ forRhythm: 'off-days' });
  expect(screen.getByText('2 nights so far.')).toBeInTheDocument();
  expect(screen.getByText('Press Leave out on a night that should not count, such as a night away.')).toBeInTheDocument();
  expect(screen.getByText('Tonight: no change')).toBeInTheDocument();
  expect(screen.getByText('Sat, Oct 10')).toBeInTheDocument();
  expect(screen.getByText('82°F to 79°F at 12:31 AM')).toBeInTheDocument();
  expect(screen.getByText('79°F to 82°F at 4:00 AM (cover)')).toBeInTheDocument();
  expect(screen.getByText('Fri, Oct 9')).toBeInTheDocument();
  expect(screen.getByText('no change')).toBeInTheDocument();
  expect(screen.getByText('Thu, Oct 8, left out')).toBeInTheDocument();
  expect(screen.getByText('80°F to 78°F at 12:10 AM (planned 82°F)')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/while holding|one-off|not counted/i);
});

it('leaves a night out with a toggle that keeps its name', async () => {
  const posted: unknown[] = [];
  server.use(http.post('*/rhythms/suggestions/exclude', async ({ request }) => {
    posted.push(await request.json());
    return new HttpResponse(null, { status: 204 });
  }));
  const { user } = open({ forRhythm: 'off-days' });
  const toggle = screen.getByRole('button', { name: 'Leave out, Sat, Oct 10' });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(toggle).toHaveTextContent('Leave out');
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Leave out, Sat, Oct 10' })).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => expect(posted).toEqual([{ side: 'right', rhythmId: 'off-days', date: '2026-10-10', excluded: true }]));
  expect(screen.getByText('Sat, Oct 10, left out')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Leave out, Thu, Oct 8' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: /^Leave out, Sun, Oct 11/ })).not.toBeInTheDocument();
});

it('puts the toggle back and says so when the night could not be saved', async () => {
  server.use(http.post('*/rhythms/suggestions/exclude', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
  const { user } = open({ forRhythm: 'off-days' });
  await user.click(screen.getByRole('button', { name: 'Leave out, Fri, Oct 9' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that night. Try again.');
  expect(screen.getByRole('button', { name: 'Leave out, Fri, Oct 9' })).toHaveAttribute('aria-pressed', 'false');
});

it('keeps the rules under How this works, and says when a side is away', async () => {
  const { user } = open({ away: true });
  expect(screen.getByText('Away. Counting resumes when this side is back.')).toBeInTheDocument();
  const how = screen.getByRole('button', { name: 'How this works' });
  expect(how).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('heading', { name: 'How suggestions work' })).not.toBeInTheDocument();
  await user.click(how);
  expect(how).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('heading', { name: 'How suggestions work' })).toBeInTheDocument();
  expect(screen.getByText(/^A change you make the same way, within about 2 hours/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'What counts' })).toBeInTheDocument();
  // Night shift is a Smart rhythm, so the Smart sentence is there.
  expect(screen.getByText(/^Changes you make by hand in this app/)).toHaveTextContent(/On a Smart Schedule rhythm/);
});

it('leaves the Smart sentence out when no Smart rhythm is on the sheet', async () => {
  const { user } = open({ forRhythm: 'off-days' });
  await user.click(screen.getByRole('button', { name: 'How this works' }));
  expect(screen.getByText(/^Changes you make by hand in this app/)).not.toHaveTextContent(/Smart Schedule/);
});

it('starts on its heading', async () => {
  open({ forRhythm: 'off-days' });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Notes for Off days' })).toHaveFocus());
});

it('lists hidden suggestions and shows one again', async () => {
  const restored: unknown[] = [];
  server.use(http.post('*/rhythms/suggestions/restore', async ({ request }) => {
    restored.push(await request.json());
    return new HttpResponse(null, { status: 204 });
  }));
  const { user } = open({ forRhythm: 'off-days', data: { ...data, dismissed: [
    { id: 'a1b2c3d4e5f6', rhythmId: 'off-days', key: 'step:down', time: '23:45', scope: 'plan', nightsLeft: 0 },
    { id: 'b1b2c3d4e5f6', rhythmId: 'off-days', key: null, time: null, scope: 'later', nightsLeft: 9 },
  ] } });
  expect(screen.getByRole('heading', { name: 'Hidden' })).toBeInTheDocument();
  expect(screen.getByText('Not suggested again until you change Off days, or press Show again.')).toBeInTheDocument();
  expect(screen.getByText('Hidden: cooler around 11:45 PM')).toBeInTheDocument();
  expect(screen.getByText('All suggestions hidden for 9 more nights')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show again, cooler around 11:45 PM' }));
  await waitFor(() => expect(restored).toEqual([{ side: 'right', ids: ['a1b2c3d4e5f6'] }]));
});

it('skips the intro when only a hide for some nights is listed', () => {
  open({ forRhythm: 'off-days', data: { ...data, dismissed: [
    { id: 'b1b2c3d4e5f6', rhythmId: 'off-days', key: null, time: null, scope: 'later', nightsLeft: 9 },
  ] } });
  expect(screen.getByText('All suggestions hidden for 9 more nights')).toBeInTheDocument();
  expect(screen.queryByText(/^Not suggested again/)).not.toBeInTheDocument();
});

it('says so when a hidden suggestion could not be shown again', async () => {
  server.use(http.post('*/rhythms/suggestions/restore', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
  const { user } = open({ forRhythm: 'off-days', data: { ...data, dismissed: [
    { id: 'a1b2c3d4e5f6', rhythmId: 'off-days', key: 'on:up', time: null, scope: 'plan', nightsLeft: 0 },
  ] } });
  await user.click(screen.getByRole('button', { name: 'Show again, a warmer start' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not show it again. Try again.');
});
