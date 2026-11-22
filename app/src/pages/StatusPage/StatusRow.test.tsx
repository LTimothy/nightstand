import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import StatusRow from './StatusRow';

const status = {
  name: 'Analyze sleep left', status: 'healthy', description: '', message: '', timestamp: '2026-09-28T06:00:00Z',
} as const;

describe('manual diagnostic jobs', () => {
  it('reports a rejected job and enables retry immediately', async () => {
    server.use(http.post('*/jobs', () => new HttpResponse(null, { status: 500 })));
    const { user } = renderWithProviders(<StatusRow job="analyzeSleepLeft" statusInfo={ status } divider={ false }/>);
    await user.click(screen.getByRole('button', { name: 'Analyze left-side sleep' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start');
    expect(screen.getByRole('button', { name: 'Analyze left-side sleep' })).toBeEnabled();
  });
  it('says a refused duplicate is already queued or running, not failed', async () => {
    server.use(http.post('*/jobs', () => HttpResponse.json({ message: 'Already queued or running: analyzeSleepLeft' }, { status: 409 })));
    const { user } = renderWithProviders(<StatusRow job="analyzeSleepLeft" statusInfo={ status } divider={ false }/>);
    await user.click(screen.getByRole('button', { name: 'Analyze left-side sleep' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Already queued or running.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
  });
  it('reports acceptance without claiming completion from the POST alone', async () => {
    server.use(http.post('*/jobs', () => new HttpResponse(null, { status: 204 })));
    const { user } = renderWithProviders(<StatusRow job="analyzeSleepLeft" statusInfo={ status } divider={ false }/>);
    await user.click(screen.getByRole('button', { name: 'Analyze left-side sleep' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Request accepted');
    expect(screen.getByRole('status')).not.toHaveTextContent('Completed');
  });
  it('requires an empty-side confirmation before manual calibration', async () => {
    let posted = false;
    server.use(http.post('*/jobs', () => { posted = true; return new HttpResponse(null, { status: 204 }); }));
    const { user } = renderWithProviders(<StatusRow job="biometricsCalibrationLeft" statusInfo={ status } divider={ false }/>);
    await user.click(screen.getByRole('button', { name: 'Calibrate left presence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Calibrate left presence?' });
    expect(dialog).toHaveTextContent('Keep the left side empty');
    expect(posted).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Calibrate left presence' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Request accepted');
  });
});


it('labels the Web server timestamp as its startup time', () => {
  renderWithProviders(<StatusRow job="express" statusInfo={ { ...status, name: 'Express' } } divider={ false }/>);
  expect(screen.getByText(/^Started .+/)).toBeVisible();
});

describe('status text', () => {
  it('shows a healthy message instead of the canned meaning, without error styling', () => {
    const statusInfo = { ...status, message: 'No sleep found between Sep 29 22:00 and Sep 30 09:30.' };
    renderWithProviders(<StatusRow job="analyzeSleepLeft" statusInfo={ statusInfo } divider={ false }/>);
    expect(screen.getByText(/No sleep found between/)).toBeVisible();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Finished analyzing the most recent sleep session.')).not.toBeInTheDocument();
  });
  it('keeps the canned meaning for a healthy status with no message', () => {
    renderWithProviders(<StatusRow job="analyzeSleepLeft" statusInfo={ status } divider={ false }/>);
    expect(screen.getByText('Finished analyzing the most recent sleep session.')).toBeVisible();
  });
  it('shows why boot settings are missing instead of the canned meaning', () => {
    const statusInfo = { ...status, name: 'Boot rescue', status: 'not_started', message: 'Boot settings could not be read.' } as const;
    renderWithProviders(<StatusRow job="bootRescue" statusInfo={ statusInfo } divider={ false }/>);
    expect(screen.getByText('Boot settings could not be read.')).toBeVisible();
    expect(screen.queryByText('Boot settings not read yet.')).not.toBeInTheDocument();
  });
});

describe('cover sensors', () => {
  const silent = {
    name: 'Cover sensors', status: 'failed', description: '', timestamp: '2026-09-28T06:00:00Z',
    message: 'The right side of the cover has sent no readings since 1:05 AM. Its buttons and bed sensors may not respond. '
      + 'Heating and cooling are not affected.',
  } as const;

  it('offers the restart only when the server allows it, and posts it', async () => {
    let posted: unknown;
    server.use(http.post('*/jobs', async ({ request }) => { posted = await request.json(); return new HttpResponse(null, { status: 204 }); }));
    const { user } = renderWithProviders(
      <StatusRow job="coverHealth" statusInfo={ { ...silent, coverRestore: { available: true, note: '' } } } divider={ false }/>);
    expect(screen.getByText(/The right side of the cover has sent no readings/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restart the cover service' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Restarted.');
    expect(posted).toEqual(['coverHealth']);
  });

  it('shows the note without a button when the restart cannot run', () => {
    const note = 'Not while an alarm is ringing or due in the next 10 minutes.';
    renderWithProviders(<StatusRow job="coverHealth" statusInfo={ { ...silent, coverRestore: { available: false, note } } } divider={ false }/>);
    expect(screen.getByText(note)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Restart the cover service' })).not.toBeInTheDocument();
  });

  it('shows no button while healthy', () => {
    renderWithProviders(<StatusRow job="coverHealth" statusInfo={ { ...silent, status: 'healthy', message: '' } } divider={ false }/>);
    expect(screen.getByText('Both sides of the cover are reporting.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows why the server refused a restart', async () => {
    server.use(http.post('*/jobs', () => HttpResponse.json({ message: 'Not while the Pod is priming.' }, { status: 409 })));
    const { user } = renderWithProviders(
      <StatusRow job="coverHealth" statusInfo={ { ...silent, coverRestore: { available: true, note: '' } } } divider={ false }/>);
    await user.click(screen.getByRole('button', { name: 'Restart the cover service' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Not while the Pod is priming.');
  });
});
