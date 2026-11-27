import { afterEach, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { createDemoRhythms, resetMockRhythms } from '../../../mocks/rhythmsMock';
import RhythmsLeaveNote from './RhythmsLeaveNote';
import RollbackRow from './RollbackRow';
import ReleaseRow from './ReleaseRow';
import RevertToStockRow from './RevertToStockRow';

const NOTE = 'Rhythms is on. Before the switch, each side goes back to the weekly schedule. '
  + 'A side in a rhythm sleep the weekly schedule does not cover stays on until that sleep ends, without its alarm. '
  + 'Your rhythms are kept.';

const release = (version: string) => ({ kind: 'agent', version, channel: 'stable', date: '2026-07-01' }) as const;

afterEach(() => resetMockRhythms());

it('says nothing while Rhythms is off', async () => {
  const { queryClient } = renderWithProviders(<RhythmsLeaveNote/>);
  await waitFor(() => expect(queryClient.getQueryData(['useSettings'])).toBeDefined());
  expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
});

it('adds the line to the rollback and switch dialogs while Rhythms is on', async () => {
  resetMockRhythms(createDemoRhythms(), true);
  const rollback = renderWithProviders(<RollbackRow runningVersion="3.5.0" rollbackVersion="3.4.0"/>);
  await rollback.user.click(screen.getByRole('button', { name: 'Go back to v3.4.0 Instant, no download' }));
  expect(await screen.findByText(NOTE)).toBeInTheDocument();
  rollback.unmount();
  const revert = renderWithProviders(<RevertToStockRow runningVersion="3.5.0"/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to upstream free-sleep' })).toBeEnabled());
  await revert.user.click(screen.getByRole('button', { name: 'Switch to upstream free-sleep' }));
  expect(await screen.findByText(NOTE)).toBeInTheDocument();
});

it('adds the line to a downgrade below 3.5.0 only', async () => {
  resetMockRhythms(createDemoRhythms(), true);
  const older = renderWithProviders(<ReleaseRow release={ release('3.4.0') } runningVersion="3.5.1"/>);
  await older.user.click(screen.getByRole('button', { name: 'Install (downgrade)' }));
  expect(await screen.findByText(NOTE)).toBeInTheDocument();
  older.unmount();
  const newer = renderWithProviders(<ReleaseRow release={ release('3.5.0') } runningVersion="3.5.1"/>);
  await newer.user.click(screen.getByRole('button', { name: 'Install (downgrade)' }));
  await screen.findByRole('dialog');
  await waitFor(() => expect(newer.queryClient.getQueryData(['useSettings'])).toBeDefined());
  expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
});

it('skips the line for a rollback target that continues a rhythm sleep itself', async () => {
  resetMockRhythms(createDemoRhythms(), true);
  const { user, queryClient } = renderWithProviders(<RollbackRow runningVersion="3.6.0" rollbackVersion="3.5.0"/>);
  await user.click(screen.getByRole('button', { name: 'Go back to v3.5.0 Instant, no download' }));
  await screen.findByRole('dialog');
  await waitFor(() => expect(queryClient.getQueryData(['useSettings'])).toBeDefined());
  expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
});
