import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import OneOffAlarmSection from './OneOffAlarmSection';
import { getDeviceStatus, getSettings } from '../../mocks/mockData';
import { useAppStore } from '@state/appStore';

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

const openVibration = () => fireEvent.click(screen.getByRole('button', { name: /^Vibrate:/ }));

const savedAlarm = (vibrationPattern: 'rise' | 'double', fireAt: string) => {
  const settings = structuredClone(getSettings());
  settings.left.oneOffAlarm = { ...settings.left.oneOffAlarm, vibrationPattern, fireAt };
  return settings;
};

it('offers whole-second lengths, labels strength and shows the friendly Pod timezone', async () => {
  renderWithProviders(<OneOffAlarmSection/>);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
  expect(screen.getByText(/Timezone: Pacific Time/)).toBeInTheDocument();
  openVibration();
  expect(screen.getByRole('slider', { name: /Strength/ })).toBeInTheDocument();
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
    server.use(http.get('*/settings', () => HttpResponse.json(savedAlarm('rise', '2099-01-02T07:30:00-08:00'))));
    renderWithProviders(<OneOffAlarmSection/>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Vibrate: Builds up/ })).toBeInTheDocument());
    openVibration();
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
    openVibration();
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
    const settings = structuredClone(getSettings());
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

it('leaves out the side-on sentence while alarms ring with the side off', async () => {
  const settings = structuredClone(getSettings());
  settings.features = { ...settings.features, alarmsWhenOff: true };
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  renderWithProviders(<OneOffAlarmSection/>);
  expect(await screen.findByText(/Rings once for/)).toHaveTextContent(
    'Rings once for Alex, then turns off. Saved separately from this schedule.',
  );
});

describe('pattern of a new alarm', () => {
  const savedPattern = async (settings: ReturnType<typeof getSettings>) => {
    let posted: ReturnType<typeof getSettings> | undefined;
    server.use(
      http.get('*/settings', () => HttpResponse.json(settings)),
      http.post('*/settings', async ({ request }) => {
        posted = await request.json() as ReturnType<typeof getSettings>;
        return HttpResponse.json({});
      }),
    );
    renderWithProviders(<OneOffAlarmSection/>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    fireEvent.change(screen.getByLabelText('Ring at'), { target: { value: '2099-01-02T07:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save one-time alarm' }));
    await waitFor(() => expect(posted).toBeTruthy());
    return posted?.left.oneOffAlarm.vibrationPattern;
  };

  it('saves a double pulse for an alarm that was never saved', async () => {
    expect(await savedPattern(savedAlarm('rise', ''))).toBe('double');
  });

  it('keeps Builds up on an alarm saved with it', async () => {
    expect(await savedPattern(savedAlarm('rise', '2026-01-02T07:30:00-08:00'))).toBe('rise');
  });
});

it('tests the vibration on screen without saving or needing a time', async () => {
  let settingsPosts = 0;
  const alarms: unknown[] = [];
  server.use(
    http.post('*/settings', () => { settingsPosts += 1; return HttpResponse.json({}); }),
    http.post('*/alarm', async ({ request }) => { alarms.push(await request.json()); return HttpResponse.json({}); }),
  );
  renderWithProviders(<OneOffAlarmSection/>);
  fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
  openVibration();
  fireEvent.change(screen.getByRole('slider', { name: /Strength/ }), { target: { value: '55' } });
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  await waitFor(() => expect(alarms).toHaveLength(1));
  expect(alarms[0]).toMatchObject({ side: 'left', vibrationIntensity: 55, vibrationPattern: 'double', duration: 10, force: true });
  expect(settingsPosts).toBe(0);
});

it('keeps the saved note and Save state after a test', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00Z'));
  try {
    const stored = structuredClone(getSettings());
    server.use(
      http.get('*/settings', () => HttpResponse.json(stored)),
      http.post('*/settings', async ({ request }) => {
        stored.left.oneOffAlarm = ((await request.json()) as typeof stored).left.oneOffAlarm;
        return HttpResponse.json(stored);
      }),
      http.post('*/alarm', () => HttpResponse.json({})),
    );
    renderWithProviders(<OneOffAlarmSection/>);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable one-time alarm' }));
    fireEvent.change(screen.getByLabelText('Ring at'), { target: { value: '2099-01-02T07:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save one-time alarm' }));
    expect(await screen.findByRole('status')).toHaveTextContent('One-time alarm saved for Alex.');
    openVibration();
    fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
    await screen.findByText('Alarm running now...');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('One-time alarm saved for Alex.');
    expect(screen.getByRole('button', { name: 'Save one-time alarm' })).toBeEnabled();
  } finally {
    vi.useRealTimers();
  }
});

it('locks the alarm while the Pod is updating', async () => {
  const settings = savedAlarm('double', '2099-01-02T07:30:00-08:00');
  settings.left.oneOffAlarm.enabled = true;
  server.use(http.get('*/settings', () => HttpResponse.json(settings)));
  useAppStore.setState({ isUpdating: true });
  try {
    renderWithProviders(<OneOffAlarmSection/>);
    expect(await screen.findByRole('switch', { name: 'Enable one-time alarm' })).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('Ring at')).toBeDisabled());
    expect(screen.getByRole('button', { name: /^Vibrate:/ })).toBeDisabled();
  } finally {
    useAppStore.setState({ isUpdating: false });
  }
});
