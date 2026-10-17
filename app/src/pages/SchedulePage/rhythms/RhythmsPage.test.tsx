import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import type { SuggestionsResponse } from '@api/rhythmsSchema';
import { getSettings, updateSettings } from '../../../mocks/mockData';
import { createDemoRhythms, getMockRhythms, listMockSleeps, resetMockRhythms } from '../../../mocks/rhythmsMock';
import { useScheduleStore } from '../scheduleStore';
import ScheduleTab from '../ScheduleTab';

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: () => <div data-testid="chart"/>,
  lineElementClasses: { root: 'line' },
  areaElementClasses: { root: 'area' },
}));

const NOW = new Date('2026-09-28T19:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useAppStore.setState({ side: 'left', isUpdating: false });
  useScheduleStore.setState(useScheduleStore.getInitialState(), true);
  resetMockRhythms(createDemoRhythms(NOW), true);
});
afterEach(() => {
  vi.useRealTimers();
  resetMockRhythms();
});

it('shows the week, the next two weeks and the rhythms for the chosen side', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  expect(await screen.findByRole('heading', { name: 'Week' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Rhythms' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sun to Thu: Workday' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Fri and Sat: Weekend' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Wed, Sep 30: No sleep scheduled, changed' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /^(Today|Tomorrow|Yesterday|\w{3}), / })).toHaveLength(7);
  await user.click(screen.getByRole('button', { name: 'Show 7 more dates' }));
  expect(screen.getAllByRole('button', { name: /^(Today|Tomorrow|Yesterday|\w{3}), / })).toHaveLength(14);
  await user.click(screen.getByRole('radio', { name: /^Sam/ }));
  const nightShift = await screen.findByRole('button', { name: 'Edit Night shift' });
  expect(nightShift).toHaveTextContent('8:00 AM to 3:30 PM · Smart Schedule');
});

async function pickSaturday(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Fri and Sat: Weekend' }));
  const picker = await screen.findByRole('dialog', { name: 'Fri and Sat' });
  await user.click(within(picker).getByRole('button', { name: 'Friday' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Saturday' })).getByRole('button', { name: /^Workday/ }));
}

it('saves a weekday pick', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByRole('button', { name: 'Every day but Fri: Workday' })).toBeInTheDocument();
  expect(getMockRhythms()?.left.week.saturday).toBe('workday');
});

it('names both days when a change would overlap', async () => {
  server.use(http.post('*/rhythms', () => HttpResponse.json(
    { error: 'Two sleeps would overlap', overlaps: [{ side: 'left', first: '2026-10-03', second: '2026-10-04' }] }, { status: 400 })));
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('The sleeps starting Saturday and Sunday would overlap.');
  expect(screen.getByRole('button', { name: 'Fri and Sat: Weekend' })).toBeInTheDocument();
});

it('changes one date and returns it to the Week', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: /^Tomorrow, Sep 29: Workday/ }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Tomorrow, Sep 29' })).getByRole('button', { name: /^No sleep scheduled/ }));
  await user.click(await screen.findByRole('button', { name: 'Tomorrow, Sep 29: No sleep scheduled, changed' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Tomorrow, Sep 29' }))
    .getByRole('button', { name: /^Back to Week: Workday/ }));
  expect(await screen.findByRole('button', { name: /^Tomorrow, Sep 29: Workday/ })).toBeInTheDocument();
});

it('opens a rhythm in the editor and comes back', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'Edit Weekend' }));
  expect(await screen.findByLabelText('Name')).toHaveValue('Weekend');
  expect(screen.queryByRole('heading', { name: 'Week' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Rhythms' }));
  expect(await screen.findByRole('heading', { name: 'Week' })).toBeInTheDocument();
});

it('creates a rhythm from New rhythm', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'New rhythm' }));
  await user.click(await screen.findByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Edit Rhythm 3' })).toBeInTheDocument();
  expect(getMockRhythms()?.left.rhythms['rhythm-3']?.name).toBe('Rhythm 3');
});

it('shows the pause above the Week and marks the paused dates', async () => {
  const settings = structuredClone(getSettings());
  settings.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<ScheduleTab/>);
  expect(await screen.findByText('Schedule paused until you resume')).toBeInTheDocument();
  expect(screen.getByText('Changes you save apply after the pause.')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /^Tomorrow, Sep 29: .*, paused$/ })).toBeInTheDocument();
});

it('ignores the other side\'s sleeps, as the server sends for a side that is away', async () => {
  server.use(http.get('*/rhythms/sleeps', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json(listMockSleeps('right', new Date(url.searchParams.get('from')!), new Date(url.searchParams.get('to')!)));
  }));
  renderWithProviders(<ScheduleTab/>);
  expect(await screen.findByRole('button', { name: 'Tomorrow, Sep 29: Workday · 10:30 PM to 6:45 AM · Smart Schedule' }))
    .toBeInTheDocument();
  expect(screen.queryByText('Now')).not.toBeInTheDocument();
});

it('closes the undo bar when a picker opens', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByText('Saturday now uses Workday')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Every day but Fri: Workday' }));
  await screen.findByRole('dialog', { name: 'Every day but Fri' });
  await waitFor(() => expect(screen.queryByText('Saturday now uses Workday')).not.toBeInTheDocument());
});

it('saves several dates in one write and undoes them together', async () => {
  const posts: unknown[] = [];
  server.use(http.post('*/rhythms', async ({ request }) => {
    posts.push(await request.clone().json());
  }));
  const { user } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'Change several dates' }));
  const sheet = await screen.findByRole('dialog', { name: 'Change several dates' });
  await user.click(within(sheet).getByRole('button', { name: 'Mon, Sep 28' }));
  await user.click(within(sheet).getByRole('button', { name: 'Tue, Sep 29' }));
  await user.click(within(sheet).getByRole('button', { name: 'Choose a rhythm' }));
  await user.click(within(await screen.findByRole('dialog', { name: '2 dates' })).getByRole('button', { name: /^Weekend/ }));
  expect(await screen.findByText('2 dates now use Weekend')).toBeInTheDocument();
  expect(posts).toHaveLength(1);
  expect(getMockRhythms()?.left.changes).toEqual([
    { date: '2026-09-28', rhythmId: 'weekend' }, { date: '2026-09-29', rhythmId: 'weekend' }, { date: '2026-09-30', rhythmId: null },
  ]);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(getMockRhythms()?.left.changes).toEqual([{ date: '2026-09-30', rhythmId: null }]));
  expect(posts).toHaveLength(2);
});

async function deleteWeekend(user: ReturnType<typeof renderWithProviders>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Edit Weekend' }));
  await user.click(await screen.findByRole('button', { name: 'Delete rhythm' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Delete Weekend?' })).getByRole('button', { name: 'Move and delete' }));
  expect(await screen.findByText('Weekend deleted. Fri and Sat now use Workday')).toBeInTheDocument();
}

it('deletes a rhythm and brings it back with Undo', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await deleteWeekend(user);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Rhythms' })).toHaveFocus());
  expect(getMockRhythms()?.left.rhythms.weekend).toBeUndefined();
  expect(getMockRhythms()?.left.week.saturday).toBe('workday');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(await screen.findByRole('button', { name: 'Edit Weekend' })).toBeInTheDocument();
  expect(getMockRhythms()?.left.week.saturday).toBe('weekend');
});

// WebKit can run the next frame before React commits the list, so focus must not wait on a frame.
it('focuses the Rhythms heading once the list is back, even if a frame runs before it', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  const { user } = renderWithProviders(<ScheduleTab/>);
  await deleteWeekend(user);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Rhythms' })).toHaveFocus());
  vi.unstubAllGlobals();
});

it('says so when a deleted rhythm cannot come back', async () => {
  const weekend = structuredClone(getMockRhythms()!.left.rhythms.weekend);
  const { user, queryClient } = renderWithProviders(<ScheduleTab/>);
  await deleteWeekend(user);
  // Another device adds a rhythm that takes the deleted one's id.
  getMockRhythms()!.left.rhythms.weekend = { ...weekend, name: 'Late' };
  await queryClient.refetchQueries({ queryKey: ['useRhythms'] });
  await screen.findByRole('button', { name: 'Edit Late' });
  const posts: unknown[] = [];
  server.use(http.post('*/rhythms', async ({ request }) => {
    posts.push(await request.clone().json());
  }));
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(await screen.findByText('Could not restore Weekend, because another rhythm took its place.')).toBeInTheDocument();
  expect(posts).toEqual([]);
  expect(getMockRhythms()?.left.week.saturday).toBe('workday');
});

it.each(['Edit Weekend', 'New rhythm'])('puts the undo bar away when %s opens the editor', async opener => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByText('Saturday now uses Workday')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: opener }));
  await user.click(await screen.findByRole('button', { name: 'Rhythms' }));
  await screen.findByRole('heading', { name: 'Week' });
  expect(screen.queryByText('Saturday now uses Workday')).not.toBeInTheDocument();
});

it('uses a new rhythm on some days, with an undo', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'New rhythm' }));
  const save = await screen.findByRole('button', { name: 'Save' });
  save.focus();
  fireEvent.click(save);
  // Browsers blur a focused button when it becomes disabled.
  save.blur();
  const use = await screen.findByRole('button', { name: 'Use Rhythm 3 on some days' });
  await waitFor(() => expect(use).toHaveFocus());
  await user.click(use);
  const sheet = await screen.findByRole('dialog', { name: 'Use Rhythm 3 on' });
  await user.click(within(sheet).getByRole('button', { name: 'Monday' }));
  await user.click(within(sheet).getByRole('button', { name: 'Use on Monday' }));
  expect(await screen.findByText('Monday now uses Rhythm 3')).toBeInTheDocument();
  expect(getMockRhythms()?.left.week.monday).toBe('rhythm-3');
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(getMockRhythms()?.left.week.monday).toBe('workday'));
});

it('keeps an open draft when the data refetches', async () => {
  const { user, queryClient } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'Edit Weekend' }));
  fireEvent.change(await screen.findByLabelText('Turn on at'), { target: { value: '23:15' } });
  await queryClient.refetchQueries();
  expect(screen.getByLabelText('Turn on at')).toHaveValue('23:15');
  expect(useScheduleStore.getState().nightBaseline?.power.on).toBe('23:30');
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});

it('keeps an open draft when a refetch fails', async () => {
  const { user, queryClient } = renderWithProviders(<ScheduleTab/>);
  await user.click(await screen.findByRole('button', { name: 'Edit Weekend' }));
  fireEvent.change(await screen.findByLabelText('Turn on at'), { target: { value: '23:15' } });
  server.use(http.get('*/rhythms', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
  await queryClient.refetchQueries({ queryKey: ['useRhythms'] });
  await waitFor(() => expect(queryClient.getQueryState(['useRhythms'])?.status).toBe('error'));
  expect(screen.queryByText('Could not load Rhythms.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Turn on at')).toHaveValue('23:15');
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});

it('does not carry a page error into the editor', async () => {
  server.use(http.post('*/rhythms', () => HttpResponse.json({ error: 'down' }, { status: 500 })));
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save Rhythms.');
  await user.click(screen.getByRole('button', { name: 'Edit Weekend' }));
  expect(await screen.findByLabelText('Name')).toHaveValue('Weekend');
  expect(document.getElementById('rhythm-save-error')).toBeNull();
  expect(screen.queryByText(/Could not save Rhythms/)).not.toBeInTheDocument();
});

it('keeps Undo after a failed undo, so it can be tried again', async () => {
  const { user } = renderWithProviders(<ScheduleTab/>);
  await pickSaturday(user);
  expect(await screen.findByText('Saturday now uses Workday')).toBeInTheDocument();
  server.use(http.post('*/rhythms', () => HttpResponse.json({}, { status: 500 }), { once: true }));
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(await screen.findByText(/Your changes were not saved\. Try again\./)).toBeInTheDocument();
  expect(getMockRhythms()?.left.week.saturday).toBe('workday');
  const undo = screen.getByRole('button', { name: 'Undo' });
  await waitFor(() => expect(undo).toBeEnabled());
  await user.click(undo);
  await waitFor(() => expect(getMockRhythms()?.left.week.saturday).toBe('weekend'));
  await waitFor(() => expect(screen.queryByText('Saturday now uses Workday')).not.toBeInTheDocument());
});

it('reads Rhythms again after a save the Pod refused with a conflict', async () => {
  let reads = 0;
  server.use(
    http.get('*/rhythms', () => {
      reads += 1;
    }),
    http.post('*/rhythms', () => HttpResponse.json({ error: 'Rhythms are not set up on this Pod', state: 'absent' }, { status: 409 })),
  );
  const { user } = renderWithProviders(<ScheduleTab/>);
  await screen.findByRole('button', { name: 'Fri and Sat: Weekend' });
  const before = reads;
  await pickSaturday(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Rhythms are not set up on this Pod.');
  await waitFor(() => expect(reads).toBeGreaterThan(before));
});

const withSuggestions = (body: SuggestionsResponse) => {
  updateSettings({ features: { ...getSettings().features, rhythmSuggestions: true } });
  server.use(http.get('*/rhythms/suggestions', () => HttpResponse.json(body)));
};
const noSuggestions = () => updateSettings({ features: { ...getSettings().features, rhythmSuggestions: false } });

it('counts nights for suggestions after the rhythms and opens the notes', async () => {
  withSuggestions({
    enabled: true,
    nights: { workday: { counted: 3, needed: 5, changed: 0, earlier: false, reason: 'few-nights' } },
    suggestions: [],
    dismissed: [],
    log: [{
      date: '2026-09-27', rhythmId: 'workday', tonight: false, excluded: false,
      plan: [{ offsetMin: 0, temperatureF: 83 }], endMin: 495, changes: [],
    }],
  });
  try {
    const { user } = renderWithProviders(<ScheduleTab/>);
    expect(await screen.findByText('Workday: 3 of 5 nights so far')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent);
    expect(headings.indexOf('Suggestions')).toBe(headings.indexOf('Rhythms') + 1);
    expect(headings.indexOf('Add one-time alarm')).toBe(headings.indexOf('Suggestions') + 1);
    await user.click(screen.getByRole('button', { name: 'Show the nights' }));
    expect(await screen.findByRole('dialog', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByText('Sun, Sep 27: no change')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show the nights' })).toHaveFocus());
  } finally {
    noSuggestions();
  }
});

const spyOnSuggestions = () => {
  const reads = { count: 0 };
  server.use(http.get('*/rhythms/suggestions', () => { reads.count += 1; return HttpResponse.json({
    enabled: true, nights: {}, suggestions: [], dismissed: [], log: [],
  }); }));
  return reads;
};

it('shows nothing of suggestions and asks for nothing while the feature is off', async () => {
  const reads = spyOnSuggestions();
  renderWithProviders(<ScheduleTab/>);
  expect(await screen.findByRole('heading', { name: 'Rhythms' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Fri and Sat: Weekend' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Suggestions' })).not.toBeInTheDocument();
  expect(reads.count).toBe(0);
});

it('asks for suggestions once while the feature is on', async () => {
  updateSettings({ features: { ...getSettings().features, rhythmSuggestions: true } });
  const reads = spyOnSuggestions();
  try {
    renderWithProviders(<ScheduleTab/>);
    expect(await screen.findByRole('heading', { name: 'Suggestions' })).toBeInTheDocument();
    expect(reads.count).toBe(1);
  } finally {
    noSuggestions();
  }
});
