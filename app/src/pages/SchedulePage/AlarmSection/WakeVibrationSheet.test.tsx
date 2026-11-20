import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { useAppStore } from '@state/appStore';
import WakeVibration from './WakeVibrationSheet';

const note = 'Builds up needs a Pod 5 hub and cover, so alarms on this Pod use Double pulse.';
const alarm = { vibrationIntensity: 30, vibrationPattern: 'rise', duration: 10 } as const;

beforeEach(() => {
  useAppStore.setState({ side: 'left', isUpdating: false });
});

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Vibrate:/ }));

it('renders no sheet until the summary is pressed', () => {
  renderWithProviders(<WakeVibration alarm={ alarm } onChange={ () => {} } risePattern disabled={ false }/>);
  expect(screen.getByRole('button', { name: 'Vibrate: Builds up, strength 30, 10 seconds' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  open();
  expect(screen.getByRole('dialog', { name: 'Alarm vibration' })).toBeInTheDocument();
});

it('offers Builds up on a Pod 5', () => {
  renderWithProviders(<WakeVibration alarm={ alarm } onChange={ () => {} } risePattern disabled={ false }/>);
  open();
  expect(screen.getByRole('combobox', { name: 'Pattern' })).toHaveTextContent('Builds up');
  expect(screen.queryByText(note)).not.toBeInTheDocument();
});

it('shows the pattern the Pod will use and keeps Builds up out of reach on other Pods', () => {
  const onChange = vi.fn();
  renderWithProviders(<WakeVibration alarm={ alarm } onChange={ onChange } risePattern={ false } disabled={ false }/>);
  expect(screen.getByRole('button', { name: /^Vibrate: Double pulse/ })).toBeInTheDocument();
  open();
  const pattern = screen.getByRole('combobox', { name: 'Pattern' });
  expect(pattern).toHaveTextContent('Double pulse');
  expect(screen.getByText(note)).toBeInTheDocument();
  fireEvent.mouseDown(pattern);
  const options = within(screen.getByRole('listbox'));
  expect(options.getByRole('option', { name: 'Builds up' })).toHaveAttribute('aria-disabled', 'true');
  expect(onChange).not.toHaveBeenCalled();
});

it('reports a pattern change as a patch', () => {
  const onChange = vi.fn();
  renderWithProviders(<WakeVibration alarm={ alarm } onChange={ onChange } risePattern disabled={ false }/>);
  open();
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Pattern' }));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Double pulse' }));
  expect(onChange).toHaveBeenCalledWith({ vibrationPattern: 'double' });
});

it('offers lengths up to the cap it is given', () => {
  renderWithProviders(<WakeVibration alarm={ alarm } onChange={ () => {} } maxDuration={ 180 } risePattern={ false } disabled={ false }/>);
  open();
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Length' }));
  const options = within(screen.getByRole('listbox'));
  expect(options.getByRole('option', { name: '3 minutes' })).toBeInTheDocument();
  expect(options.queryByRole('option', { name: '4 minutes' })).not.toBeInTheDocument();
});
