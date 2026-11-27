import { getDeviceStatus } from '../../../mocks/mockData';
import { useState, type Dispatch, type SetStateAction, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import UpdateFreeSleepButton from '../DeviceSettingsSection/UpdateFreeSleepButton';
import ReleaseRow from './ReleaseRow';
import RollbackRow from './RollbackRow';
import RevertToStockRow from './RevertToStockRow';
import targetFixtures from '../../../../../scripts/tests/fixtures/upstream_targets.json';

const release = { kind: 'agent', version: '3.2.0', channel: 'stable', date: '2026-09-28' } as const;
const cases = [
  { name: 'update', open: 'Update to v3.2.0', title: 'Update to v3.2.0?', confirm: 'Update now', log: 'update',
    render: (runningVersion: string) => <UpdateFreeSleepButton runningVersion={ runningVersion }/> },
  { name: 'release install', open: 'Install', title: 'Install v3.2.0?', confirm: 'Install now', log: 'update',
    render: (runningVersion: string) => <ReleaseRow runningVersion={ runningVersion } release={ release }/> },
  { name: 'rollback', open: 'Go back to v2.9.0 Instant, no download',
    title: 'Go back to v2.9.0?', confirm: 'Go back now', log: 'rollback',
    render: (runningVersion: string) => <RollbackRow runningVersion={ runningVersion } rollbackVersion="2.9.0"/> },
  { name: 'upstream restore', open: 'Switch to upstream free-sleep',
    title: 'Switch to upstream free-sleep?', confirm: 'Switch now', log: 'revert',
    render: (runningVersion: string) => <RevertToStockRow runningVersion={ runningVersion }/> },
];

let refreshVersion: Dispatch<SetStateAction<string>>;
function Subject({ render }: { render: (version: string) => ReactElement }) {
  const [version, setVersion] = useState('3.0.0');
  refreshVersion = setVersion;
  return render(version);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'], releases: [release], upstreamSwitchV2: targetFixtures[1].expected,
    })),
    http.get('*/deviceStatus', () => HttpResponse.json({
      ...getDeviceStatus(), freeSleep: { ...getDeviceStatus().freeSleep, version: '3.0.0' },
    })),
    http.post('*/update', () => new HttpResponse(null, { status: 204 })),
    http.post('*/update/:action', () => new HttpResponse(null, { status: 204 })),
  );
});
afterEach(() => vi.useRealTimers());

for (const scenario of cases) {
  it(`${scenario.name} timeout offers named in-app recovery links and the latest reported version`, async () => {
    const { user } = renderWithProviders(<Subject render={ scenario.render }/>);
    await waitFor(() => expect(screen.getByRole('button', { name: scenario.open })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: scenario.open }));
    const initial = await screen.findByRole('dialog', { name: scenario.title });
    await user.click(within(initial).getByRole('button', { name: scenario.confirm }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10_000); });
    const dialog = screen.getByRole('dialog', { name: 'Still not done' });
    expect(within(dialog).getByRole('link', { name: 'Open update logs' }))
      .toHaveAttribute('href', `/settings/logs?file=free-sleep-${scenario.log}.log`);
    expect(within(dialog).getByRole('link', { name: 'System status' })).toHaveAttribute('href', '/settings/system');
    expect(dialog).toHaveTextContent(/not confirmed/i);
    expect(dialog).toHaveTextContent('Last reported running version: v3.0.0');
    act(() => refreshVersion('3.0.1'));
    expect(dialog).toHaveTextContent('Last reported running version: v3.0.1');
  });
}
