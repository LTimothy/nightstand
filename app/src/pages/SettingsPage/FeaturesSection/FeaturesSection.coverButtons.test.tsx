import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { getDeviceStatus, getSettings } from '../../../mocks/mockData';
import FeaturesSection from './FeaturesSection';

const fahrenheit = (change: (settings: ReturnType<typeof getSettings>) => void = () => {}) => {
  const settings = structuredClone({ ...getSettings(), temperatureFormat: 'fahrenheit' as const });
  change(settings);
  return settings;
};

function pod(hubVersion: string, coverVersion: string, settings = fahrenheit()) {
  const posted: unknown[] = [];
  server.use(
    http.get('*/api/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion, coverVersion })),
    http.get('*/api/settings', () => HttpResponse.json(settings)),
    http.post('*/api/settings', async ({ request }) => { posted.push(await request.json()); return HttpResponse.json(settings); }),
  );
  return posted;
}
const NOT_PAIR = 'Plus and minus are not a matching warmer and cooler pair. Set them under Bed and sides > Tap gestures.';
const leftButtons = () => screen.findByRole('group', { name: 'Left side buttons' });

describe('Cover buttons options', () => {
  it('on a Pod 4 hub with a Pod 5 cover, shows them only while the switch is on', async () => {
    pod('Pod 4', 'Pod 5');
    renderWithProviders(<FeaturesSection/>);
    await screen.findByRole('switch', { name: 'Cover buttons' });
    expect(screen.queryByRole('heading', { name: 'Cover buttons' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Left side buttons' })).not.toBeInTheDocument();
  });

  it('on a Pod 4 hub, saves the step, the swap and the logo temperature to the buttons settings', async () => {
    const posted = pod('Pod 4', 'Pod 5', fahrenheit(settings => { settings.features.coverButtons = true; }));
    renderWithProviders(<FeaturesSection/>);
    const group = await leftButtons();
    expect(screen.getByRole('group', { name: 'Right side buttons' })).toBeVisible();
    expect(within(group).queryByRole('switch', { name: 'Left logo sets a temperature' })).not.toBeInTheDocument();
    expect(within(group).getByText('When no alarm is ringing, the logo sets this and turns the side on.')).toBeVisible();
    await userEvent.click(within(group).getByRole('combobox', { name: 'Left Step per click' }));
    await userEvent.click(screen.getByRole('option', { name: '3°F' }));
    await userEvent.click(await within(await leftButtons()).findByRole('switch', { name: 'Left swap plus and minus' }));
    fireEvent.click(within(await leftButtons()).getByRole('button', { name: 'Increase left logo temperature' }));
    await screen.findByRole('switch', { name: 'Cover buttons' });
    expect(posted).toEqual([
      { left: { buttons: { stepF: 3 } } },
      { left: { buttons: { invertButtons: true } } },
      { left: { buttons: { favoriteTemperatureF: 81 } } },
    ]);
  });

  it('on a Pod 5 hub, shows a heading instead of a switch, explains the tap mapping and saves whole tap actions', async () => {
    const posted = pod('Pod 5', 'Pod 5');
    renderWithProviders(<FeaturesSection/>);
    expect(await screen.findByRole('heading', { level: 2, name: 'Cover buttons' })).toBeVisible();
    expect(screen.queryByRole('switch', { name: 'Cover buttons' })).not.toBeInTheDocument();
    expect(await screen.findByText(
      'Your Pod 5 hub handles the cover\'s buttons itself. These options change the tap actions it triggers: '
      + 'plus is a triple tap, minus a double tap, and the logo probably a quad tap (not yet checked on a Pod).',
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
    const posted = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
    }));
    renderWithProviders(<FeaturesSection/>);
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
    pod('Pod 5', 'Pod 5', settings);
    renderWithProviders(<FeaturesSection/>);
    const group = await leftButtons();
    expect(within(group).getByText(NOT_PAIR)).toBeVisible();
    expect(within(group).queryByRole('combobox', { name: 'Left Step per click' })).not.toBeInTheDocument();
  });

  it('on a Pod 5 hub, points to Tap gestures when plus and minus differ in amount', async () => {
    pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.doubleTap = { type: 'temperature', change: 'decrement', amount: 3 };
    }));
    renderWithProviders(<FeaturesSection/>);
    const group = await leftButtons();
    expect(within(group).getByText(NOT_PAIR)).toBeVisible();
    expect(within(group).queryByRole('switch', { name: 'Left swap plus and minus' })).not.toBeInTheDocument();
  });

  it('on a Pod 5 hub, points to Tap gestures when the logo does something else and keeps the switch usable', async () => {
    const posted = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.left.taps.quadTap = { type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none' };
    }));
    renderWithProviders(<FeaturesSection/>);
    const group = await leftButtons();
    expect(within(group).getByText('The logo is set to another action under Bed and sides > Tap gestures.')).toBeVisible();
    await userEvent.click(within(group).getByRole('switch', { name: 'Left logo sets a temperature' }));
    expect(posted).toEqual([{ left: { taps: { quadTap: { type: 'set_temperature', temperatureF: 80 } } } }]);
  });

  it.each(['celsius', 'level'] as const)('posts a whole Fahrenheit logo temperature in %s mode', async (format) => {
    const posted = pod('Pod 5', 'Pod 5', fahrenheit(settings => {
      settings.temperatureFormat = format;
      settings.left.taps.quadTap = { type: 'set_temperature', temperatureF: 77 };
    }));
    renderWithProviders(<FeaturesSection/>);
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
    pod('Pod 5', 'Pod 5', { ...settings, left: { ...settings.left, taps: undefined } } as never);
    renderWithProviders(<FeaturesSection/>);
    const group = await leftButtons();
    expect(within(group).getByText('Could not read this side\'s button settings.')).toBeVisible();
    expect(within(group).queryByRole('switch')).not.toBeInTheDocument();
  });

  it.each([['Pod 5', 'Pod 4'], ['Pod 4', 'Pod 4'], ['Pod 5', 'Version not found'], ['Version not found', 'Version not found']])(
    'shows nothing for cover buttons on a %s hub with a %s cover', async (hub, cover) => {
      pod(hub, cover);
      renderWithProviders(<FeaturesSection/>);
      await screen.findByRole('switch', { name: 'One-time alarm' });
      expect(screen.queryByRole('switch', { name: 'Cover buttons' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Cover buttons' })).not.toBeInTheDocument();
      expect(screen.queryByText(/cover's buttons/)).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Left side buttons' })).not.toBeInTheDocument();
    },
  );
});
