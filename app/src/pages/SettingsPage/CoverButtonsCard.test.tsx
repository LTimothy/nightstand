import { describe, expect, it } from 'vitest';
import type { DeepPartial } from 'ts-essentials';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getSettings } from '../../mocks/mockData';
import type { Settings } from '@api/settingsSchema';
import SettingsPage from './SettingsPage';
import CoverButtonsCard from './CoverButtonsCard';

const fahrenheit = (change: (settings: ReturnType<typeof getSettings>) => void = () => {}) => {
  const settings = structuredClone({ ...getSettings(), temperatureFormat: 'fahrenheit' as const });
  change(settings);
  return settings;
};

function pod(hubVersion: string, coverVersion: string, settings = fahrenheit()) {
  const posted: unknown[] = [];
  server.use(http.get('*/api/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion, coverVersion })));
  const ui = <CoverButtonsCard
    settings={ settings }
    updateSettings={ (patch: DeepPartial<Settings>) => { posted.push(patch); } }/>;
  return { posted, ui };
}
const NOT_PAIR = 'Plus and minus are not a matching warmer and cooler pair. Set them under Bed and sides > Tap gestures.';
const leftButtons = () => screen.findByRole('group', { name: 'Left side buttons' });

describe('Cover buttons options', () => {
  it('on a Pod 4 hub with a Pod 5 cover, shows a switch and the options only while it is on', async () => {
    const { posted, ui } = pod('Pod 4', 'Pod 5');
    renderWithProviders(ui);
    expect(await screen.findByRole('heading', { level: 2, name: 'Cover buttons' })).toBeVisible();
    const toggle = screen.getByRole('switch', { name: 'Read cover buttons' });
    expect(screen.getByText('Your Pod 4 hub ignores short clicks on the Pod 5 cover. '
      + 'Nightstand reads them from the Pod\'s log, 15 to 25 s late.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Left side buttons' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(posted).toEqual([{ features: { coverButtons: true } }]);
  });

  it('on a Pod 4 hub, saves the step, the swap and the logo temperature to the buttons settings', async () => {
    const { posted, ui } = pod('Pod 4', 'Pod 5', fahrenheit(settings => { settings.features.coverButtons = true; }));
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(screen.getByRole('group', { name: 'Right side buttons' })).toBeVisible();
    expect(within(group).queryByRole('switch', { name: 'Left logo sets a temperature' })).not.toBeInTheDocument();
    expect(within(group).getByText('When no alarm is ringing, the logo sets this and turns the side on.')).toBeVisible();
    await userEvent.click(within(group).getByRole('combobox', { name: 'Left Step per click' }));
    await userEvent.click(screen.getByRole('option', { name: '3°F' }));
    await userEvent.click(await within(await leftButtons()).findByRole('switch', { name: 'Left swap plus and minus' }));
    fireEvent.click(within(await leftButtons()).getByRole('button', { name: 'Increase left logo temperature' }));
    expect(screen.getByRole('switch', { name: 'Read cover buttons' })).toBeChecked();
    expect(posted).toEqual([
      { left: { buttons: { stepF: 3 } } },
      { left: { buttons: { invertButtons: true } } },
      { left: { buttons: { favoriteTemperatureF: 81 } } },
    ]);
  });

  it('on a Pod 5 hub, shows a heading instead of a switch, explains the tap mapping and saves whole tap actions', async () => {
    const { posted, ui } = pod('Pod 5', 'Pod 5');
    renderWithProviders(ui);
    expect(await screen.findByRole('heading', { level: 2, name: 'Cover buttons' })).toBeVisible();
    expect(screen.queryByRole('switch', { name: /cover buttons/i })).not.toBeInTheDocument();
    expect(screen.getByText(
      'Your Pod 5 hub turns plus into a triple tap and minus into a double tap. '
      + 'Nightstand reads logo clicks from the Pod\'s log, 15 to 25 s late. Set what each click does here.',
    )).toBeVisible();
    const group = await leftButtons();
    await userEvent.click(within(group).getByRole('combobox', { name: 'Left Step per click' }));
    await userEvent.click(screen.getByRole('option', { name: '2°F' }));
    await userEvent.click(await within(await leftButtons()).findByRole('switch', { name: 'Left logo sets a temperature' }));
    expect(posted).toEqual([
      { left: { taps: {
        tripleTap: { type: 'temperature', change: 'increment', amount: 2 },
        doubleTap: { type: 'temperature', change: 'decrement', amount: 2 },
      } } },
      { left: { taps: { quadTap: { type: 'set_temperature', temperatureF: 80 } } } },
    ]);
  });

  it('on a Pod 5 hub, shows the logo temperature and turns it back into the base toggle', async () => {
    const { posted, ui } = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
    }));
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(within(group).getByRole('spinbutton', { name: 'Left logo temperature' })).toBeVisible();
    expect(within(group).getByText('Also turns the side on.')).toBeVisible();
    await userEvent.click(within(group).getByRole('switch', { name: 'Left logo sets a temperature' }));
    expect(posted).toEqual([{ left: { taps: { quadTap: { type: 'base_control', behavior: 'toggle_preset' } } } }]);
  });

  it('on a Pod 5 hub, points to Tap gestures when plus and minus do something else', async () => {
    const settings = fahrenheit(settings => {
      settings.left.taps.doubleTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none' };
    });
    const { ui } = pod('Pod 5', 'Pod 5', settings);
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(within(group).getByText(NOT_PAIR)).toBeVisible();
    expect(within(group).queryByRole('combobox', { name: 'Left Step per click' })).not.toBeInTheDocument();
  });

  it('on a Pod 5 hub, points to Tap gestures when plus and minus differ in amount', async () => {
    const { ui } = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 3 };
    }));
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(within(group).getByText(NOT_PAIR)).toBeVisible();
    expect(within(group).queryByRole('switch', { name: 'Left swap plus and minus' })).not.toBeInTheDocument();
  });

  it('on a Pod 5 hub, points to Tap gestures when the logo does something else and keeps the switch usable', async () => {
    const { posted, ui } = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.quadTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none' };
    }));
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(within(group).getByText(
      'The quad tap is set to another action under Bed and sides > Tap gestures, so the logo only stops alarms.',
    )).toBeVisible();
    await userEvent.click(within(group).getByRole('switch', { name: 'Left logo sets a temperature' }));
    expect(posted).toEqual([{ left: { taps: { quadTap: { type: 'set_temperature', temperatureF: 80 } } } }]);
  });

  it.each(['celsius', 'level'] as const)('posts a whole Fahrenheit logo temperature in %s mode', async (format) => {
    const { posted, ui } = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.temperatureFormat = format;
      settings.left.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
    }));
    renderWithProviders(ui);
    const group = await leftButtons();
    for (let i = 0; i < 3; i++) fireEvent.click(within(group).getByRole('button', { name: 'Increase left logo temperature' }));
    for (let i = 0; i < 3; i++) fireEvent.click(within(group).getByRole('button', { name: 'Decrease left logo temperature' }));
    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const values = posted.map(body => (body as { left: { taps: { quadTap: { temperatureF: number } } } }).left.taps.quadTap.temperatureF);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(55);
      expect(value).toBeLessThanOrEqual(110);
    }
  });

  it('on a Pod 5 hub, writes nothing for a side whose taps could not be read', async () => {
    const settings = fahrenheit();
    const { ui } = pod('Pod 5', 'Pod 5', { ...settings, left: { ...settings.left, taps: undefined } } as never);
    renderWithProviders(ui);
    const group = await leftButtons();
    expect(within(group).getByText('Could not read this side\'s button settings.')).toBeVisible();
    expect(within(group).queryByRole('switch')).not.toBeInTheDocument();
  });

});

describe('Cover buttons placement', () => {
  const bed = async (hubVersion: string, coverVersion: string) => {
    server.use(http.get('*/api/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion, coverVersion })));
    const { queryClient } = renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/bed' });
    await screen.findByRole('group', { name: 'Left side taps' });
    await waitFor(() => expect(queryClient.getQueryState(['useDeviceStatus'])?.status).toBe('success'));
  };
  const headings = () => screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent);

  it('on a Pod 5 hub, follows Tap gestures with the options and no switch', async () => {
    await bed('Pod 5', 'Pod 5');
    expect(headings().slice(0, 3)).toEqual(['Tap gestures', 'Cover buttons', 'Priming']);
    expect(screen.getByRole('group', { name: 'Left side buttons' })).toBeVisible();
    expect(screen.queryByRole('switch', { name: /cover buttons/i })).not.toBeInTheDocument();
  });

  it('on a Pod 4 hub with a Pod 5 cover, follows Tap gestures with the switch', async () => {
    await bed('Pod 4', 'Pod 5');
    expect(headings().slice(0, 2)).toEqual(['Tap gestures', 'Cover buttons']);
    expect(screen.getByRole('switch', { name: 'Read cover buttons' })).toBeInTheDocument();
  });

  it.each([
    ['Pod 3', 'Pod 3'], ['Pod 5', 'Pod 4'], ['Pod 4', 'Pod 4'], ['Pod 5', 'Version not found'], ['Version not found', 'Version not found'],
  ])(
    'shows nothing for cover buttons on a %s hub with a %s cover', async (hub, cover) => {
      await bed(hub, cover);
      expect(headings()).not.toContain('Cover buttons');
      expect(screen.queryByRole('switch', { name: /cover buttons/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/Pod 5 hub|Pod 4 hub/)).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Left side buttons' })).not.toBeInTheDocument();
    },
  );

  it('is not on Features', async () => {
    server.use(http.get('*/api/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion: 'Pod 4', coverVersion: 'Pod 5' })));
    renderWithProviders(<SettingsPage/>, { initialRoute: '/settings/features' });
    await screen.findByRole('switch', { name: 'One-time alarm' });
    expect(screen.queryByRole('switch', { name: /cover buttons/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cover buttons' })).not.toBeInTheDocument();
  });
});
