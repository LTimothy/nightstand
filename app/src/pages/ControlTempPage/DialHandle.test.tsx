import { useRef, type ReactNode } from 'react';
import { act, fireEvent, render as baseRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DialHandle from './DialHandle';
import { dialPoint } from './dialGeometry';
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

const at = (level: number) => { const { x, y } = dialPoint(level); return { clientX: x, clientY: y }; };

// The handle measures its parent; jsdom lays nothing out, so the parent is a 280 x 240 box at the origin.
function Dial() {
  const stepRef = useRef<((direction: 1 | -1) => void) | null>(null);
  const target = useControlTempStore(state => state.deviceStatus!.left.targetTemperatureF);
  return <>
    <div ref={ node => { if (node) node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 240 }) as DOMRect; } }>
      <DialHandle target={ target } format={ preferences.format } stepRef={ stepRef }/>
    </div>
    <TemperatureButtons currentTargetTemp={ 80 } refetch={ vi.fn() } stepRef={ stepRef }/>
  </>;
}

it('drags the target to the cool end and sends it once', async () => {
  render(<Dial/>);
  const handle = screen.getByRole('slider', { name: 'Temperature' });
  fireEvent.pointerDown(handle, { pointerId: 1, ...at(-1) });
  fireEvent.pointerMove(handle, { pointerId: 1, ...at(-5) });
  // Below the left end of the ring, which reads as the coldest level.
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 235 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(55);
  expect(handle).toHaveAttribute('aria-valuenow', '55');
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith({ left: { targetTemperatureF: 55 } });
});

it('ignores a pointer that moves without grabbing the handle', async () => {
  render(<Dial/>);
  fireEvent.pointerMove(screen.getByRole('slider', { name: 'Temperature' }), { pointerId: 1, clientX: 250, clientY: 100 });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(80);
  expect(api.post).not.toHaveBeenCalled();
});

it('steps one degree per arrow key', () => {
  render(<Dial/>);
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Temperature' }), { key: 'ArrowUp' });
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(81);
});

it('does not move the target when the dot is grabbed off-centre and the finger wiggles', async () => {
  render(<Dial/>);
  const handle = screen.getByRole('slider', { name: 'Temperature' });
  fireEvent.pointerDown(handle, { pointerId: 1, ...at(-0.3) });
  fireEvent.pointerMove(handle, { pointerId: 1, ...at(-0.25) });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(80);
  expect(api.post).not.toHaveBeenCalled();
});

it('settles a level drag from an off-grid target instead of bouncing', async () => {
  preferences.format = 'level';
  act(() => useControlTempStore.getState().setDeviceStatus({ left: { targetTemperatureF: 84 } }));
  render(<Dial/>);
  const handle = screen.getByRole('slider', { name: 'Temperature' });
  fireEvent.pointerDown(handle, { pointerId: 1, ...at(1) });
  fireEvent.pointerMove(handle, { pointerId: 1, ...at(1.75) });
  expect(useControlTempStore.getState().deviceStatus?.left.targetTemperatureF).toBe(88);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith({ left: { targetTemperatureF: 88 } });
});
