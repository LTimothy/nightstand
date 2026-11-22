import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OneOffAlarmLine from './OneOffAlarmLine';

const fixture = vi.hoisted(() => ({
  text: null as string | null,
  night: undefined as object | undefined,
  ready: true,
  paused: false,
  oneOffAlarms: true,
  awayMode: false,
}));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left' }) }));
vi.mock('@api/settings.ts', () => ({
  useSettings: () => ({ data: { timeZone: 'UTC', features: { oneOffAlarms: fixture.oneOffAlarms }, left: { awayMode: fixture.awayMode } } }),
}));
vi.mock('@api/schedulePause.ts', () => ({ isSchedulePaused: () => fixture.paused }));
vi.mock('../SchedulePage/oneOffAlarm', () => ({ pendingOneOffText: () => fixture.text }));
vi.mock('./useAlarmNight', () => ({ useAlarmNight: () => ({ ready: fixture.ready, night: fixture.night }) }));
vi.mock('../SchedulePage/OneOffAlarmSection', () => ({
  default: ({ startEnabled, onSaved }: { startEnabled?: boolean; onSaved?: () => void }) =>
    <button onClick={ onSaved }>{ startEnabled ? 'section starting on' : 'section as saved' }</button>,
}));

beforeEach(() => {
  Object.assign(fixture, { text: null, night: undefined, ready: true, paused: false, oneOffAlarms: true, awayMode: false });
});

it('shows the pending alarm, and Edit opens the one-time alarm sheet in place', async () => {
  fixture.text = 'tomorrow at 7:00 AM';
  render(<OneOffAlarmLine/>);
  expect(screen.getByText('One-time alarm tomorrow at 7:00 AM')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByRole('dialog', { name: 'One-time alarm' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'section as saved' })).toBeInTheDocument();
});

it('offers a one-time alarm when nothing will ring, and closes the sheet once saved', async () => {
  render(<OneOffAlarmLine/>);
  expect(screen.getByText('No alarm coming up')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Add one-time alarm' }));
  await userEvent.click(screen.getByRole('button', { name: 'section starting on' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it.each([
  ['a recurring alarm is coming up', { night: {} }],
  ['the alarm lookup is still loading', { ready: false }],
  ['one-time alarms are switched off', { oneOffAlarms: false }],
  ['the side is away', { awayMode: true }],
  ['the schedule is paused', { paused: true }],
])('shows nothing when %s', (_name, state) => {
  Object.assign(fixture, state);
  const { container } = render(<OneOffAlarmLine/>);
  expect(container).toBeEmptyDOMElement();
});
