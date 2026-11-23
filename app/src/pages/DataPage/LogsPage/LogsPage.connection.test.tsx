import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import LogsPage from './LogsPage';

class TestEventSource {
  static latest: TestEventSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) { this.url = url; TestEventSource.latest = this; }
}
beforeEach(() => {
  TestEventSource.latest = undefined as unknown as TestEventSource;
  vi.stubGlobal('EventSource', TestEventSource);
  server.use(http.get('*/logs', () => HttpResponse.json({ logs: ['free-sleep.log'] })));
});
afterEach(() => vi.unstubAllGlobals());

it('shows a disconnect and recovers using native EventSource retry', async () => {
  const { unmount } = renderWithProviders(<LogsPage />);
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  const stream = TestEventSource.latest;
  act(() => stream.onopen?.());
  expect(await screen.findByText('Live')).toBeVisible();
  act(() => stream.onmessage?.({ data: JSON.stringify({ message: 'First line\nSecond line' }) }));
  act(() => stream.onerror?.());
  expect(await screen.findByText(/Disconnected.*reconnecting/)).toBeVisible();
  expect(screen.getByText('Disconnected', { exact: true })).toBeVisible();
  expect(stream.close).not.toHaveBeenCalled();
  act(() => stream.onopen?.());
  act(() => stream.onmessage?.({ data: JSON.stringify({ message: 'First line\nSecond line\nThird line' }) }));
  expect(await screen.findByText('Third line')).toBeVisible();
  expect(screen.getAllByText('First line', { exact: true })).toHaveLength(1);
  expect(screen.getAllByText('Second line', { exact: true })).toHaveLength(1);
  expect(screen.getByText('Live')).toBeVisible();
  unmount();
  expect(stream.close).toHaveBeenCalledOnce();
});
it('labels loaded-line actions and distinguishes paused and no matches', async () => {
  const { user } = renderWithProviders(<LogsPage />);
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  act(() => TestEventSource.latest.onopen?.());
  act(() => TestEventSource.latest.onmessage?.({ data: JSON.stringify({ message: 'example' }) }));
  await user.click(screen.getByRole('button', { name: 'Loaded line actions' }));
  expect(screen.getByRole('menuitem', { name: 'Download loaded lines' })).not.toHaveAttribute('aria-disabled', 'true');
  await user.keyboard('{Escape}');
  await user.type(screen.getByRole('textbox', { name: 'Search loaded lines' }), 'absent');
  expect(screen.getByText('No matching lines.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Pause live updates' }));
  expect(screen.getByText('Paused')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Loaded line actions' }));
  await user.click(screen.getByRole('menuitem', { name: 'Clear displayed lines' }));
  await user.click(screen.getByRole('button', { name: 'Loaded line actions' }));
  expect(screen.getByRole('menuitem', { name: 'Download loaded lines' })).toHaveAttribute('aria-disabled', 'true');
});

it('keeps the selected file when reconnecting', async () => {
  server.use(http.get('*/logs', () => HttpResponse.json({ logs: ['free-sleep.log', 'sleep-analyzer.log'] })));
  const { user } = renderWithProviders(<LogsPage />);
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  await user.click(screen.getByRole('combobox', { name: 'Log file' }));
  await user.click(screen.getByRole('option', { name: 'sleep-analyzer.log' }));
  const previous = TestEventSource.latest;
  act(() => previous.onerror?.());
  await user.click(screen.getByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(TestEventSource.latest).not.toBe(previous));
  // Wait for the file-list refresh too; it must not reset the selection.
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Log file' })).toHaveTextContent('sleep-analyzer.log'));
  expect(TestEventSource.latest.url).toContain('/sleep-analyzer.log');
});

for (const [requested, expected] of [
  ['free-sleep-update.log', 'free-sleep-update.log'],
  ['missing.log', 'free-sleep.log'],
  ['../../etc/passwd', 'free-sleep.log'],
]) {
  it(`opens only a listed file for the recovery query ${requested}`, async () => {
    server.use(http.get('*/logs', () => HttpResponse.json({ logs: ['free-sleep.log', 'free-sleep-update.log'] })));
    renderWithProviders(<LogsPage />, { initialRoute: `/settings/logs?file=${encodeURIComponent(requested)}` });
    await waitFor(() => expect(TestEventSource.latest).toBeDefined());
    expect(TestEventSource.latest.url).toBe(`http://localhost:3000/api/logs/${expected}`);
    expect(screen.getByRole('combobox', { name: 'Log file' })).toHaveTextContent(expected);
  });
}

it('replaces displayed and buffered tails after a manual reconnect while paused', async () => {
  const { user } = renderWithProviders(<LogsPage/>);
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  const previous = TestEventSource.latest;
  act(() => previous.onopen?.());
  act(() => previous.onmessage?.({ data: JSON.stringify({ message: 'First line\nSecond line' }) }));
  await user.click(screen.getByRole('button', { name: 'Pause live updates' }));
  act(() => previous.onmessage?.({ data: JSON.stringify({ message: 'Third line' }) }));
  act(() => previous.onerror?.());
  await user.click(screen.getByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(TestEventSource.latest).not.toBe(previous));
  act(() => TestEventSource.latest.onopen?.());
  act(() => TestEventSource.latest.onmessage?.({ data: JSON.stringify({ message: 'First line\nSecond line\nThird line' }) }));
  await user.click(screen.getByRole('button', { name: 'Resume live updates' }));
  for (const line of ['First line', 'Second line', 'Third line']) expect(screen.getAllByText(line, { exact: true })).toHaveLength(1);
});

it('offers buffered lines as a button that resumes the stream', async () => {
  const { user } = renderWithProviders(<LogsPage/>);
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  const stream = TestEventSource.latest;
  act(() => stream.onopen?.());
  await user.click(screen.getByRole('button', { name: 'Pause live updates' }));
  act(() => stream.onmessage?.({ data: JSON.stringify({ message: 'Late line' }) }));
  await user.click(await screen.findByRole('button', { name: 'Show 1 new line' }));
  expect(await screen.findByText('Late line')).toBeVisible();
});
