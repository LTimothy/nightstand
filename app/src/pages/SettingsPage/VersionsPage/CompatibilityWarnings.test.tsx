import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import ReleaseRow from './ReleaseRow';
import RevertToStockRow from './RevertToStockRow';

it('explains downgrade behavior before installation', async () => {
  const release = { kind: 'bundle', version: '3.2.2', upstreamBase: '2.1.5', channel: 'stable', date: '2026-01-01', features: [] } as const;
  const { user } = renderWithProviders(<ReleaseRow release={ { ...release, features: [] } } runningVersion="3.5.0"/>);
  await user.click(screen.getByRole('button', { name: 'Install (downgrade)' }));
  expect(screen.getByText(/Presence auto-off cannot be switched off/)).toBeInTheDocument();
  expect(screen.getByText('Version 3.2.2 keeps sensor recordings for at most 14 days and does not check free space.')).toBeInTheDocument();
  expect(screen.getByText(/older firewall/)).toBeInTheDocument();
  expect(screen.getByText(/Rhythms and pause/)).toBeInTheDocument();
});

it('names backups, retained components, and upstream recovery hazards', async () => {
  const { user } = renderWithProviders(<RevertToStockRow runningVersion="3.4.0"/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
  expect(screen.getByText(/free-sleep-database-backups/)).toBeInTheDocument();
  expect(screen.getByText(/Do not follow/)).toBeInTheDocument();
  expect(screen.getByText(/Tailscale/)).toBeInTheDocument();
  expect(screen.getByText(/sudoers/)).toBeInTheDocument();
  expect(screen.getByText(/first enabled alarm/)).toBeInTheDocument();
});

it('does not render an empty warning for a downgrade with no compatibility differences', async () => {
  const release = { kind: 'agent', version: '3.4.0', channel: 'stable', date: '2026-01-01' } as const;
  const { user } = renderWithProviders(<ReleaseRow release={ release } runningVersion="3.4.1"/>);
  await user.click(screen.getByRole('button', { name: 'Install (downgrade)' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
