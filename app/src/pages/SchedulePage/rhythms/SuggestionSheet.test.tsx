import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { DEFAULT_SMART, type NightLog, type SuggestionRow } from '@api/rhythmsSchema';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import SuggestionSheet, { sheetKey } from './SuggestionSheet';

vi.mock('@mui/x-charts/LineChart', () => ({
  LineChart: () => <div data-testid="chart"/>,
  lineElementClasses: { root: 'line' },
  areaElementClasses: { root: 'area' },
}));

const demo = createDemoRhythms(new Date('2026-10-12T19:00:00Z'));
const offDays = demo.right.rhythms['off-days'];
const workday = { ...demo.left.rhythms.workday, smart: { ...DEFAULT_SMART } };
const evidence = { firstNight: '2026-10-03', lastNight: '2026-10-15', supportingDates: ['2026-10-14', '2026-10-15'] };
const down: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', supporting: 9, ...evidence, time: '23:45', temperatureF: 79, plannedF: 82,
  thenBack: { time: '02:00', temperatureF: 82, supporting: 8 },
};
const up: SuggestionRow = {
  kind: 'step', key: 'step:up', direction: 'up', supporting: 7, ...evidence, time: '05:00', temperatureF: 84, plannedF: 79,
};
const base: SuggestionRow = {
  kind: 'base', key: 'base:down', direction: 'down', supporting: 5, ...evidence, baseLevel: -1, currentBaseLevel: 0,
};
const log: NightLog[] = [{
  date: '2026-10-15', rhythmId: 'off-days', tonight: false, excluded: false, plan: [{ offsetMin: 0, temperatureF: 82 }], endMin: 480,
  changes: [],
}];
const sleep = (date: string, start: string, end: string) => ({ rhythmId: 'off-days', date, start, end }) as ResolvedSleepResponse;
const sleeps = [
  sleep('2026-10-16', '2026-10-16T23:00:00Z', '2026-10-17T07:00:00Z'),
  sleep('2026-10-18', '2026-10-18T23:00:00Z', '2026-10-19T07:00:00Z'),
];

const open = (over: Partial<Parameters<typeof SuggestionSheet>[0]> = {}) => {
  const handlers = { onAdd: vi.fn(), onDontSuggest: vi.fn(), onShowNights: vi.fn(), onClose: vi.fn() };
  const view = renderWithProviders(<SuggestionSheet
    entry={ { rhythmId: 'off-days', near: false, rows: [down, up] } }
    rhythm={ offDays }
    side="right"
    counted={ 14 }
    log={ log }
    sleeps={ sleeps }
    today="2026-10-17"
    timeZone="UTC"
    format="fahrenheit"
    trackingOn={ false }
    error=""
    busy={ false }
    { ...handlers }
    { ...over }/>);
  return { ...view, ...handlers };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T01:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it('opens on its heading, in a scrolling sheet whose actions stay outside the scroll', async () => {
  open();
  const dialog = screen.getByRole('dialog', { name: 'Cooler around 11:45 PM, warmer around 5:00 AM' });
  expect(within(dialog).getByText('Off days, right side')).toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByRole('heading', { level: 2 })).toHaveFocus());
  const content = dialog.querySelector('.MuiDialogContent-dividers');
  const actions = dialog.querySelector('.MuiDialogActions-root');
  expect(content).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(content?.contains(actions)).toBe(false);
});

it('checks every row at first and follows the checked rows in the night and the start', async () => {
  const { user } = open();
  const first = screen.getByRole('checkbox', { name: /^9 of 14 nights: 82°F to about 79°F around 11:45 PM\./ });
  const second = screen.getByRole('checkbox', { name: '7 of 14 nights: 79°F to about 84°F around 5:00 AM.' });
  expect(first).toBeChecked();
  expect(second).toBeChecked();
  expect(screen.queryByText(/counting again after you add/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add both to Off days' })).toBeInTheDocument();
  expect(screen.getByText('11:45 PM | 79°F | new')).toBeInTheDocument();
  expect(screen.getByText('Starts Sun, Oct 18.')).toBeInTheDocument();
  await user.click(first);
  expect(screen.getByText('The unchecked change starts counting again after you add.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add 1 of 2 to Off days' })).toBeInTheDocument();
  expect(screen.queryByText('11:45 PM | 79°F | new')).not.toBeInTheDocument();
  expect(screen.getByText('5:00 AM | 84°F | new')).toBeInTheDocument();
  expect(screen.getByText('Starts tonight.')).toBeInTheDocument();
  await user.click(second);
  expect(screen.getByRole('button', { name: 'Add to Off days' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('button', { name: "Don't suggest the checked" })).toHaveAttribute('aria-disabled', 'true');
});

it('adds or stops suggesting only the checked rows, offers no snooze, and Close does nothing else', async () => {
  const { user, onAdd, onDontSuggest, onClose } = open();
  expect(screen.queryByRole('button', { name: /^Hide for/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /^7 of 14 nights/ }));
  await user.click(screen.getByRole('button', { name: 'Add 1 of 2 to Off days' }));
  expect(onAdd).toHaveBeenCalledWith([down]);
  await user.click(screen.getByRole('button', { name: "Don't suggest the checked" }));
  expect(onDontSuggest).toHaveBeenCalledWith([down]);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('shows the save message inside the sheet and holds the actions while busy', async () => {
  const { user, onAdd } = open({ error: 'Could not save Rhythms. Your changes were not saved. Try again.', busy: true });
  expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('Could not save Rhythms.');
  const add = screen.getByRole('button', { name: 'Add both to Off days' });
  expect(add).toHaveAttribute('aria-disabled', 'true');
  await user.click(add);
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute('aria-disabled');
});

it('has no checkbox for a single row, and opens the notes from under the chart', async () => {
  const { user, onShowNights } = open({ entry: { rhythmId: 'off-days', near: true, rows: [up] }, counted: 9 });
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.getByText('7 of 9 nights: 79°F to about 84°F around 5:00 AM.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show the 9 nights' }));
  expect(onShowNights).toHaveBeenCalledOnce();
});

it('shows a Smart base change on the Smart Schedule chart, before and after', () => {
  open({ entry: { rhythmId: 'workday', near: true, rows: [base] }, rhythm: workday, side: 'left', counted: 12, format: 'level', sleeps: [] });
  expect(screen.getByRole('dialog', { name: 'Base one step cooler' })).toBeInTheDocument();
  expect(screen.getByRole('figure').getAttribute('aria-label')).toMatch(/^Smart Schedule preview\. Now: /);
  expect(screen.getByText('Base: 0 now, −1 with this change')).toBeInTheDocument();
  expect(screen.getByText('Starts next time Workday runs.')).toBeInTheDocument();
});

it('makes no claim about sleep', () => {
  open();
  expect(document.body.textContent).not.toMatch(/minutes a night|beats a minute|validated|based on research/i);
});

it('says a change waits for the pause', () => {
  open({ entry: { rhythmId: 'off-days', near: false, rows: [up] }, pausedUntil: new Date('2026-10-17T07:00:00Z') });
  expect(screen.getByText('Starts after the pause.')).toBeInTheDocument();
});

it('leaves nights of an earlier plan out of the chart caption', () => {
  const earlier = { ...log[0], date: '2026-10-14', samePlan: false };
  open({ log: [...log, earlier] });
  expect(screen.getByText('One line per night. 1 had no change and sits on the dashed line.')).toBeInTheDocument();
});

it('explains the unchecked rows and holds Add when nothing is checked', async () => {
  const { user } = open();
  await user.click(screen.getByRole('checkbox', { name: /^9 of 14 nights/ }));
  await user.click(screen.getByRole('checkbox', { name: /^7 of 14 nights/ }));
  expect(screen.getByText('The unchecked changes start counting again after you add.')).toBeInTheDocument();
});

it('starts the checks over when a refetch changes its rows', async () => {
  const Refetch = ({ keyed }: { keyed: boolean }) => {
    const [rows, setRows] = useState([down, up]);
    const entry = { rhythmId: 'off-days', near: false, rows };
    return <>
      <button onClick={ () => setRows([up]) }>refetch</button>
      <SuggestionSheet key={ keyed ? sheetKey(entry) : undefined } entry={ entry } rhythm={ offDays } side="right" counted={ 14 } log={ log }
        sleeps={ sleeps } today="2026-10-17" timeZone="UTC" format="fahrenheit" trackingOn={ false } error="" busy={ false }
        onAdd={ vi.fn() } onDontSuggest={ vi.fn() } onShowNights={ vi.fn() } onClose={ vi.fn() }/>
    </>;
  };
  const { user } = renderWithProviders(<Refetch keyed/>);
  await user.click(screen.getByRole('checkbox', { name: /^9 of 14 nights/ }));
  await user.click(screen.getByRole('button', { name: 'refetch', hidden: true }));
  expect(screen.getByRole('button', { name: 'Add to Off days' })).not.toHaveAttribute('aria-disabled', 'true');
});
