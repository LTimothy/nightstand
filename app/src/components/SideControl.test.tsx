import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { temperatureColor } from '@lib/temperatureColor';
import { palette } from '@design/tokens';
import { theme } from '../theme';
import { fahrenheitToLevel } from '@lib/temperatureConversions';
import SideControl from './SideControl';

const fixture = vi.hoisted(() => ({
  setSide: vi.fn(), usePresence: vi.fn(), enabled: true,
  settings: {
    left: { name: 'Alex', awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
    right: { name: 'Sam', awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
  },
  status: { left: { isOn: false }, right: { isOn: false } } as Record<string, unknown> | undefined,
  statusAge: 0, statusError: false,
  presence: { left: { present: true, lastUpdatedAt: '2026-09-28T05:00:00Z', stateChangedAt: '2026-09-28T04:48:00Z' } },
}));
vi.mock('@state/appStore.tsx', () => ({ useAppStore: () => ({ side: 'left', setSide: fixture.setSide }) }));
vi.mock('@api/settings.ts', () => ({ useSettings: () => ({ data: fixture.settings }) }));
vi.mock('@api/deviceStatus.ts', () => ({ useDeviceStatus: () => ({
  data: fixture.status, dataUpdatedAt: fixture.status ? Date.now() - fixture.statusAge : 0, isError: fixture.statusError,
  isFetching: false, failureCount: fixture.statusError ? 1 : 0, errorUpdateCount: fixture.statusError ? 1 : 0, errorUpdatedAt: 0,
  refetch: () => Promise.resolve(),
}) }));
vi.mock('@api/presence.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/presence.ts')>()),
  usePresence: (...args: unknown[]) => { fixture.usePresence(...args); return { data: fixture.presence }; },
}));
vi.mock('@api/services.ts', () => ({
  useServices: () => ({ data: { biometrics: { enabled: fixture.enabled, jobs: { calibrateLeft: { status: 'healthy' } } } } }),
}));
beforeEach(() => {
  fixture.enabled = true;
  fixture.settings.left.awayMode = false;
  fixture.settings.right.awayMode = false;
  fixture.settings.left.scheduleOverrides.pause = { active: false, expiresAt: '' };
  fixture.settings.right.scheduleOverrides.pause = { active: false, expiresAt: '' };
  fixture.status = { left: { isOn: false }, right: { isOn: false } };
  fixture.statusAge = 0;
  fixture.statusError = false;
  fixture.setSide.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-28T05:00:00Z'));
});
afterEach(() => vi.restoreAllMocks());

it('shows both named side states and exposes selection as radios', () => {
  render(<SideControl compact={ false }/>);
  expect(screen.getByRole('radiogroup', { name: 'Bed side' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Alex. Off. In bed 12 min.' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sam. Off.' })).not.toBeChecked();
});
it('shows a Bed tile\'s lines in full on hover, since they may be cut short', () => {
  fixture.settings.right.scheduleOverrides.pause = { active: true, expiresAt: '' };
  fixture.status = { left: { isOn: false }, right: { isOn: true, targetTemperatureF: 86, currentTemperatureF: 80 } };
  render(<SideControl compact={ false }/>);
  expect(screen.getByRole('radio', { name: /^Alex\./ }).closest('label')).toHaveAttribute('title', 'Alex\nOff\nIn bed 12 min');
  expect(screen.getByRole('radio', { name: /^Sam\./ }).closest('label')).toHaveAttribute('title', 'Sam\nPaused · 86°F');
  render(<SideControl/>);
  expect(screen.getAllByRole('radio', { name: /^Alex\./ })[1].closest('label')).not.toHaveAttribute('title');
});
it('leaves uncertain and disabled presence out of the tiles', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T05:00:00Z'));
  const view = render(<SideControl compact={ false }/>);
  expect(screen.queryByText(/In bed/)).not.toBeInTheDocument();
  expect(screen.queryByText(/resence/)).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Alex. Off.' })).toBeInTheDocument();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-28T05:00:00Z'));
  fixture.enabled = false;
  view.rerender(<SideControl compact={ false }/>);
  expect(screen.queryByText(/In bed/)).not.toBeInTheDocument();
});
it('merges the active controls when the other side is away', () => {
  fixture.settings.right.awayMode = true;
  render(<SideControl/>);
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  expect(screen.getByRole('radio', { name: /Both sides. Alex's controls apply to both sides/ })).toBeChecked();
});
it('honors the unsaved edit guard before switching sides', () => {
  const guard = vi.fn(() => false);
  const view = render(<SideControl beforeSideChange={ guard }/>);
  fireEvent.click(screen.getByRole('radio', { name: 'Sam. Off.' }));
  expect(guard).toHaveBeenCalledOnce();
  expect(fixture.setSide).not.toHaveBeenCalled();
  view.rerender(<SideControl/>);
  fireEvent.click(screen.getByRole('radio', { name: 'Sam. Off.' }));
  expect(fixture.setSide).toHaveBeenCalledWith('right');
});

it('keeps an away side available when browsing its history', () => {
  fixture.settings.right.awayMode = true;
  render(<SideControl mergeAwaySides={ false }/>);
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  fireEvent.click(screen.getByRole('radio', { name: 'Sam. Away.' }));
  expect(fixture.setSide).toHaveBeenCalledWith('right');
});

it('uses the selected night captions instead of live bed states when supplied', () => {
  render(<SideControl mergeAwaySides={ false } captions={ { left: '86, 6h 30m', right: 'No recording' } }/>);
  expect(screen.getByRole('radio', { name: 'Alex. 86, 6h 30m.' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sam. No recording.' })).toBeInTheDocument();
  expect(screen.queryByText('Off')).not.toBeInTheDocument();
});

it('marks a paused side without touching the partner', () => {
  fixture.settings.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  render(<SideControl compact={ false }/>);
  expect(screen.getByRole('radio', { name: 'Alex. Paused, Off. In bed 12 min.' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sam. Off.' })).toBeInTheDocument();
});

it('drops the paused label once the pause has ended', () => {
  fixture.settings.left.scheduleOverrides.pause = { active: true, expiresAt: '2026-09-28T04:00:00Z' };
  render(<SideControl compact={ false }/>);
  expect(screen.getByRole('radio', { name: 'Alex. Off. In bed 12 min.' })).toBeChecked();
});

it('shows away rather than paused for a side that is both', () => {
  fixture.settings.left.awayMode = true;
  fixture.settings.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  render(<SideControl compact={ false } mergeAwaySides={ false }/>);
  expect(screen.getByRole('radio', { name: 'Alex. Away.' })).toBeChecked();
});

it('names the level of a paused side that is on, on the Bed tiles and the compact ones', () => {
  fixture.settings.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  fixture.status = { left: { isOn: true, targetTemperatureF: 84, currentTemperatureF: 82 }, right: { isOn: false } };
  const view = render(<SideControl compact={ false }/>);
  expect(screen.getByRole('radio', { name: 'Alex. Paused, 84°F. In bed 12 min.' })).toBeChecked();
  view.unmount();
  render(<SideControl/>);
  expect(screen.getByText('Paused · 84°F')).toBeInTheDocument();
});

it('draws the selected Bed tile filled, from the top, with room for three lines', () => {
  render(<SideControl compact={ false }/>);
  const selected = screen.getByRole('radio', { name: /^Alex/ }).closest('label')!;
  expect(selected).toHaveStyle({ backgroundColor: '#2A251F', minHeight: '84px', borderRadius: '12px', justifyContent: 'flex-start' });
  expect(screen.getByRole('radio', { name: /^Sam/ }).closest('label')).toHaveStyle({ backgroundColor: '#121518' });
});

it('names only the side while the bed status loads', () => {
  render(<SideControl compact={ false } captions={ { left: '', right: '' } }/>);
  expect(screen.getByRole('radio', { name: 'Alex.' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sam.' })).toBeInTheDocument();
  expect(screen.queryByText('Off')).not.toBeInTheDocument();
});

const scale = (fahrenheit: number) => temperatureColor(fahrenheitToLevel(fahrenheit));
const renderThemed = (ui: React.ReactElement) => render(<ThemeProvider theme={ theme }>{ ui }</ThemeProvider>);

it('colours a live temperature on the compact tiles', () => {
  fixture.status = { left: { isOn: true, targetTemperatureF: 84, currentTemperatureF: 82 }, right: { isOn: false } };
  render(<SideControl/>);
  expect(screen.getByText('84°F')).toHaveStyle({ color: scale(84) });
});

it('draws a paused side that is on in grey, since the schedule is not driving it', () => {
  fixture.settings.left.scheduleOverrides.pause = { active: true, expiresAt: '' };
  fixture.status = { left: { isOn: true, targetTemperatureF: 84, currentTemperatureF: 82 }, right: { isOn: false } };
  renderThemed(<SideControl/>);
  expect(screen.getByText('Paused · 84°F')).toHaveStyle({ color: palette.text.secondary });
});

it('shows no temperature for a status older than two minutes while it is asked for again', () => {
  fixture.status = { left: { isOn: true, targetTemperatureF: 84, currentTemperatureF: 82 }, right: { isOn: false } };
  fixture.statusAge = 3 * 60_000;
  render(<SideControl/>);
  expect(screen.getByRole('radio', { name: 'Alex.' })).toBeChecked();
  expect(screen.queryByText('84°F')).not.toBeInTheDocument();
  expect(screen.queryByText('Not responding')).not.toBeInTheDocument();
});

it('says an old status is not responding, in grey, once a refresh fails', () => {
  fixture.status = { left: { isOn: true, targetTemperatureF: 84, currentTemperatureF: 82 }, right: { isOn: false } };
  fixture.statusAge = 3 * 60_000;
  fixture.statusError = true;
  renderThemed(<SideControl/>);
  expect(screen.getByRole('radio', { name: 'Alex. Not responding.' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sam. Not responding.' })).toBeInTheDocument();
  expect(screen.queryByText('84°F')).not.toBeInTheDocument();
  for (const line of screen.getAllByText('Not responding')) expect(line).toHaveStyle({ color: palette.text.secondary });
});

it('names only the side while the first status loads', () => {
  fixture.status = undefined;
  render(<SideControl/>);
  expect(screen.getByRole('radio', { name: 'Alex.' })).toBeChecked();
  // The empty state line keeps its height, so the name does not move when the status arrives.
  const line = screen.getByRole('radio', { name: 'Alex.' }).closest('label')!.querySelector('.MuiTypography-caption');
  expect(line).toBeEmptyDOMElement();
  expect(line).toHaveStyle({ minHeight: '1.2em' });
  expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
});
it('asks for presence only where it shows it', () => {
  render(<SideControl compact={ true }/>);
  expect(fixture.usePresence).toHaveBeenLastCalledWith(10_000, false);
  render(<SideControl compact={ false }/>);
  expect(fixture.usePresence).toHaveBeenLastCalledWith(10_000, true);
});
