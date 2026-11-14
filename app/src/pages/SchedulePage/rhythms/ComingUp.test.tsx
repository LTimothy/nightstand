import { expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { palette } from '@design/tokens';
import ComingUp from './ComingUp';

const left = createDemoRhythms(new Date('2026-09-28T19:00:00Z')).left;

function renderComingUp(dates: string[], sleeps: ResolvedSleepResponse[] = [], pausedUntil?: Date | null, disabled = false) {
  const onChoose = vi.fn();
  const onChooseMany = vi.fn();
  const view = renderWithProviders(<ComingUp
    sideData={ left }
    sleeps={ sleeps }
    dates={ dates }
    today="2026-09-28"
    timeZone="America/Los_Angeles"
    disabled={ disabled }
    pausedUntil={ pausedUntil }
    onChoose={ onChoose }
    onChooseMany={ onChooseMany }/>);
  return { ...view, onChoose, onChooseMany };
}

const sleepAround = (start: number, end: number, date = '2026-09-28') => ({
  date, start: new Date(start).toISOString(), end: new Date(end).toISOString(), mode: 'manual',
}) as unknown as ResolvedSleepResponse;

it('lists dates with their rhythm and marks changed ones', () => {
  renderComingUp(['2026-09-28', '2026-09-29', '2026-09-30']);
  expect(screen.getByRole('button', { name: 'Today, Sep 28: Workday · 10:30 PM to 6:45 AM' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Wed, Sep 30: No sleep scheduled, changed' })).toBeInTheDocument();
  expect(screen.getAllByText('Changed')).toHaveLength(1);
});

it('uses the times the Pod resolved when it has them', () => {
  const sleep = { date: '2026-09-28', start: '2026-09-29T05:30:00.000Z', end: '2026-09-29T14:00:00.000Z', mode: 'manual' };
  renderComingUp(['2026-09-28'], [sleep as unknown as ResolvedSleepResponse]);
  expect(screen.getByRole('button', { name: 'Today, Sep 28: Workday · 10:30 PM to 7:00 AM' })).toBeInTheDocument();
});

it('marks a sleep in progress as now', () => {
  const now = Date.now();
  renderComingUp(['2026-09-28'], [sleepAround(now - 3_600_000, now + 3_600_000)]);
  expect(screen.getByText('Now')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Today, Sep 28: .*, now$/ })).toBeInTheDocument();
});

it('marks only the sleeps that start before the pause ends', () => {
  const now = Date.now();
  const sleeps = [sleepAround(now + 3_600_000, now + 8 * 3_600_000), sleepAround(now + 48 * 3_600_000, now + 56 * 3_600_000, '2026-09-29')];
  renderComingUp(['2026-09-28', '2026-09-29'], sleeps, new Date(now + 24 * 3_600_000));
  expect(screen.getAllByText('Paused')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Today, Sep 28: .*, paused$/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Tomorrow, Sep 29: [^,]*$/ })).toBeInTheDocument();
});

it('marks every listed sleep paused until the pause is resumed', () => {
  const now = Date.now();
  renderComingUp(['2026-09-28'], [sleepAround(now + 3_600_000, now + 8 * 3_600_000)], null);
  expect(screen.getByText('Paused')).toBeInTheDocument();
});

it('keeps a paused sleep readable, leaving the chip to say it is paused', () => {
  const now = Date.now();
  renderComingUp(['2026-09-28'], [sleepAround(now + 3_600_000, now + 8 * 3_600_000)], null);
  const row = screen.getByRole('button', { name: /, paused$/ });
  const summary = within(row).getByText(/Workday/);
  expect(summary).not.toHaveStyle({ color: palette.text.disabled });
  expect(summary).toHaveStyle({ color: palette.text.secondary });
});

it('offers going back to the Week for a changed date', async () => {
  const { user, onChoose } = renderComingUp(['2026-09-30']);
  await user.click(screen.getByRole('button', { name: /^Wed, Sep 30/ }));
  const picker = await screen.findByRole('dialog', { name: 'Wed, Sep 30' });
  await user.click(within(picker).getByRole('button', { name: /^Back to Week: Workday/ }));
  expect(onChoose).toHaveBeenCalledWith('2026-09-30', { kind: 'weekly' });
});

it('changes a later date up to 60 days ahead', async () => {
  const { user, onChoose } = renderComingUp(['2026-09-28']);
  await user.click(screen.getByRole('button', { name: 'Change a later date' }));
  const ask = await screen.findByRole('dialog', { name: 'Pick a date' });
  const field = within(ask).getByLabelText('Date');
  expect(field).toHaveAttribute('max', '2026-11-27');
  fireEvent.change(field, { target: { value: '2026-11-28' } });
  expect(within(ask).getByText('Pick a date from today to Fri, Nov 27')).toBeInTheDocument();
  expect(within(ask).getByRole('button', { name: 'Choose a rhythm' })).toBeDisabled();
  fireEvent.change(field, { target: { value: '2026-11-20' } });
  await user.click(within(ask).getByRole('button', { name: 'Choose a rhythm' }));
  const picker = await screen.findByRole('dialog', { name: 'Fri, Nov 20' });
  await user.click(within(picker).getByRole('button', { name: /^No sleep scheduled/ }));
  expect(onChoose).toHaveBeenCalledWith('2026-11-20', { kind: 'none' });
});

it('gives several dates one rhythm', async () => {
  const { user, onChooseMany } = renderComingUp(['2026-09-28']);
  await user.click(screen.getByRole('button', { name: 'Change several dates' }));
  const sheet = await screen.findByRole('dialog', { name: 'Change several dates' });
  await user.click(within(sheet).getByRole('button', { name: 'Tue, Sep 29' }));
  await user.click(within(sheet).getByRole('button', { name: 'Wed, Sep 30, changed' }));
  await user.click(within(sheet).getByRole('button', { name: 'Choose a rhythm' }));
  const picker = await screen.findByRole('dialog', { name: '2 dates' });
  expect(within(picker).getByRole('button', { name: /^Back to Week/ })).toBeInTheDocument();
  await user.click(within(picker).getByRole('button', { name: /^Weekend/ }));
  expect(onChooseMany).toHaveBeenCalledWith(['2026-09-29', '2026-09-30'], { kind: 'rhythm', id: 'weekend' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('says a sleep that started yesterday is the one in progress', async () => {
  const now = Date.now();
  const { user, onChoose } = renderComingUp(['2026-09-27', '2026-09-28'], [sleepAround(now - 3_600_000, now + 3_600_000, '2026-09-27')]);
  await user.click(screen.getByRole('button', { name: /^Yesterday, Sep 27: .*, now$/ }));
  const picker = await screen.findByRole('dialog', { name: 'Yesterday, Sep 27' });
  expect(within(picker).getByText('For the sleep in progress now')).toBeInTheDocument();
  await user.click(within(picker).getByRole('button', { name: /^No sleep scheduled/ }));
  expect(onChoose).toHaveBeenCalledWith('2026-09-27', { kind: 'none' });
});

it('starts the later date empty after Cancel and after a pick', async () => {
  const { user } = renderComingUp(['2026-09-28']);
  await user.click(screen.getByRole('button', { name: 'Change a later date' }));
  let ask = await screen.findByRole('dialog', { name: 'Pick a date' });
  fireEvent.change(within(ask).getByLabelText('Date'), { target: { value: '2026-10-20' } });
  await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pick a date' })).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Change a later date' }));
  ask = await screen.findByRole('dialog', { name: 'Pick a date' });
  expect(within(ask).getByLabelText('Date')).toHaveValue('');
  fireEvent.change(within(ask).getByLabelText('Date'), { target: { value: '2026-10-20' } });
  await user.click(within(ask).getByRole('button', { name: 'Choose a rhythm' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Tue, Oct 20' })).getByRole('button', { name: /^Weekend/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Change a later date' }));
  expect(within(await screen.findByRole('dialog', { name: 'Pick a date' })).getByLabelText('Date')).toHaveValue('');
});

it('keeps the date buttons focusable while a save runs', async () => {
  const { user } = renderComingUp(['2026-09-28'], [], undefined, true);
  for (const name of ['Change a later date', 'Change several dates']) {
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await user.click(button);
  }
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
