import { test, expect } from '@playwright/test';

test('one-time alarm Save is disabled until a future fire-at time is set', async ({ page }) => {
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'Add one-time alarm' }).first().click();

  const enabledSwitch = page.getByRole('switch', { name: 'Enable one-time alarm' });
  await expect(enabledSwitch).toBeVisible();
  await expect(enabledSwitch).not.toBeChecked();

  const save = page.getByRole('button', { name: 'Save one-time alarm' });
  await expect(save).toBeVisible();

  await enabledSwitch.click();
  await expect(enabledSwitch).toBeChecked();

  // Enabling with no fire-at set yet must disable Save.
  await expect(save).toBeDisabled();

  await page.locator('input[type="datetime-local"]').fill('2099-01-02T07:30');

  // A non-empty future fire-at makes Save enabled.
  await expect(save).toBeEnabled();
});
