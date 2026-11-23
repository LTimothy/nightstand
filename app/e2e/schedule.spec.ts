import { test, expect } from '@playwright/test';

// These specs cover the weekly schedule, so the demo starts with Rhythms off.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nightstand-demo-rhythms', 'off'));
});

test('saving a schedule edit hides the save button', async ({ page }) => {
  await page.goto('/schedules');
  await expect(page.getByText('Turn on at', { exact: true })).toBeVisible();

  // Toggle the power Enabled switch to mark the schedule changed. Wait for it
  // to reach its loaded checked state first: the schedule data arrives after
  // the switch first mounts, and clicking before that settles gets silently
  // overwritten by the data-load effect (which loses the edit on a cold run).
  const enabled = page.getByRole('switch', { name: /^Schedule \w+ night$/ }).first();
  await expect(enabled).toBeChecked();
  await enabled.click();

  // exact: true - the one-time alarm section also has a "Save one-time alarm" button.
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeVisible();
  await save.click();

  // After the mocked save completes, the pending-edit Save button goes away.
  await expect(save).toBeHidden();
});

test('leaving Schedule silently discards unsaved edits', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-28T19:00:00Z') });
  let dialogs = 0;
  page.on('dialog', async dialog => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await page.goto('/schedules');
  const enabled = page.getByRole('switch', { name: /^Schedule \w+ night$/ }).first();
  await expect(enabled).toBeChecked();
  const powerOn = page.getByLabel('Turn on at', { exact: true });
  await expect(powerOn).toHaveValue('21:30');
  await powerOn.fill('21:37');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary mobile' });
  await nav.getByRole('link', { name: 'Bed', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await nav.getByRole('link', { name: 'Schedule', exact: true }).click();
  await expect(powerOn).toHaveValue('21:30');
  await expect(save).toBeHidden();
  expect(dialogs).toBe(0);
});

test('new rows stay focused and changing days requires discarding the draft', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-28T19:00:00Z') });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'Add temperature change' }).click();
  const focused = page.locator('input[data-time]:focus');
  await expect(focused).toHaveCount(1);
  await expect(focused).toBeInViewport();
  const day = page.getByRole('tab', { name: 'Tuesday' });
  await day.click();
  await expect(page.getByRole('dialog', { name: 'Discard changes to Monday?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await day.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
});

test('level steppers stay bounded and boundary errors focus the affected row', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/schedules');
  const stepper = page.getByRole('spinbutton', { name: 'Bedtime temperature' });
  await expect(stepper).toHaveAttribute('aria-valuemin', '-10');
  await expect(stepper).toHaveAttribute('aria-valuemax', '10');
  await stepper.focus();
  await page.keyboard.press('ArrowUp');
  await expect(stepper).toHaveAttribute('aria-valuenow', '-7');
  await page.getByRole('combobox', { name: /^Turn off/ }).click();
  await page.getByRole('option', { name: 'At a set time' }).click();
  const off = await page.getByLabel('Turn off at', { exact: true }).inputValue();
  await page.getByLabel('Change at', { exact: true }).first().fill(off);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Fix 1 time' }).click();
  const invalid = page.locator('input[aria-invalid="true"]:focus');
  await expect(invalid).toHaveCount(1);
  await expect(invalid).toBeInViewport();
});

test('the chart Wake label sits left of its reference line', async ({ page }) => {
  await page.goto('/schedules');
  const label = page.locator('svg text', { hasText: /^Wake$/ });
  await expect(label).toBeVisible();
  const line = page.locator('.MuiChartsReferenceLine-line').first();
  const [labelBox, lineBox] = await Promise.all([label.boundingBox(), line.boundingBox()]);
  expect(labelBox!.x + labelBox!.width).toBeLessThan(lineBox!.x);
});

test('the unsaved summary fits at 320 px with side and days intact', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/schedules');
  await page.getByLabel('Turn on at', { exact: true }).fill('21:37');
  const summary = page.getByRole('status').filter({ hasText: 'Unsaved:' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/Unsaved: .+, [A-Z][a-z]{2}/);
  const clipped = await summary.evaluate(element => element.scrollHeight > element.clientHeight
    || element.scrollWidth > element.clientWidth);
  expect(clipped).toBe(false);
});

test('the seven day chips sit on one row, each 44 wide, at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'Apply settings to other days' }).click();
  const boxes = await page.getByRole('group', { name: 'Apply to days' }).getByRole('button').evaluateAll(
    chips => chips.map(chip => chip.getBoundingClientRect()).map(({ y, width }) => ({ y, width })));
  expect(boxes).toHaveLength(7);
  expect(new Set(boxes.map(box => Math.round(box.y))).size).toBe(1);
  for (const box of boxes) expect(box.width).toBe(44);
});
