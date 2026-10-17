import type { Page } from '@playwright/test';

type SweepState = { name: string; path: string; open?: (page: Page) => Promise<void> };

// Type-only imports keep this table loadable from the unit test, so openers wait with locators rather than expect.
const shown = (page: Page, role: 'dialog' | 'heading', name?: string | RegExp) =>
  page.getByRole(role, name ? { name } : {}).first().waitFor();
const press = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' ? true : undefined }).first().click();
// Demo switches read on load, set before the app reads them again.
async function demoPrefs(page: Page, prefs: Record<string, string>) {
  await page.evaluate(entries => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, prefs);
  await page.reload();
  await page.waitForLoadState('networkidle');
}

// Every screen and sheet the layout sweep checks. Add new screens here; a
// unit test fails when a routed page is missing.
export const SWEEP: SweepState[] = [
  { name: 'bed', path: '/' },
  { name: 'temperature', path: '/temperature' },
  { name: 'left', path: '/left' },
  { name: 'right', path: '/right' },
  { name: 'elevation', path: '/elevation' },
  { name: 'schedule', path: '/schedules' },
  { name: 'sleep night', path: '/sleep' },
  { name: 'sleep heart rate', path: '/sleep?metric=heart_rate' },
  { name: 'settings', path: '/settings' },
  { name: 'settings bed', path: '/settings/bed' },
  { name: 'settings features', path: '/settings/features' },
  { name: 'settings device', path: '/settings/device' },
  { name: 'settings about', path: '/settings/about' },
  { name: 'software', path: '/settings/versions' },
  { name: 'system status', path: '/settings/system' },
  { name: 'logs', path: '/settings/logs' },
  { name: 'release notes', path: '/changelog' },

  {
    name: 'bed off',
    path: '/',
    open: async page => {
      await press(page, 'Turn off');
      await page.getByRole('button', { name: 'Turn on' }).waitFor();
    },
  },
  {
    name: 'pause sheet',
    path: '/',
    open: async page => {
      await press(page, 'Pause schedule');
      await shown(page, 'heading', "Pause Alex's schedule");
    },
  },
  {
    name: 'alarm change',
    path: '/',
    open: async page => {
      await press(page, 'Change');
      await shown(page, 'dialog');
    },
  },
  {
    name: 'week picker',
    path: '/schedules',
    open: async page => {
      await press(page, 'Sun to Thu: Workday');
      await shown(page, 'dialog', 'Sun to Thu');
    },
  },
  {
    name: 'several dates',
    path: '/schedules',
    open: async page => {
      await press(page, 'Change several dates');
      await shown(page, 'dialog', 'Change several dates');
    },
  },
  {
    name: 'rhythm editor',
    path: '/schedules',
    open: async page => {
      await press(page, 'Edit Workday');
      await page.getByRole('button', { name: 'Smart Schedule', pressed: true }).waitFor();
    },
  },
  {
    name: 'alarm vibration',
    path: '/schedules',
    open: async page => {
      await press(page, 'Edit Workday');
      await press(page, /^Vibrate: /);
      await shown(page, 'dialog');
    },
  },
  {
    name: 'research sheet',
    path: '/schedules',
    open: async page => {
      await press(page, 'Edit Workday');
      await press(page, 'The research behind it');
      const sheet = page.getByRole('dialog', { name: 'The research behind it' });
      for (const studies of await sheet.getByRole('button', { name: /^Studies/ }).all()) await studies.click();
      await sheet.getByRole('link').first().waitFor();
    },
  },
  {
    name: 'one-time alarm',
    path: '/schedules',
    open: async page => {
      await press(page, 'Add one-time alarm');
      await page.getByRole('switch', { name: 'Enable one-time alarm' }).waitFor();
    },
  },
  {
    name: 'suggestion card',
    path: '/schedules',
    open: async page => {
      await page.getByRole('radio', { name: /^Sam/ }).click();
      await page.getByRole('button', { name: 'Review suggestion for Off days' }).waitFor();
    },
  },
  {
    name: 'suggestion review',
    path: '/schedules',
    open: async page => {
      await page.getByRole('radio', { name: /^Sam/ }).click();
      await press(page, 'Review suggestion for Off days');
      await shown(page, 'dialog');
    },
  },
  {
    name: 'suggestion near miss',
    path: '/schedules',
    open: async page => {
      await press(page, 'Review suggestion for Workday');
      await shown(page, 'dialog');
    },
  },
  {
    name: 'suggestion notes',
    path: '/schedules',
    open: async page => {
      await page.getByRole('radio', { name: /^Sam/ }).click();
      await press(page, 'Show the nights');
      await shown(page, 'dialog', 'Notes');
      await press(page, 'How this works');
    },
  },
  {
    name: 'weekly schedule',
    path: '/schedules',
    open: async page => {
      await demoPrefs(page, { 'nightstand-demo-rhythms': 'off' });
      await page.getByText('Turn on at', { exact: true }).waitFor();
    },
  },
  {
    name: 'sleep week',
    path: '/sleep',
    open: async page => {
      await page.getByRole('tab', { name: 'Week', exact: true }).click();
      await page.getByRole('tab', { name: 'Week', selected: true }).waitFor();
    },
  },
  {
    name: 'update dialog',
    path: '/settings/versions',
    open: async page => {
      await demoPrefs(page, { 'nightstand-demo-update': 'on' });
      await press(page, /^Update to/);
      await shown(page, 'dialog');
    },
  },
];
