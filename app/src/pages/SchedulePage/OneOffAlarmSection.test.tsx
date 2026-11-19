import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import OneOffAlarmSection from './OneOffAlarmSection';
import { getDeviceStatus, getSettings } from '../../mocks/mockData';

describe('OneOffAlarmSection', () => {
  it('posts the one-time alarm to the left side on save', async () => {
    let posted: any;
    server.use(
      http.post('*/settings', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({});
      }),
    );

    const { user } = renderWithProviders(<OneOffAlarmSection />, { initialRoute: '/schedules' });

    // The section renders its heading once settings load.
    expect(await screen.findByText(/Rings once for/)).toHaveTextContent('Rings once for Alex');

    await user.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    fireEvent.change(screen.getByLabelText('Ring at'), { target: { value: '2099-01-02T07:30' } });
    await user.click(screen.getByRole('button', { name: 'Save one-time alarm' }));

    await waitFor(() => expect(posted).toBeTruthy());
    expect(posted.left).toBeTruthy();
    expect(posted.left.oneOffAlarm).toBeTruthy();
    expect(posted.left.oneOffAlarm.enabled).toBe(true);
    expect(posted.left.oneOffAlarm).toHaveProperty('vibrationPattern');
    expect(posted.left.oneOffAlarm).toHaveProperty('duration');
  });
});

it('offers whole-second lengths, labels strength and shows the friendly Pod timezone', async () => {
  renderWithProviders(<OneOffAlarmSection/>);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
  expect(screen.getByRole('slider', { name: /Strength/ })).toBeInTheDocument();
  expect(screen.getByText(/Timezone: Pacific Time/)).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Length' }));
  expect(screen.getByRole('option', { name: '3 minutes' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: '4 minutes' })).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton', { name: 'Length' })).not.toBeInTheDocument();
});

it('reads and saves times in UTC while the Pod has no time zone set', async () => {
  let posted: any;
  server.use(
    http.get('*/settings', () => HttpResponse.json({ ...getSettings(), timeZone: null })),
    http.post('*/settings', async ({ request }) => { posted = await request.json(); return HttpResponse.json({}); }),
  );
  renderWithProviders(<OneOffAlarmSection/>);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
  fireEvent.change(screen.getByLabelText('Ring at'), { target: { value: '2099-01-02T07:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save one-time alarm' }));
  await waitFor(() => expect(posted).toBeTruthy());
  expect(posted.left.oneOffAlarm.fireAt).toBe('2099-01-02T07:30:00Z');
});

describe('pattern by Pod model', () => {
  const note = 'Builds up needs a Pod 5 hub and cover, so alarms on this Pod use Double pulse.';

  it('offers Builds up on a Pod 5', async () => {
    renderWithProviders(<OneOffAlarmSection/>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    const pattern = screen.getByRole('combobox', { name: 'Pattern' });
    await waitFor(() => expect(pattern).toHaveTextContent('Builds up'));
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it.each([
    ['Pod 3', 'Pod 5'], ['Pod 4', 'Pod 5'], ['Version not found', 'Pod 5'],
    ['Pod 5', 'Pod 3'], ['Pod 5', 'Pod 4'], ['Pod 5', 'Version not found'],
  ])('disables Builds up for hub %s and cover %s', async (hubVersion, coverVersion) => {
    server.use(http.get('*/deviceStatus', () => HttpResponse.json({ ...getDeviceStatus(), hubVersion, coverVersion })));
    renderWithProviders(<OneOffAlarmSection/>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    expect(await screen.findByText(note)).toBeInTheDocument();
    const pattern = screen.getByRole('combobox', { name: 'Pattern' });
    expect(pattern).toHaveTextContent('Double pulse');
    fireEvent.mouseDown(pattern);
    expect(screen.getByRole('option', { name: 'Builds up' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Save while the alarm is off', () => {
  it('stays unavailable until Enabled is on', async () => {
    renderWithProviders(<OneOffAlarmSection/>);
    const toggle = await screen.findByRole('switch', { name: 'Enable one-time alarm' });
    expect(screen.getByRole('button', { name: 'Save one-time alarm' })).toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Ring at'), { target: { value: '2099-01-02T07:30' } });
    expect(screen.getByRole('button', { name: 'Save one-time alarm' })).toBeEnabled();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Save one-time alarm' })).toBeDisabled();
  });

  it('is available to switch a saved alarm off', async () => {
    const settings = getSettings();
    settings.left.oneOffAlarm = { ...settings.left.oneOffAlarm, enabled: true, fireAt: '2099-01-02T07:30:00-08:00' };
    server.use(http.get('*/settings', () => HttpResponse.json(settings)));
    renderWithProviders(<OneOffAlarmSection/>);
    const toggle = await screen.findByRole('switch', { name: 'Enable one-time alarm' });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Save one-time alarm' })).toBeEnabled();
  });
});

it('says it rings only if the side is on at that time', async () => {
  renderWithProviders(<OneOffAlarmSection/>);
  expect(await screen.findByText(/Rings once for/)).toHaveTextContent(
    'Rings once for Alex, then turns off. Rings only if this side is on at that time. Saved separately from this schedule.',
  );
});
