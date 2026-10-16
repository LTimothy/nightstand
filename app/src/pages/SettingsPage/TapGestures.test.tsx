import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getSettings } from '../../mocks/mockData';
import { useAppStore } from '@state/appStore';
import TapGestures from './TapGestures';

// The mock taps: double tap cooler by 1, triple tap warmer by 1, quad tap stop alarm, on both sides.
const left = () => screen.getByRole('group', { name: 'Left side taps' });
const base = (isConfigured: boolean) => server.use(http.get('*/api/base-control', () => HttpResponse.json({
  head: 0, feet: 0, isMoving: false, lastUpdate: new Date().toISOString(), isConfigured,
})));

describe('TapGestures', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ isUpdating: false });
  });

  it('shows each side\'s actions in the user\'s format', () => {
    renderWithProviders(<TapGestures
      settings={ { ...getSettings(), temperatureFormat: 'celsius' } }
      updateSettings={ vi.fn() }/>);
    expect(within(left()).getByRole('combobox', { name: 'Left Double tap' })).toHaveTextContent('Cooler');
    expect(within(left()).getByRole('combobox', { name: 'Left Double tap step' })).toHaveTextContent('0.6°C');
    expect(within(left()).getByRole('combobox', { name: 'Left Quad tap' })).toHaveTextContent('Stop alarm');
    expect(within(left()).getByText('Only while an alarm rings or is snoozed.')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Right side taps' })).toBeVisible();
  });

  it('saves the whole action when the action changes', async () => {
    const updateSettings = vi.fn();
    renderWithProviders(<TapGestures
      settings={ getSettings() }
      updateSettings={ updateSettings }/>);
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Double tap' }));
    await userEvent.click(screen.getByRole('option', { name: 'Set temperature' }));
    expect(updateSettings).toHaveBeenCalledWith({ left: { taps: { doubleTap: { type: 'set_temperature', temperatureF: 80 } } } });
  });

  it('starts a new step at one level for level users', async () => {
    const updateSettings = vi.fn();
    renderWithProviders(<TapGestures
      settings={ { ...getSettings(), temperatureFormat: 'level' } }
      updateSettings={ updateSettings }/>);
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Quad tap' }));
    await userEvent.click(screen.getByRole('option', { name: 'Warmer' }));
    expect(updateSettings).toHaveBeenCalledWith({
      left: { taps: { quadTap: { type: 'temperature', change: 'increment', amount: 2.75 } } },
    });
  });

  it('saves a set temperature from its stepper', () => {
    const settings = structuredClone(getSettings());
    settings.left.taps.quadTap = { type: 'set_temperature', temperatureF: 80 };
    settings.temperatureFormat = 'fahrenheit';
    const updateSettings = vi.fn();
    renderWithProviders(<TapGestures
      settings={ settings }
      updateSettings={ updateSettings }/>);
    expect(within(left()).getByText('Also turns the side on.')).toBeVisible();
    fireEvent.click(within(left()).getByRole('button', { name: 'Increase left quad tap temperature' }));
    expect(updateSettings).toHaveBeenCalledWith({ left: { taps: { quadTap: { type: 'set_temperature', temperatureF: 81 } } } });
  });

  it('saves a new step', async () => {
    const updateSettings = vi.fn();
    renderWithProviders(<TapGestures
      settings={ { ...getSettings(), temperatureFormat: 'fahrenheit' } }
      updateSettings={ updateSettings }/>);
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Triple tap step' }));
    await userEvent.click(screen.getByRole('option', { name: '3°F' }));
    expect(updateSettings).toHaveBeenCalledWith({
      left: { taps: { tripleTap: { type: 'temperature', change: 'increment', amount: 3 } } },
    });
  });

  it('saves a snooze length', async () => {
    const settings = structuredClone(getSettings());
    settings.left.taps.quadTap = { type: 'alarm', behavior: 'snooze', snoozeDuration: 90, inactiveAlarmBehavior: 'power' };
    const updateSettings = vi.fn();
    renderWithProviders(<TapGestures
      settings={ settings }
      updateSettings={ updateSettings }/>);
    const snooze = within(left()).getByRole('combobox', { name: 'Left Quad tap snooze' });
    expect(snooze).toHaveTextContent('1.5 min');
    await userEvent.click(snooze);
    await userEvent.click(screen.getByRole('option', { name: '5 min' }));
    expect(updateSettings).toHaveBeenCalledWith({
      left: { taps: { quadTap: { type: 'alarm', behavior: 'snooze', snoozeDuration: 300, inactiveAlarmBehavior: 'power' } } },
    });
  });

  it('offers the base only when one is set up, and explains a base action without one', async () => {
    base(false);
    const settings = structuredClone(getSettings());
    settings.left.taps.quadTap = { type: 'base_control', behavior: 'toggle_preset' };
    renderWithProviders(<TapGestures
      settings={ settings }
      updateSettings={ vi.fn() }/>);
    expect(await within(left()).findByText('No adjustable base is set up, so this does nothing.')).toBeVisible();
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Double tap' }));
    expect(screen.queryByRole('option', { name: 'Switch base position' })).not.toBeInTheDocument();
  });

  it('does not show the no-base note while the base status is loading', async () => {
    server.use(http.get('*/api/base-control', () => new Promise(() => {})));
    const settings = structuredClone(getSettings());
    settings.left.taps.quadTap = { type: 'base_control', behavior: 'toggle_preset' };
    renderWithProviders(<TapGestures
      settings={ settings }
      updateSettings={ vi.fn() }/>);
    expect(within(left()).queryByText('No adjustable base is set up, so this does nothing.')).not.toBeInTheDocument();
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Double tap' }));
    expect(screen.getByRole('option', { name: 'Switch base position' })).toBeInTheDocument();
  });

  it('names every select with its side', () => {
    const settings = structuredClone(getSettings());
    settings.right.taps.quadTap = { type: 'alarm', behavior: 'snooze', snoozeDuration: 90, inactiveAlarmBehavior: 'power' };
    renderWithProviders(<TapGestures
      settings={ settings }
      updateSettings={ vi.fn() }/>);
    expect(screen.getByRole('combobox', { name: 'Right Quad tap snooze' })).toBeVisible();
    expect(screen.getAllByRole('combobox', { name: 'Right Double tap' })).toHaveLength(1);
    expect(screen.getAllByRole('combobox', { name: 'Left Double tap step' })).toHaveLength(1);
  });

  it('offers the base when one is set up', async () => {
    base(true);
    renderWithProviders(<TapGestures
      settings={ getSettings() }
      updateSettings={ vi.fn() }/>);
    await userEvent.click(within(left()).getByRole('combobox', { name: 'Left Double tap' }));
    expect(await screen.findByRole('option', { name: 'Switch base position' })).toBeInTheDocument();
  });

  it('shows no controls for a side whose taps could not be read', () => {
    const settings = structuredClone(getSettings()) as unknown as { left: { taps?: unknown } };
    delete settings.left.taps;
    renderWithProviders(<TapGestures
      settings={ settings as unknown as ReturnType<typeof getSettings> }
      updateSettings={ vi.fn() }/>);
    expect(within(left()).getByText('Could not read this side\'s tap actions.')).toBeVisible();
    expect(within(left()).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('locks the controls while a save runs', () => {
    useAppStore.setState({ isUpdating: true });
    renderWithProviders(<TapGestures
      settings={ getSettings() }
      updateSettings={ vi.fn() }/>);
    expect(within(left()).getByRole('combobox', { name: 'Left Double tap' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('explains the Pod 5 cover buttons only on a Pod 5 hub with a Pod 5 cover', async () => {
    const note = 'On your Pod 5 cover, plus is a triple tap and minus a double tap. Settings > Features > Cover buttons sets them too.';
    const pod = (hubVersion: string, coverVersion: string) => server.use(
      http.get('*/api/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion, coverVersion })),
    );
    pod('Pod 5', 'Pod 5');
    const { unmount } = renderWithProviders(<TapGestures
      settings={ getSettings() }
      updateSettings={ vi.fn() }/>);
    expect(await screen.findByText(note)).toBeVisible();
    unmount();
    pod('Pod 4', 'Pod 5');
    renderWithProviders(<TapGestures
      settings={ getSettings() }
      updateSettings={ vi.fn() }/>);
    await screen.findByRole('group', { name: 'Left side taps' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });
});
