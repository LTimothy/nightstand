import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { http, HttpResponse } from 'msw';
import { server } from '@test/setup';
import ChangelogPage from './ChangelogPage';

describe('ChangelogPage', () => {
  it('renders the changelog page', async () => {
    renderWithProviders(<ChangelogPage />, { initialRoute: '/changelog' });
    expect(await screen.findByRole('heading', { name: 'Release notes', level: 1 })).toBeInTheDocument();
  });
});

it('keeps detailed release notes collapsed until the release is expanded', async () => {
  const { user } = renderWithProviders(<ChangelogPage />);
  const rows = await screen.findAllByRole('button', { name: /^v\d/ });
  expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
  await user.click(rows[0]);
  expect(rows[0]).toHaveAttribute('aria-expanded', 'true');
});

it('opens the exact release linked from the software screen', async () => {
  server.use(http.get('*/changelog', () => HttpResponse.json({ entries: [
    { version: '3.4.0', date: '2026-09-28', body: 'Specific release details.' },
  ] })));
  renderWithProviders(<ChangelogPage />, { initialRoute: '/changelog#release-v3.4.0' });
  expect(await screen.findByRole('button', { name: /^v3.4.0/ })).toHaveAttribute('aria-expanded', 'true');
});

it('sorts release versions newest first', async () => {
  server.use(http.get('*/changelog', () => HttpResponse.json({ entries: [
    { version: '3.0.0', date: '2026-09-28', body: 'Older release.' },
    { version: '3.12.0', date: '2026-09-28', body: 'Newest release.' },
    { version: '3.2.0', date: '2026-09-28', body: 'Middle release.' },
  ] })));
  renderWithProviders(<ChangelogPage />);
  const rows = await screen.findAllByRole('button', { name: /^v3\./ });
  expect(rows.map(row => row.querySelector('.MuiTypography-subtitle1')?.textContent)).toEqual(['v3.12.0', 'v3.2.0', 'v3.0.0']);
});

it('keeps one entry per version and prefers local release notes', async () => {
  server.use(
    http.get('*/changelog', () => HttpResponse.json({ entries: [
      { version: '9.3.0', date: '2026-09-28', body: 'Local release details.' },
      { version: '9.3.0', date: '2026-09-28', body: 'Duplicate local details.' },
    ] })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/CHANGELOG.md', () => HttpResponse.text(
      '# Changelog\n\n## [9.4.0] - 2026-09-28\nRemote newest.\n\n'
      + '## [9.4.0] - 2026-09-28\nDuplicate remote.\n\n'
      + '## [9.3.0] - 2026-09-28\nRemote overlapping details.\n'
    ))
  );
  renderWithProviders(<ChangelogPage />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^v9\./ })).toHaveLength(2));
  expect(screen.getByRole('button', { name: /^v9.3.0/ })).toHaveTextContent('Local release details.');
  expect(screen.queryByText('Remote overlapping details.')).not.toBeInTheDocument();
  expect(document.querySelectorAll('[id="release-v9.3.0"]')).toHaveLength(1);
  expect(document.querySelectorAll('[id="release-v9.4.0"]')).toHaveLength(1);
});

it('previews each release with its summary, or the first full sentence of its notes', async () => {
  server.use(http.get('*/changelog', () => HttpResponse.json({ entries: [
    { version: '3.4.0', date: '2026-09-29', body: 'Sleep data loads again and updates are safer.\n\n'
      + '- Reinstalling no longer loses recent sleep data. The installer deleted\n  the write-ahead file.' },
    { version: '3.3.0', date: '2026-09-26', body: '- The Status page has a Water tank entry. The pod reports its tank sensor on\n'
      + '  the same connection.\n\n- Another change.' },
  ] })));
  renderWithProviders(<ChangelogPage />, { initialRoute: '/changelog' });
  const newest = await screen.findByRole('button', { name: /^v3.4.0/ });
  expect(newest).toHaveTextContent('Sleep data loads again and updates are safer.');
  expect(newest).not.toHaveTextContent('Reinstalling');
  const older = screen.getByRole('button', { name: /^v3.3.0/ });
  expect(older).toHaveTextContent(/The Status page has a Water tank entry\.$/);
});

it('hides the summary preview while its release is expanded', async () => {
  server.use(http.get('*/changelog', () => HttpResponse.json({ entries: [
    { version: '3.4.0', date: '2026-09-29', body: 'Sleep data loads again.\n\n- Detail line.' },
  ] })));
  const { user } = renderWithProviders(<ChangelogPage />);
  const row = await screen.findByRole('button', { name: /^v3.4.0/ });
  const preview = row.querySelector('.release-summary') as HTMLElement;
  expect(preview).toBeVisible();
  await user.click(row);
  expect(preview).not.toBeVisible();
});

it('keeps the heading outline to h1 then one h2 per release', async () => {
  renderWithProviders(<ChangelogPage />);
  await screen.findAllByRole('button', { name: /^v\d/ });
  const levels = screen.getAllByRole('heading').map(heading => Number(heading.tagName.slice(1)));
  expect(levels.filter(level => level > 2)).toEqual([]);
  expect(levels.filter(level => level === 2).length).toBeGreaterThan(0);
});

it('marks each release Stable or Beta from the release list', async () => {
  server.use(
    http.get('*/changelog', () => HttpResponse.json({ entries: [
      { version: '3.5.1', date: '2026-10-01', body: 'Newer release.' },
      { version: '3.3.2', date: '2026-09-29', body: 'Older release.' },
    ] })),
    http.get('https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json', () => HttpResponse.json({
      channels: ['stable', 'beta'],
      releases: [
        { kind: 'agent', version: '3.5.1', channel: 'beta', date: '2026-10-01' },
        { kind: 'agent', version: '3.3.2', channel: 'stable', date: '2026-09-29' },
      ],
    })),
  );
  renderWithProviders(<ChangelogPage />);
  const newer = await screen.findByRole('button', { name: /^v3.5.1/ });
  await waitFor(() => expect(newer).toHaveTextContent('Beta'));
  expect(screen.getByRole('button', { name: /^v3.3.2/ })).toHaveTextContent('Stable');
});
