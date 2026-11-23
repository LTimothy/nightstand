import { test, expect } from '@playwright/test';

test('Relax sends a preset and keeps Stop available until movement finishes', async ({ page }) => {
  await page.goto('/elevation');
  const head = page.getByText('Head angle', { exact: true }).locator('..');
  const feet = page.getByText('Feet angle', { exact: true }).locator('..');
  await expect(head).toContainText('0°');
  await expect(feet).toContainText('0°');
  await page.getByRole('button', { name: /Relax Head/ }).click();
  await expect(page.getByRole('button', { name: 'Stop movement' })).toBeVisible();
  await expect(head).toContainText('30°', { timeout: 15_000 });
  await expect(feet).toContainText('15°', { timeout: 15_000 });
});

test('Stop and the status line leave the presets where the finger is', async ({ page }) => {
  await page.goto('/elevation');
  const relax = page.getByRole('button', { name: /Relax Head/ });
  const before = (await relax.boundingBox())!.y;
  await relax.click();
  await expect(page.getByRole('button', { name: 'Stop movement' })).toBeVisible();
  expect((await relax.boundingBox())!.y).toBe(before);
});

test('the Elevation tab stays put when it opens on a desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const tab = page.getByRole('navigation', { name: 'Bed controls' }).getByRole('link', { name: 'Elevation' });
  await page.goto('/');
  const onBed = (await tab.boundingBox())!.x;
  const onBedY = (await tab.boundingBox())!.y;
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
  expect((await tab.boundingBox())!.x).toBe(onBed);
  expect((await tab.boundingBox())!.y).toBe(onBedY);
});

test('Stop stays above the bottom bar on a short phone while the base moves', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/elevation');
  await page.getByRole('button', { name: /Relax Head/ }).click();
  const stop = page.getByRole('button', { name: 'Stop movement' });
  await expect(stop).toBeVisible();
  const bar = (await page.getByRole('navigation', { name: 'Primary mobile' }).boundingBox())!;
  const box = (await stop.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
});
