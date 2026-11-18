import type { ReactNode } from 'react';
import { act, fireEvent, render as baseRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TemperatureButtons from './TemperatureButtons';
import { useAppStore } from '@state/appStore';
import { useControlTempStore } from './controlTempStore';
import { getDeviceStatus } from '../../mocks/mockData';
import { TemperatureFormat } from '@lib/temperatureConversions';

const api = vi.hoisted(() => ({ post: vi.fn() }));
const preferences = vi.hoisted(() => ({ format: 'fahrenheit' as TemperatureFormat }));
vi.mock('@api/deviceStatus.ts', () => ({ postDeviceStatus: api.post, useDeviceStatus: () => ({ data: undefined }) }));
vi.mock('@api/settings.ts', () => ({
  useSettings: () => ({ data: { temperatureFormat: preferences.format, left: { awayMode: false }, right: { awayMode: false } } }),
}));
let queryClient: QueryClient;
const render = (ui: ReactNode) =>
  baseRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={ queryClient }>{ children }</QueryClientProvider> });
beforeEach(() => {
  queryClient = new QueryClient();
  vi.useFakeTimers();
  preferences.format = 'fahrenheit';
  api.post.mockReset().mockResolvedValue({});
  useAppStore.setState({ side: 'left', isUpdating: false });
  useControlTempStore.setState({
    deviceStatus: { ...getDeviceStatus(), left: { ...getDeviceStatus().left, targetTemperatureF: 80 } }, pendingEdits: 0,
  });
});
afterEach(() => vi.useRealTimers());
it('queues taps while a previous temperature request is pending', async () => {
  let resolve!: () => void;
  api.post.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  const increase = screen.getByRole('button', { name: 'Warmer' });
  fireEvent.click(increase);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledWith({ left: { targetTemperatureF: 81 } });
  expect(increase).not.toHaveAttribute('aria-disabled');
  fireEvent.click(increase);
  fireEvent.click(increase);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(); await vi.advanceTimersByTimeAsync(2000); });
  expect(api.post).toHaveBeenLastCalledWith({ left: { targetTemperatureF: 83 } });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(useControlTempStore.getState().pendingEdits).toBe(0);
});
it('reverts a failed request to the latest reported target', async () => {
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  act(() => useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 86 } }));
  view.rerender(<TemperatureButtons currentTargetTemp={ 86 } refetch={ vi.fn() }/>);
  api.post.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(86);
});
it('drops a queued temperature write when status becomes unavailable', async () => {
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  view.rerender(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() } statusUnavailable/>);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).not.toHaveBeenCalled();
  expect(useControlTempStore.getState().pendingEdits).toBe(0);
  expect(screen.getByRole('button', { name: 'Warmer' })).toHaveAttribute('aria-disabled', 'true');
});

it.each(['Warmer', 'Cooler'])('restores the exact 60 F target after a level %s and its inverse', async first => {
  preferences.format = 'level';
  useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 60 } });
  render(<TemperatureButtons currentTargetTemp={ 60 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: first }));
  fireEvent.click(screen.getByRole('button', { name: first === 'Warmer' ? 'Cooler' : 'Warmer' }));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(60);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledExactlyOnceWith({ left: { targetTemperatureF: 60 } });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(useControlTempStore.getState().pendingEdits).toBe(0);
});

it('discards level history after an external target changes away and back', () => {
  preferences.format = 'level';
  useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 60 } });
  render(<TemperatureButtons currentTargetTemp={ 60 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(63);
  act(() => useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 70 } }));
  act(() => useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 63 } }));
  fireEvent.click(screen.getByRole('button', { name: 'Cooler' }));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(61);
});

it('does not carry level history across sides with matching targets', () => {
  preferences.format = 'level';
  useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 60 }, right: { targetTemperatureF: 63 } });
  render(<TemperatureButtons currentTargetTemp={ 60 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  act(() => useAppStore.setState({ side: 'right' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cooler' }));
  expect(useControlTempStore.getState().deviceStatus?.right.targetTemperatureF).toBe(61);
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(63);
});

it('discards level history when the display format changes away and back', () => {
  preferences.format = 'level';
  useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 60 } });
  const view = render(<TemperatureButtons currentTargetTemp={ 60 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  preferences.format = 'celsius';
  view.rerender(<TemperatureButtons currentTargetTemp={ 63 } refetch={ vi.fn() }/>);
  preferences.format = 'level';
  view.rerender(<TemperatureButtons currentTargetTemp={ 63 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Cooler' }));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(61);
});
it('sends a pending change when the side switches before the delay ends', async () => {
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith({ left: { targetTemperatureF: 82 } });
});
it('sends a change queued behind an in-flight request when the side switches', async () => {
  let resolve!: () => void;
  api.post.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  const increase = screen.getByRole('button', { name: 'Warmer' });
  fireEvent.click(increase);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  fireEvent.click(increase);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  view.unmount();
  await act(async () => { resolve(); await vi.advanceTimersByTimeAsync(2000); });
  expect(api.post).toHaveBeenLastCalledWith({ left: { targetTemperatureF: 82 } });
});
it('drops a pending change when the side is turned off, and leaves the power save to its owner', async () => {
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  // The power button's save is in flight and owns the flag.
  act(() => {
    useControlTempStore.getState().setDeviceStatus({ left: { isOn: false } });
    useAppStore.setState({ isUpdating: true });
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.post).not.toHaveBeenCalled();
  expect(useControlTempStore.getState().pendingEdits).toBe(0);
  expect(useAppStore.getState().isUpdating).toBe(true);
  // The unsent value no longer shows as the target.
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(80);
});
it('does not flush a pending change on unmount once the side is off', async () => {
  const view = render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  act(() => useControlTempStore.getState().setDeviceStatus({ left: { isOn: false } }));
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.post).not.toHaveBeenCalled();
});
it('reads the live Smart Schedule state again after a set point', async () => {
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(<TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() }/>);
  fireEvent.click(screen.getByRole('button', { name: 'Warmer' }));
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['useRhythmsLive'] });
});
it('keeps focus on Warmer when it reaches the warmest level, and ignores further presses', async () => {
  useControlTempStore.setState({
    deviceStatus: { ...getDeviceStatus(), left: { ...getDeviceStatus().left, targetTemperatureF: 109 } }, pendingEdits: 0,
  });
  render(<TemperatureButtons currentTargetTemp={ 109 } refetch={ vi.fn() }/>);
  const warmer = screen.getByRole('button', { name: 'Warmer' });
  warmer.focus();
  fireEvent.keyDown(warmer, { key: 'ArrowUp' });
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(110);
  expect(warmer).toHaveAttribute('aria-disabled', 'true');
  expect(warmer).toHaveFocus();
  fireEvent.click(warmer);
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(110);
});
