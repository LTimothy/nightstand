import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { palette } from '@design/tokens';
import { temperatureColor } from '@lib/temperatureColor';
import { fahrenheitToLevel } from '@lib/temperatureConversions.ts';
import { getDeviceStatus } from '../../mocks/mockData';
import TemperatureDial from './TemperatureDial';
import { useControlTempStore } from './controlTempStore';

const post = vi.hoisted(() => vi.fn());
vi.mock('@api/deviceStatus.ts', () => ({ postDeviceStatus: post, useDeviceStatus: () => ({ data: undefined }) }));
vi.mock('@api/settings.ts', () => ({ useSettings: () => ({ data: { timeZone: 'UTC', left: { awayMode: false } } }) }));
vi.mock('@state/appStore', () => ({ useAppStore: () => ({ side: 'left', setIsUpdating: vi.fn() }) }));
vi.mock('./TemperatureButtons', () => ({ default: () => <button>Temperature stepper</button> }));
vi.mock('./useBedCaption', () => ({
  useBedCaption: (isOn: boolean) => [isOn ? 'Turns off tomorrow at 6:45 AM' : 'Turns on tonight at 10:00 PM'],
}));

beforeEach(() => useControlTempStore.setState({ deviceStatus: undefined }));

const on = { isOn: true, targetTemperatureF: 83, currentTemperatureF: 75 };

it('shows the target and current temperature without a draggable control', () => {
  render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByRole('heading', { level: 2, name: '0' })).toBeInTheDocument();
  expect(screen.getByText('Currently at \u22123')).toBeInTheDocument();
  expect(screen.getByText('Warming to')).toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  fireEvent.pointerDown(screen.getByText('0'));
  fireEvent.pointerUp(screen.getByText('0'));
  expect(post).not.toHaveBeenCalled();
});

it('sets the sign of a level apart from its digits', () => {
  render(<TemperatureDial status={ { ...on, targetTemperatureF: 74 } } refetch={ vi.fn() } format="level"/>);
  const heading = screen.getByRole('heading', { level: 2 });
  expect(heading).toHaveTextContent('\u22123');
  expect(heading.querySelector('span')).toHaveTextContent('\u2212');
});

it('shows the steppers only while on, and what it is given in their place while off', () => {
  const { rerender } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level" whenOff={ <span>Last night</span> }/>);
  expect(screen.getByText('Temperature stepper')).toBeInTheDocument();
  expect(screen.queryByText('Last night')).not.toBeInTheDocument();
  rerender(<TemperatureDial status={ { ...on, isOn: false } } refetch={ vi.fn() } format="level" whenOff={ <span>Last night</span> }/>);
  expect(screen.queryByText('Temperature stepper')).not.toBeInTheDocument();
  expect(screen.getByText('Off')).toBeInTheDocument();
  expect(screen.getByText('Last night')).toBeInTheDocument();
});

it('shows last night, not the steppers, for an away side that is on', () => {
  render(<TemperatureDial status={ on } away refetch={ vi.fn() } format="level" whenOff={ <span>Last night</span> }/>);
  expect(screen.queryByText('Temperature stepper')).not.toBeInTheDocument();
  expect(screen.getByText('Last night')).toBeInTheDocument();
});

it('draws an away side that is on in grey, ring and numeral', () => {
  const { container } = render(<TemperatureDial status={ on } away refetch={ vi.fn() } format="level"/>);
  expect(container.querySelector('[data-dial] path[data-band="off"]')).not.toBeNull();
  expect(container.querySelector('[data-dial] g[data-band="fill"]')).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: '0' })).toHaveStyle({ color: palette.text.secondary });
});

it('says Loading in the dial and leaves every slot empty while the status loads', () => {
  const { container } = render(<TemperatureDial loading refetch={ vi.fn() } format="level"/>);
  const dial = within(container.querySelector<HTMLElement>('[data-dial]')!);
  expect(dial.getByRole('status')).toHaveTextContent('Loading');
  expect(dial.getByRole('status')).toHaveStyle({ color: palette.text.tertiary });
  expect(container.querySelector('[data-dial] path[data-band="off"]')).not.toBeNull();
  expect(container.querySelector('[data-caption-slot]')!.textContent).toBe('');
  expect(container.querySelector('[data-controls-row]')).toBeEmptyDOMElement();
});

it('fills the Loading region only once it is in the page, so it is announced', () => {
  const markup = renderToStaticMarkup(<TemperatureDial loading refetch={ vi.fn() } format="level"/>);
  expect(markup).toMatch(/role="status"[^>]*><\/p>/);
  expect(markup).not.toContain('Loading');
});

it('draws the empty track and no text before the status loads', () => {
  const { container } = render(<TemperatureDial refetch={ vi.fn() } format="level"/>);
  expect(container.querySelector('[data-dial] path[data-band="off"]')).not.toBeNull();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByText('Off')).not.toBeInTheDocument();
});

it('puts the steppers, or what it is given while off, in one controls row under the dial', () => {
  const { container, rerender } = render(
    <TemperatureDial status={ on } refetch={ vi.fn() } format="level" whenOff={ <span>Last night</span> }/>);
  const row = () => container.querySelector('[data-controls-row]')!;
  expect(row()).toContainElement(screen.getByText('Temperature stepper'));
  expect(container.querySelector('[data-dial]')).not.toContainElement(screen.getByText('Temperature stepper'));
  rerender(<TemperatureDial status={ { ...on, isOn: false } } refetch={ vi.fn() } format="level" whenOff={ <span>Last night</span> }/>);
  expect(row()).toContainElement(screen.getByText('Last night'));
});

it('puts the caption in its own slot between the dial and the controls row', () => {
  const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
  const slot = container.querySelector('[data-caption-slot]')!;
  expect(slot).toHaveTextContent('Turns off tomorrow at 6:45 AM');
  expect(slot.previousElementSibling).toHaveAttribute('data-dial');
  expect(slot.nextElementSibling).toHaveAttribute('data-controls-row');
});

it('sets a level in the large light numeral', () => {
  render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByRole('heading', { level: 2 })).toHaveStyle({ fontSize: '100px', fontWeight: '300' });
  expect(screen.getByText('Warming to')).toHaveStyle({ fontSize: '15px' });
});

it('writes °F at the smaller numeral size', () => {
  render(<TemperatureDial status={ { ...on, targetTemperatureF: 84 } } refetch={ vi.fn() } format="fahrenheit"/>);
  const numeral = screen.getByRole('heading', { level: 2 });
  expect(numeral).toHaveTextContent('84°F');
  expect(numeral).toHaveStyle({ fontSize: '64px' });
});

it('says Off in the large light face while off', () => {
  render(<TemperatureDial status={ { ...on, isOn: false } } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByText('Off')).toHaveStyle({ fontSize: '84px', fontWeight: '300' });
});

it('says "Set to" and draws a hollow dot while an edit waits for the Pod', () => {
  const status = getDeviceStatus();
  useControlTempStore.setState({ deviceStatus: { ...status, left: { ...status.left, ...on, targetTemperatureF: 86 } } });
  const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByText('Set to')).toBeInTheDocument();
  expect(container.querySelector('circle[data-pending]')).not.toBeNull();
});

describe('a target the Pod has not confirmed', () => {
  const setTarget = (targetTemperatureF: number) => act(() => {
    const status = getDeviceStatus();
    useControlTempStore.setState({ deviceStatus: { ...status, left: { ...status.left, ...on, targetTemperatureF } } });
  });
  const dot = (container: HTMLElement) => container.querySelector('circle[data-pending]')!;
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps its colour for the first two seconds, then turns grey', () => {
    setTarget(86);
    const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
    const colour = temperatureColor(fahrenheitToLevel(86));
    expect(dot(container)).toHaveAttribute('stroke', colour);
    wait(1999);
    expect(dot(container)).toHaveAttribute('stroke', colour);
    expect(container.querySelector('g[data-band="fill"] path')).not.toHaveAttribute('stroke', palette.text.tertiary);
    expect(screen.getByRole('heading', { level: 2 })).toHaveStyle({ color: colour });
    wait(1);
    expect(dot(container)).toHaveAttribute('stroke', palette.text.tertiary);
    expect(container.querySelector('circle[data-halo]')).toHaveAttribute('stroke', palette.text.tertiary);
    const strokes = (selector: string) => Array.from(container.querySelectorAll(selector), node => node.getAttribute('stroke'));
    expect(new Set(strokes('g[data-band="fill"] path'))).toEqual(new Set([palette.text.tertiary]));
    expect(new Set(strokes('g[data-band="ghost"] path'))).toEqual(new Set([palette.text.tertiary]));
    expect(new Set(strokes('line[data-tick="major"]'))).toEqual(new Set([palette.dial.tickMajorOff]));
    expect(screen.getByRole('heading', { level: 2 })).toHaveStyle({ color: palette.text.secondary });
    expect(screen.getByText('Set to')).toBeInTheDocument();
  });

  it('returns to colour as soon as the Pod confirms', () => {
    setTarget(86);
    const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
    wait(2000);
    expect(dot(container)).toHaveAttribute('stroke', palette.text.tertiary);
    setTarget(83);
    expect(container.querySelector('circle[data-pending]')).toBeNull();
    expect(container.querySelector('circle[data-target]')).toHaveAttribute('fill', temperatureColor(fahrenheitToLevel(83)));
    expect(screen.getByRole('heading', { level: 2 })).toHaveStyle({ color: temperatureColor(fahrenheitToLevel(83)) });
  });

  it('starts the two seconds again on a new target', () => {
    setTarget(86);
    const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
    wait(1500);
    setTarget(88);
    wait(1999);
    expect(dot(container)).toHaveAttribute('stroke', temperatureColor(fahrenheitToLevel(88)));
    wait(1);
    expect(dot(container)).toHaveAttribute('stroke', palette.text.tertiary);
  });

  it('turns colour again at once on a tap while grey, and waits two seconds more', () => {
    setTarget(86);
    const { container } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
    wait(2000);
    expect(dot(container)).toHaveAttribute('stroke', palette.text.tertiary);
    setTarget(88);
    expect(dot(container)).toHaveAttribute('stroke', temperatureColor(fahrenheitToLevel(88)));
    expect(container.querySelector('g[data-band="fill"] path')).not.toHaveAttribute('stroke', palette.text.tertiary);
    wait(1999);
    expect(dot(container)).toHaveAttribute('stroke', temperatureColor(fahrenheitToLevel(88)));
    wait(1);
    expect(dot(container)).toHaveAttribute('stroke', palette.text.tertiary);
  });

  it('leaves no timer behind once confirmed or unmounted', () => {
    setTarget(86);
    const { unmount } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
    expect(vi.getTimerCount()).toBe(1);
    setTarget(83);
    expect(vi.getTimerCount()).toBe(0);
    setTarget(86);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const since = new Date('2026-09-29T04:41:00Z');

it('greys a last known status, dates it, and says what that means for tonight', () => {
  const { container } = render(<TemperatureDial status={ on } staleSince={ since } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByText('Last known')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: '0' })).toHaveStyle({ color: palette.text.secondary });
  expect(screen.getByText('at 4:41 AM')).toBeInTheDocument();
  const slot = container.querySelector('[data-caption-slot]')!;
  expect(slot).toHaveTextContent('No response from the Pod since 4:41 AM.Schedules and alarms may not run.');
  expect(slot.querySelector('[role="status"]')).not.toBeNull();
  expect(container.querySelector('circle[data-stale]')).not.toBeNull();
  expect(screen.getByText('Temperature stepper')).toBeInTheDocument();
});

it('keeps one empty status region in the caption slot and fills it when the Pod stops answering', () => {
  const { container, rerender } = render(<TemperatureDial status={ on } refetch={ vi.fn() } format="level"/>);
  const region = container.querySelector('[data-caption-slot] [role="status"]');
  expect(region).not.toBeNull();
  expect(region!.textContent).toBe('');
  rerender(<TemperatureDial status={ on } staleSince={ since } refetch={ vi.fn() } format="level"/>);
  expect(container.querySelector('[data-caption-slot] [role="status"]')).toBe(region);
  expect(region).toHaveTextContent('No response from the Pod since 4:41 AM.');
});

it('says Off with its time for a side last known to be off', () => {
  render(<TemperatureDial status={ { ...on, isOn: false } } staleSince={ since } refetch={ vi.fn() } format="level"/>);
  expect(screen.getByText('Last known')).toBeInTheDocument();
  expect(screen.getByText('Off')).toBeInTheDocument();
  expect(screen.getByText('at 4:41 AM')).toBeInTheDocument();
});

it('draws an empty frame with the stale caption when nothing ever loaded', () => {
  const { container } = render(<TemperatureDial staleSince={ since } refetch={ vi.fn() } format="level"/>);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(container.querySelector('[data-caption-slot]')).toHaveTextContent('Schedules and alarms may not run.');
  expect(container.querySelector('[data-controls-row]')).toBeEmptyDOMElement();
});

it('reads the firmware target at the coldest stored stop in a target format', () => {
  render(<TemperatureDial status={ { ...on, targetTemperatureF: 55, currentTemperatureF: 55 } } refetch={ vi.fn() } format="fahrenheitTarget"/>);
  expect(screen.getByRole('heading', { level: 2, name: '50°F' })).toBeInTheDocument();
  expect(screen.getByText('Currently at 50°F')).toBeInTheDocument();
});

it('labels the Currently at line from the raw firmware level in a target format', () => {
  const status = { ...on, targetTemperatureF: 83, currentTemperatureF: 55, currentTemperatureLevel: -99 };
  const { rerender } = render(<TemperatureDial status={ status } refetch={ vi.fn() } format="fahrenheitTarget"/>);
  expect(screen.getByText('Currently at 59°F')).toBeInTheDocument();
  rerender(<TemperatureDial status={ { ...status, currentTemperatureLevel: NaN } } refetch={ vi.fn() } format="fahrenheitTarget"/>);
  expect(screen.getByText('Currently at 50°F')).toBeInTheDocument();
  rerender(<TemperatureDial status={ status } refetch={ vi.fn() } format="fahrenheit"/>);
  expect(screen.getByText('Currently at 55°F')).toBeInTheDocument();
});

it('titles the dial from the two numbers it shows in a target format', () => {
  // Stored 55 F reads 50 F, but the firmware sits one level up, at 59 F: the bed is still cooling.
  render(<TemperatureDial
    status={ { ...on, targetTemperatureF: 55, currentTemperatureF: 55, currentTemperatureLevel: -99 } }
    refetch={ vi.fn() }
    format="fahrenheitTarget"/>);
  expect(screen.getByText('Currently at 59°F')).toBeInTheDocument();
  expect(screen.getByText('Cooling to')).toBeInTheDocument();
});

