import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import { useAppStore } from '@state/appStore';
import AlarmTest from './AlarmTest';

let posts: unknown[];
let clock = new Date('2026-09-29T12:00:00Z').getTime();

beforeEach(() => {
  // The running test outlives a component, so move the clock past the previous test's window.
  clock += 3_600_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  posts = [];
  useAppStore.setState({ side: 'left', isUpdating: false });
  server.use(http.post('*/alarm', async ({ request }) => {
    posts.push(await request.json());
    return HttpResponse.json({});
  }));
});
afterEach(() => vi.useRealTimers());

const Test = () => <AlarmTest vibrationIntensity={ 70 } vibrationPattern="double"/>;

it('sends the vibration it was given for 10 s, even with the side off', async () => {
  renderWithProviders(<AlarmTest vibrationIntensity={ 42 } vibrationPattern="rise"/>);
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  await waitFor(() => expect(posts).toEqual([
    { side: 'left', vibrationIntensity: 42, vibrationPattern: 'rise', duration: 10, force: true },
  ]));
});

it('sends one alarm command for a double tap', async () => {
  renderWithProviders(<Test/>);
  const button = screen.getByRole('button', { name: /^Test on/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(button).toBeDisabled();
  expect(screen.getByText('Alarm running now...')).toBeInTheDocument();
});

it('keeps the test locked when the sheet is closed and reopened', async () => {
  const first = renderWithProviders(<Test/>);
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  await waitFor(() => expect(posts).toHaveLength(1));
  first.unmount();
  renderWithProviders(<Test/>);
  expect(screen.getByRole('button', { name: 'Alarm running now...' })).toBeDisabled();
  expect(screen.getByText('Alarm running now...')).toBeInTheDocument();
  expect(posts).toHaveLength(1);
});

it('ignores a late failure from an earlier press once a newer test is running', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  server.use(http.post('*/alarm', async () => {
    calls += 1;
    if (calls > 1) return HttpResponse.json({});
    await gate;
    return HttpResponse.json({ error: 'busy' }, { status: 500 });
  }));
  const first = renderWithProviders(<Test/>);
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  await waitFor(() => expect(calls).toBe(1));
  first.unmount();
  vi.setSystemTime(clock + 11_000);
  const second = renderWithProviders(<Test/>);
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  await waitFor(() => expect(calls).toBe(2));
  release();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Alarm running now...' })).toBeDisabled();
  second.unmount();
  renderWithProviders(<Test/>);
  expect(screen.getByRole('button', { name: 'Alarm running now...' })).toBeDisabled();
});

it('reports a failed test and allows another try', async () => {
  server.use(http.post('*/alarm', () => HttpResponse.json({ error: 'busy' }, { status: 500 })));
  renderWithProviders(<Test/>);
  fireEvent.click(screen.getByRole('button', { name: /^Test on/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the test. Try again.');
  expect(screen.getByRole('button', { name: /^Test on/ })).toBeEnabled();
  expect(screen.queryByText('Alarm running now...')).not.toBeInTheDocument();
});
