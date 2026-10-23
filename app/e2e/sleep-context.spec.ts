import { test, expect } from '@playwright/test';

test('Monday opens the latest recorded night and expanded charts fill their panel', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-28T19:00:00Z') });
  await page.goto('/sleep');
  await expect(page.getByText(/Out of bed Mon, Sep 28/)).toBeVisible();
  await expect(page.getByRole('button', { name: /HRV/ })).toHaveCount(0);
  const heartRate = page.getByRole('button', { name: /^Average heart rate/ });
  await expect(heartRate).toContainText(/\d+ bpm/);
  await heartRate.click();
  const region = page.getByRole('region');
  await expect(region).toContainText('7-night average');
  const chart = region.getByRole('img');
  await expect(chart).toBeVisible();
  await expect.poll(async () => (await chart.boundingBox())?.width ?? 0).toBeGreaterThan(250);
  await heartRate.click();
  await expect(page.locator('[id="detail-heart_rate"]')).toHaveCount(0);
});

test('week strip days are at least 44px wide at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/sleep');
  const strip = page.getByRole('group', { name: 'Nights in selected week' });
  await expect(strip.getByRole('button')).toHaveCount(7);
  for (const day of await strip.getByRole('button').all()) {
    const box = await day.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('expanded measurements fit a 320px screen without widening the page', async ({ page }) => {
  // The demo night follows the clock, so its last axis label moves; this time put it at the edge.
  await page.clock.install({ time: new Date('2026-10-22T18:08:00Z') });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/sleep?metric=heart_rate');
  const chart = page.getByRole('region').getByRole('img');
  await expect(chart).toBeVisible();
  await expect.poll(async () => {
    const bounds = await chart.boundingBox();
    return bounds ? bounds.x + bounds.width : Infinity;
  }).toBeLessThanOrEqual(304);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const ticks = await chart.locator('.MuiChartsAxis-bottom text').all();
  for (const tick of ticks) {
    const box = await tick.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(16);
    expect(box!.x + box!.width).toBeLessThanOrEqual(304);
  }
});
