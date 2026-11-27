import { afterEach, describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import ReleaseRow from './ReleaseRow';
import RollbackRow from './RollbackRow';
import RevertToStockRow from './RevertToStockRow';
import targetFixtures from '../../../../../scripts/tests/fixtures/upstream_targets.json';

// A failure learned from the record the scripts leave is not a refused
// request, so the dialog names the operation that did not finish.
const release = { kind: 'agent', version: '3.4.0', channel: 'stable', date: '2026-07-01' } as const;

const serve = (operation: string, route: string) => {
  let reads = 0;
  const record = (runId: string) => ({ runId, operation, outcome: 'stopped', from: '3.3.0', to: '3.4.0',
    message: 'low disk', finishedAt: '2026-10-02T03:04:05Z' });
  server.use(
    http.post(route, () => new HttpResponse(null, { status: 204 })),
    http.get('*/update/last-result', () => HttpResponse.json(record(reads++ === 0 ? 'old' : 'new'))),
  );
};
const afterPoll = () => act(async () => { await vi.advanceTimersByTimeAsync(5_100); });

describe('the dialog title after a recorded failure', () => {
  afterEach(() => vi.useRealTimers());

  it('says the update did not finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve('update', '*/update');
    const { user } = renderWithProviders(<ReleaseRow release={ release } runningVersion="3.3.0"/>);
    await user.click(screen.getByRole('button', { name: 'Install' }));
    await user.click(await screen.findByRole('button', { name: 'Install now' }));
    await afterPoll();
    expect(await screen.findByText('Update did not finish')).toBeVisible();
    expect(screen.queryByText('Request failed')).not.toBeInTheDocument();
  });

  it('says the rollback did not finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve('rollback', '*/update/rollback');
    const { user } = renderWithProviders(<RollbackRow runningVersion="3.3.0" rollbackVersion="3.2.0"/>);
    await user.click(screen.getByRole('button', { name: 'Go back to v3.2.0 Instant, no download' }));
    await user.click(await screen.findByRole('button', { name: 'Go back now' }));
    await afterPoll();
    expect(await screen.findByText('Rollback did not finish')).toBeVisible();
  });

  it('says the switch did not finish', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve('switch', '*/update/switch-to-upstream');
    server.use(http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
      () => HttpResponse.json(targetFixtures[1].manifest)));
    const { user } = renderWithProviders(<RevertToStockRow runningVersion="3.3.0"/>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
    await user.click(await screen.findByRole('button', { name: 'Switch now' }));
    await afterPoll();
    expect(await screen.findByText('Switch did not finish')).toBeVisible();
  });

  it('still says the request failed when the request was refused', async () => {
    server.use(http.post('*/update/rollback', () => HttpResponse.json({ error: 'Refused' }, { status: 400 })));
    const { user } = renderWithProviders(<RollbackRow runningVersion="3.3.0" rollbackVersion="3.2.0"/>);
    await user.click(screen.getByRole('button', { name: 'Go back to v3.2.0 Instant, no download' }));
    await user.click(await screen.findByRole('button', { name: 'Go back now' }));
    expect(await screen.findByText('Request failed')).toBeVisible();
  });
});
