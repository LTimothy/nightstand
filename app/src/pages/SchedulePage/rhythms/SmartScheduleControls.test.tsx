import { expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { DEFAULT_SMART, type SmartSchedule } from '@api/rhythmsSchema';
import SmartScheduleControls from './SmartScheduleControls';

it('changes intensity, switches and the base level', async () => {
  const onChange = vi.fn();
  const { user } = renderWithProviders(<SmartScheduleControls
    value={ DEFAULT_SMART }
    onChange={ onChange }
    format="level"
    trackingOn
    daySleep={ false }
    disabled={ false }/>);
  await user.click(screen.getByRole('button', { name: 'Gentle' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, intensity: 'gentle' });
  await user.click(screen.getByRole('switch', { name: 'Warm start' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, warmStart: false });
  await user.click(screen.getByRole('button', { name: 'Increase base temperature' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, baseLevel: 1 });
  expect(screen.getByRole('switch', { name: 'Skip the warm-up if I get up early' })).toBeEnabled();
  expect(screen.getByText('A little warmer when you get into bed.')).toBeInTheDocument();
});

it('needs Biometrics for up early and explains day sleep', () => {
  renderWithProviders(<SmartScheduleControls
    value={ DEFAULT_SMART }
    onChange={ () => {} }
    format="level"
    trackingOn={ false }
    daySleep
    disabled={ false }/>);
  expect(screen.getByRole('switch', { name: 'Skip the warm-up if I get up early' })).toBeDisabled();
  expect(screen.getByText('Needs Biometrics.')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent(/mostly during the day/);
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeDisabled();
  expect(screen.queryByText("Starts cooling once you've settled in bed")).not.toBeInTheDocument();
});

it('explains a short sleep and locks Warm start', () => {
  renderWithProviders(<SmartScheduleControls
    value={ DEFAULT_SMART }
    onChange={ () => {} }
    format="level"
    trackingOn
    daySleep={ false }
    shortSleep
    disabled={ false }/>);
  expect(screen.getByRole('note')).toHaveTextContent('This sleep is shorter than 3 hours, so there is no warm start.');
  expect(screen.getByRole('switch', { name: 'Warm start' })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Warm start' })).not.toBeChecked();
  expect(screen.getByText('Off for this rhythm, because its sleep is shorter than 3 hours.')).toBeInTheDocument();
});

it('chooses where the warm-up ends, or turns it off', async () => {
  const onChange = vi.fn();
  const show = (value: SmartSchedule) => renderWithProviders(<SmartScheduleControls
    value={ value }
    onChange={ onChange }
    format="level"
    trackingOn
    daySleep={ false }
    disabled={ false }/>);
  const first = show(DEFAULT_SMART);
  let group = screen.getByRole('group', { name: 'Warm-up before wake' });
  expect(within(group).getByRole('button', { name: 'Above base' })).toHaveAttribute('aria-pressed', 'true');
  await first.user.click(within(group).getByRole('button', { name: 'To base' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, warmUp: true, warmUpTo: 'base' });
  await first.user.click(within(group).getByRole('button', { name: 'Off' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, warmUp: false });
  first.unmount();

  const second = show({ ...DEFAULT_SMART, warmUp: true, warmUpTo: 'base' });
  group = screen.getByRole('group', { name: 'Warm-up before wake' });
  await second.user.click(within(group).getByRole('button', { name: 'Above base' }));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SMART, warmUp: true });
  expect(onChange.mock.lastCall?.[0]).not.toHaveProperty('warmUpTo');
});
