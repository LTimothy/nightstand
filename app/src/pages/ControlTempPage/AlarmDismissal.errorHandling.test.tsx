import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useControlTempStore } from './controlTempStore.tsx';
import { useAppStore } from '@state/appStore.tsx';
import AlarmDismissal from './AlarmDismissal';

// This test deliberately makes the dismiss reject; the app catches it, but the
// rejected request can surface as a transient unhandled rejection depending on
// timing. Swallow that expected rejection so it does not fail the run.
function swallowRejection(event: PromiseRejectionEvent) {
  event.preventDefault();
}

// Regression: dismissing an alarm must only hide the dialog once the dismiss
// actually succeeds. (Bug: setDismissed(true) ran in .finally unconditionally,
// so a failed dismiss closed the dialog while the pod could still be vibrating.)
describe('AlarmDismissal on a failed dismiss', () => {
  beforeEach(() => {
    window.addEventListener('unhandledrejection', swallowRejection);
    // Seed an active alarm on the left side so the dialog renders.
    useControlTempStore.setState({ deviceStatus: { left: { isAlarmVibrating: true } } } as never);
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', swallowRejection);
    useControlTempStore.setState({ deviceStatus: undefined, pendingEdits: 0 });
  });

  it('keeps the dismiss dialog open when the dismiss POST fails', async () => {
    server.use(
      http.post('*/deviceStatus', () => new HttpResponse(null, { status: 500 })),
    );

    const { user } = renderWithProviders(<AlarmDismissal refetch={ async () => {} } />);

    const dismiss = await screen.findByRole('button', { name: 'Dismiss alarm' });
    await user.click(dismiss);

    // Let the failed dismiss settle, then give any (buggy) dialog-close
    // transition time to complete before asserting: the MUI Dialog unmounts its
    // content after its exit animation, so an immediate check would still see
    // the button mid-transition and pass even when the dialog is closing.
    await waitFor(() => expect(useAppStore.getState().isUpdating).toBe(false), { timeout: 5000 });
    await new Promise(resolve => setTimeout(resolve, 500));

    // The dismiss failed, so the dialog must still be open.
    expect(screen.getByRole('button', { name: 'Dismiss alarm' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not dismiss/);
  });
});
