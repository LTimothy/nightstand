import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import BaseControlPage from './BaseControlPage';
import { MemoryRouter } from 'react-router-dom';

const status = vi.hoisted(() => ({ dataUpdatedAt: 0, data: { head: 0, feet: 0, isMoving: false, isConfigured: true } }));
const api = vi.hoisted(() => ({ position: vi.fn(async () => {}), preset: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock('@api/baseControl', () => ({
  useBaseConfigured: () => true,
  useBaseStatus: () => ({ data: status.data, dataUpdatedAt: status.dataUpdatedAt, isLoading: false }),
  useSetBasePosition: () => ({ mutateAsync: api.position, isPending: false }),
  useSetBasePreset: () => ({ mutateAsync: api.preset, isPending: false }),
  useStopBase: () => ({ mutateAsync: api.stop, isPending: false }),
}));
function renderControls() {
  return render(<MemoryRouter initialEntries={ ['/elevation'] }><BaseControlPage /></MemoryRouter>);
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); status.data = { head: 0, feet: 0, isMoving: false, isConfigured: true }; });
afterEach(() => vi.useRealTimers());

it('cancels a queued manual command when Stop is requested', async () => {
  renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /stop movement/i })));
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(api.stop).toHaveBeenCalledTimes(1);
  expect(api.position).not.toHaveBeenCalled();
});

it('a preset supersedes the queued manual position', async () => {
  renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Relax/ })));
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(api.preset).toHaveBeenCalledWith('relax');
  expect(api.position).not.toHaveBeenCalled();
});

it('cancels queued manual movement on unmount', async () => {
  const view = renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(api.position).not.toHaveBeenCalled();
});

it('reconciles a stationary already-flat command without requiring status changes', async () => {
  renderControls();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /Flat/ })));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(screen.queryByText('Base is moving...')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Relax/ })).toBeEnabled();
});

it('names manual controls for their axis and direction', () => {
  renderControls();
  expect(screen.getByRole('button', { name: 'Increase head angle' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Decrease feet angle' })).toBeDisabled();
});

it('a late request failure cannot restore movement after Stop', async () => {
  let rejectPosition!: (error: Error) => void;
  api.position.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPosition = reject; }));
  renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop movement' })));
  await act(async () => rejectPosition(new Error('late request failure')));
  expect(screen.queryByRole('button', { name: 'Stop movement' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('retains the requested target between sending and reported movement', async () => {
  renderControls();
  for (let count = 0; count < 10; count++) fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(api.position).toHaveBeenLastCalledWith({ head: 10, feet: 0, feedRate: 50 });
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(api.position).toHaveBeenLastCalledWith({ head: 11, feet: 0, feedRate: 50 });
});
it('allows presets after Stop fails while keeping Stop available', async () => {
  api.stop.mockRejectedValueOnce(new Error('offline'));
  renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop movement' })));
  expect(screen.getByRole('button', { name: /Relax/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop movement' })).toBeEnabled();
});


it.each(['position', 'preset'])('clears a failed Stop after a successful %s command settles', async (command) => {
  api.stop.mockRejectedValueOnce(new Error('offline'));
  renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop movement' })));
  expect(screen.getByRole('button', { name: 'Stop movement' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: command === 'position' ? 'Increase head angle' : /Relax/ }));
  await act(async () => vi.advanceTimersByTimeAsync(3100));
  expect(screen.queryByRole('button', { name: 'Stop movement' })).not.toBeInTheDocument();
});

it.each([true, false])('clears a failed Stop on fresh stationary status after moving was %s', async (isMoving) => {
  status.data = { ...status.data, isMoving };
  api.stop.mockRejectedValueOnce(new Error('offline'));
  const view = renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Increase head angle' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop movement' })));
  expect(screen.getByRole('button', { name: 'Stop movement' })).toBeEnabled();
  status.data = { ...status.data, isMoving: false };
  status.dataUpdatedAt += 1;
  view.rerender(<MemoryRouter initialEntries={ ['/elevation'] }><BaseControlPage/></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Stop movement' })).not.toBeInTheDocument();
});
