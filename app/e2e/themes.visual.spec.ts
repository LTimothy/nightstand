/// <reference lib="dom" />
import { test, expect } from '@playwright/test';
import { THEME_IDS } from '../src/design/themes/ids';
import { DESKTOP, PHONE, SCREENS, openThemed } from './themeHelpers';

// Charts draw in with JavaScript, which the screenshot animations option does not stop.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.skip(process.platform !== 'linux', 'The baselines are rendered on Linux, in the Playwright image CI runs');

for (const id of THEME_IDS) {
  for (const screen of SCREENS) {
    for (const [label, size] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
      test(`${screen.name} in ${id} on a ${label}`, async ({ page }) => {
        await openThemed(page, id, screen.path, size);
        await screen.ready(page);
        await page.addStyleTag({ content: '[aria-label="Saving changes"] { display: none !important; }' });
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${screen.name}-${id}-${label}.png`, {
          animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.001,
        });
      });
    }
  }
}
