import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import type { SideRhythms } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import DateChanges from './DateChanges';

const left = createDemoRhythms(new Date('2026-09-28T19:00:00Z')).left;
const withChanges = (changes: SideRhythms['changes']): SideRhythms => ({ ...left, changes });

function renderChanges(sideData: SideRhythms, disabled = false) {
  const onChoose = vi.fn();
  const view = renderWithProviders(<DateChanges
    sideData={ sideData }
    from="2026-09-28"
    today="2026-09-28"
    disabled={ disabled }
    onChoose={ onChoose }/>);
  return { ...view, onChoose };
}

it('lists every change, including one made weeks ahead', async () => {
  const { user } = renderChanges(withChanges([{ date: '2026-09-30', rhythmId: null }, { date: '2026-11-05', rhythmId: 'weekend' }]));
  const toggle = screen.getByRole('button', { name: 'Changed dates (2)' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Wed, Sep 30')).toBeInTheDocument();
  expect(screen.getByText('No sleep scheduled')).toBeInTheDocument();
  expect(screen.getByText('Thu, Nov 5')).toBeInTheDocument();
  expect(screen.getByText('Weekend')).toBeInTheDocument();
});

it('shows nothing when no date is changed', () => {
  renderChanges(withChanges([]));
  expect(screen.queryByRole('button', { name: /^Changed dates/ })).not.toBeInTheDocument();
});

it('puts a date back to the Week', async () => {
  const { user, onChoose } = renderChanges(withChanges([{ date: '2026-09-30', rhythmId: null }]));
  await user.click(screen.getByRole('button', { name: 'Changed dates (1)' }));
  await user.click(screen.getByRole('button', { name: 'Wed, Sep 30: back to Week: Workday' }));
  expect(onChoose).toHaveBeenCalledWith('2026-09-30', { kind: 'weekly' });
});

it('keeps going back focusable but inactive while a save runs', async () => {
  const { user, onChoose } = renderChanges(withChanges([{ date: '2026-09-30', rhythmId: null }]), true);
  await user.click(screen.getByRole('button', { name: 'Changed dates (1)' }));
  const back = screen.getByRole('button', { name: /^Wed, Sep 30: back to/ });
  expect(back).toHaveAttribute('aria-disabled', 'true');
  expect(back).not.toBeDisabled();
  await user.click(back);
  expect(onChoose).not.toHaveBeenCalled();
});
