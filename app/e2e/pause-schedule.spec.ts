import { test, expect } from '@playwright/test';
import { THEMES } from '../src/design/themes';
import { isThemeId } from '../src/design/themes/ids';

// The narrowest supported phone width.
test.use({ viewport: { width: 320, height: 720 } });

test('pausing tonight shows the paused side and resuming brings the schedule back', async ({ page }) => {
  await page.goto('/');
  const look = await page.locator('html').getAttribute('data-theme');
  if (!isThemeId(look)) throw new Error(`No look: ${look}`);
  // Colour means live: a paused side's target is drawn grey.
  const target = page.locator('[data-dial] circle[data-target]');
  const grey = THEMES[look].palette.text.tertiary;
  await expect(target).not.toHaveAttribute('fill', grey);
  await page.getByRole('button', { name: 'Pause schedule' }).click();

  await expect(page.getByRole('heading', { name: "Pause Alex's schedule" })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Tonight only/ })).toBeChecked();
  await page.getByRole('radio', { name: 'Until a set time' }).check();
  await expect(page.getByLabel('Resume at')).toBeVisible();
  const sheet = page.getByRole('dialog');
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  // Against the set width: a phone widens its layout viewport to fit overflowing content.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByLabel('Resume at')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport({ ratio: 1 });

  await page.getByRole('radio', { name: /^Tonight only/ }).check();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await expect(page.getByText(/^Schedule paused until /)).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Alex\. Paused, / })).toBeAttached();
  await expect(target).toHaveAttribute('fill', grey);
  await expect(page.getByRole('button', { name: 'Pause schedule' })).toHaveCount(0);
  // The button that opened the sheet is gone, so focus moves to Resume.
  await expect(page.getByRole('button', { name: 'Resume schedule' })).toBeFocused();

  await page.getByRole('button', { name: 'Resume schedule' }).click();
  await expect(page.getByRole('button', { name: 'Pause schedule' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause schedule' })).toBeFocused();
  await expect(page.getByText(/^Schedule paused until /)).toHaveCount(0);
  await expect(target).not.toHaveAttribute('fill', grey);
});

test('the pause sheet is 600 wide on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause schedule' }).click();
  const box = await page.getByRole('dialog').boundingBox();
  expect(box?.width).toBe(600);
});
