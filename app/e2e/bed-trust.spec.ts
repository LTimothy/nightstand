/// <reference lib="dom" />
import { test, expect, type Page } from '@playwright/test';
import { presetDemoPresence, setDemoPresence, watchDeviceStatus } from './bedStates';

test.use({ viewport: { width: 390, height: 844 } });

// Monday 9:41 PM in the demo's time zone (Los Angeles).
const EVENING = new Date('2026-09-29T04:41:00Z');

async function open(page: Page, prefs: Record<string, string> = {}) {
  await page.addInitScript(entries => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, prefs);
  await page.clock.install({ time: EVENING });
  await page.goto('/');
}
const lead = (page: Page) => page.locator('[data-dial] p').first();

test('a change the Pod has not confirmed says "Set to" and draws a hollow dot', async ({ page }) => {
  await open(page, { 'nightstand-demo-writes': 'hang' });
  await expect(lead(page)).toHaveText('Warming to');
  await expect(page.locator('[data-dial] circle[data-pending]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Warmer' }).click();
  await expect(lead(page)).toHaveText('Set to');
  await expect(page.locator('[data-dial] h2')).toHaveText('+2');
  await expect(page.locator('[data-dial] circle[data-pending]')).toHaveCount(1);
});

test('a change still unconfirmed after two seconds is drawn in the last known grey', async ({ page }) => {
  await open(page, { 'nightstand-demo-writes': 'hang' });
  await expect(lead(page)).toHaveText('Warming to');
  await page.getByRole('button', { name: 'Warmer' }).click();
  const dot = page.locator('[data-dial] circle[data-pending]');
  const numeral = page.locator('[data-dial] h2');
  await expect(dot).toHaveCount(1);
  const colour = await dot.getAttribute('stroke');
  expect(colour).not.toBe('#848C95');

  await page.clock.fastForward(1000);
  await expect(dot).toHaveAttribute('stroke', colour!);
  await page.clock.fastForward(1100);
  await expect(dot).toHaveAttribute('stroke', '#848C95');
  await expect(numeral).toHaveCSS('color', 'rgb(141, 157, 154)');
  await expect(lead(page)).toHaveText('Set to');
});

test('the dot fills once the Pod confirms the change', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Warmer' }).click();
  await expect(page.locator('[data-dial] circle[data-pending]')).toHaveCount(1);
  await expect(lead(page)).toHaveText('Warming to');
  await expect(page.locator('[data-dial] circle[data-pending]')).toHaveCount(0);
  await expect(page.locator('[data-dial] circle[data-target]')).toHaveCount(1);
});

const headerStatus = (page: Page) => page.getByRole('heading', { level: 1, name: 'Bed' }).locator('xpath=..').getByRole('status');

test('two minutes without a status shows the last known values, greyed, with their time', async ({ page }) => {
  await open(page);
  const turnOff = page.getByRole('button', { name: 'Turn off' });
  await expect(turnOff).toBeVisible();
  const before = (await page.locator('[data-power-row]').boundingBox())!;

  await page.evaluate(() => localStorage.setItem('nightstand-demo-reads', 'fail'));
  await page.clock.fastForward('02:05');
  await expect(headerStatus(page)).toHaveText('Not responding');
  await expect(lead(page)).toHaveText('Last known');
  await expect(page.locator('[data-dial] h2')).toHaveText('+1');
  await expect(page.locator('[data-dial] p').nth(1)).toHaveText(/^at 9:41\sPM$/);
  await expect(page.locator('[data-dial] circle[data-stale]')).toHaveCount(1);
  await expect(page.locator('[data-caption-slot]'))
    .toHaveText(/^No response from the Pod since 9:41\sPM\.\s*Schedules and alarms may not run\.$/);
  await expect(page.getByRole('radio', { name: 'Alex. Not responding.' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Warmer' })).toHaveAttribute('aria-disabled', 'true');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  const after = (await page.locator('[data-power-row]').boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(1);

  await page.evaluate(() => localStorage.removeItem('nightstand-demo-reads'));
  await retry.click();
  await expect(turnOff).toBeVisible();
  await expect(headerStatus(page)).toBeEmpty();
});

test.describe('on a 320 px phone', () => {
  test.use({ viewport: { width: 320, height: 740 } });

  test('a stale caption with a two digit hour fits its two line slot', async ({ page }) => {
    // Monday 11:41 PM in the demo's time zone.
    await page.clock.install({ time: new Date('2026-09-29T06:41:00Z') });
    const statusReadsDone = watchDeviceStatus(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await page.evaluate(() => localStorage.setItem('nightstand-demo-reads', 'fail'));
    await statusReadsDone();
    await page.clock.fastForward('02:05');
    const caption = page.locator('[data-caption-slot]');
    await expect(caption).toHaveText(/^No response from the Pod since 11:41\sPM\.\s*Schedules and alarms may not run\.$/);
    const { slot, lines } = await caption.evaluate(node => ({
      slot: node.getBoundingClientRect().height,
      lines: Array.from(node.querySelectorAll('span'), line => line.getBoundingClientRect().height).reduce((sum, height) => sum + height, 0),
    }));
    expect(lines).toBeLessThanOrEqual(slot + 1);
  });
});

test('a first load that fails says so in the same frame, with Try again', async ({ page }) => {
  await open(page, { 'nightstand-demo-reads': 'fail' });
  await expect(headerStatus(page)).toHaveText('Not responding');
  await expect(page.locator('[data-caption-slot]')).toContainText('Schedules and alarms may not run.');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('[data-dial] h2')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Turn o/ })).toHaveCount(0);
});

test('while the status loads every slot is drawn, empty, at its full size', async ({ page }) => {
  await open(page, { 'nightstand-demo-reads': 'hang' });
  await expect(page.locator('[data-dial]').getByRole('status')).toHaveText('Loading');
  await expect(page.locator('[data-tonight]').getByRole('status')).toHaveText('Loading schedule');
  await expect(page.getByRole('radio', { name: 'Alex.' })).toBeAttached();
  await expect(page.locator('[data-caption-slot]')).toBeEmpty();
  await expect(page.locator('[data-controls-row]')).toBeEmpty();
  await expect(page.locator('[data-power-row]')).toBeEmpty();
  expect((await page.locator('[data-power-row]').boundingBox())!.height).toBeGreaterThanOrEqual(54);
  await expect(page.getByRole('button', { name: /^Turn o/ })).toHaveCount(0);
});

test('with presence stale, the get-up caption keeps only the latest turn-off', async ({ page }) => {
  await presetDemoPresence(page, 'stale');
  // Monday 11:00 PM, inside the Workday sleep, so its turn-off is tomorrow morning.
  await page.clock.install({ time: new Date('2026-09-29T06:00:00Z') });
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'Edit Workday' }).click();
  await page.getByRole('combobox', { name: /^Turn off/ }).click();
  await page.getByRole('option', { name: 'When I get up' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('navigation', { name: 'Primary mobile' }).getByRole('link', { name: 'Bed', exact: true }).click();
  await expect(page.locator('[data-caption-slot]')).toHaveText(/^Turns off tomorrow by\s9:45\sAM$/);
  // The demo's last report has the left side in bed; too old to show.
  await expect(page.getByRole('radio', { name: /^Alex\./ })).toBeAttached();
  await expect(page.getByText(/^In bed/)).toHaveCount(0);

  const positions = () => page.evaluate(() => {
    const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top + window.scrollY;
    return {
      tiles: Array.from(document.querySelectorAll('[aria-label="Bed side"] label')).map(tile => tile.getBoundingClientRect().height),
      dial: top('[data-dial]'), caption: top('[data-caption-slot]'), controls: top('[data-controls-row]'), power: top('[data-power-row]'),
    };
  });
  const stale = await positions();
  await setDemoPresence(page, 'fresh-short');
  await page.clock.fastForward(11_000);
  await expect(page.locator('[data-caption-slot]')).toHaveText(/^Turns off when you get up, tomorrow by\s9:45\sAM$/);
  await expect(page.getByText(/^In bed/)).toBeVisible();
  expect(await positions()).toEqual(stale);
});

test('skipping the alarm leaves the bell where it was', async ({ page }) => {
  await open(page);
  // The alarm line's text starts right after the bell, so its x tracks the bell's.
  const line = page.locator('[data-tonight]').getByText(/^Alarm (today|tomorrow) at/);
  await expect(line).toBeVisible();
  const before = (await line.boundingBox())!.x;
  await page.locator('[data-tonight]').getByRole('button', { name: 'Skip', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // The confirm is the dialog's last action.
  await dialog.getByRole('button').last().click();
  await expect(dialog).toBeHidden();
  const skipped = page.locator('[data-tonight]').getByText('Recurring alarms skipped');
  await expect(skipped).toBeVisible();
  expect((await skipped.boundingBox())!.x).toBe(before);
});
