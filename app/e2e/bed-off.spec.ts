/// <reference lib="dom" />
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

// These specs measure where the controls sit, so they start with the demo bar dismissed.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('nightstand-demo-banner-dismissed', 'true'));
});

const sizes = [[320, 740], [360, 640], [375, 560], [375, 667], [390, 844], [768, 1024], [1280, 800]] as const;

test('turning a side off keeps the power button in place and shows last night under the dial', async ({ page }) => {
  await page.goto('/');
  const turnOff = page.getByRole('button', { name: 'Turn off' });
  await expect(turnOff).toBeVisible();
  // While on, last night stays in the chip below the controls.
  const chip = page.locator('[data-last-night-chip]');
  await expect(chip).toContainText(/^Last night: \d+h( \d+m)? in bed/);
  await expect(page.getByRole('button', { name: 'Warmer' })).toBeVisible();
  const onTop = (await turnOff.boundingBox())!.y;

  await turnOff.click();
  const turnOn = page.getByRole('button', { name: 'Turn on' });
  await expect(turnOn).toBeVisible();
  const row = page.locator('[data-controls-row]');
  const viewSleep = row.getByRole('link', { name: 'View last night\'s sleep' });
  await expect(viewSleep).toBeVisible();
  await expect(row.getByText(/^Last night: \d+h( \d+m)? in bed$/)).toBeVisible();
  await expect(chip).toHaveCount(0);

  const offTop = (await turnOn.boundingBox())!.y;
  expect(Math.abs(offTop - onTop)).toBeLessThanOrEqual(1);

  // Above the fold: clear of the bottom navigation without scrolling.
  const nav = (await page.getByRole('navigation', { name: 'Primary mobile' }).boundingBox())!;
  const link = (await viewSleep.boundingBox())!;
  expect(link.y + link.height).toBeLessThanOrEqual(nav.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const [width, height] of sizes) {
  test(`the off side's last night line fits the controls row on one line at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
    const row = page.locator('[data-controls-row]');
    const text = row.getByText(/^Last night: \d+h( \d+m)? in bed$/);
    await expect(text).toBeVisible();
    const rowBox = (await row.boundingBox())!;
    const textBox = (await text.boundingBox())!;
    const linkBox = (await row.getByRole('link', { name: 'View last night\'s sleep' }).boundingBox())!;
    // One line of text, and everything inside the row's box, so nothing spills over the caption or the power row.
    expect(textBox.height).toBeLessThanOrEqual(24);
    for (const box of [textBox, linkBox]) {
      expect(box.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);
      expect(box.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    }
    expect(await row.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    // A full size target beside the text, not on top of it.
    expect(linkBox.width).toBeGreaterThanOrEqual(44);
    expect(linkBox.height).toBeGreaterThanOrEqual(44);
    const apart = linkBox.x >= textBox.x + textBox.width - 0.5 || textBox.x >= linkBox.x + linkBox.width - 0.5
      || linkBox.y >= textBox.y + textBox.height - 0.5 || textBox.y >= linkBox.y + linkBox.height - 0.5;
    expect(apart).toBe(true);
  });
}

for (const [width, height] of [[390, 844], [320, 740], [360, 640], [375, 560], [375, 667]] as const) {
  test(`the caption keeps its slot under the dial when the side turns off at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const caption = page.locator('[data-caption-slot]');
    await expect(caption).toContainText(/^Turns off/);
    // Measure where the click leaves the page: Playwright scrolls a control clear of the scroll padding first.
    await page.getByRole('button', { name: 'Turn off' }).scrollIntoViewIfNeeded();
    const textHeight = () => caption.evaluate(node => Array.from(node.children)
      .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0));
    const onBox = (await caption.boundingBox())!;
    const onText = await textHeight();
    // The stepper labels end before the power row starts.
    const label = (await page.getByRole('button', { name: 'Cooler' }).locator('.stepper-label').boundingBox())!;
    const row = (await page.locator('[data-power-row]').boundingBox())!;
    expect(label.y + label.height).toBeLessThanOrEqual(row.y);

    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
    await expect(caption).toContainText(/^(Starts warming|Turns on)/);
    const offBox = (await caption.boundingBox())!;
    const offText = await textHeight();
    expect(Math.abs(offBox.y - onBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(offBox.height - onBox.height)).toBeLessThanOrEqual(1);

    // Under the dial, above the controls row, and the text fits its slot.
    const dial = (await page.locator('[data-dial]').boundingBox())!;
    const controls = (await page.locator('[data-controls-row]').boundingBox())!;
    for (const [box, text] of [[onBox, onText], [offBox, offText]] as const) {
      expect(box.y).toBeGreaterThanOrEqual(dial.y + dial.height - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(controls.y + 1);
      expect(text).toBeLessThanOrEqual(box.height + 1);
    }
  });
}

for (const [width, height] of [[320, 740], [360, 640], [375, 560], [375, 667], [375, 812], [390, 844]] as const) {
  test(`a long caption and a short one leave the caption slot and the power row in place at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    // Monday 11:00 PM, inside Monday's Workday sleep, so a get-up caption says tomorrow.
    await page.clock.install({ time: new Date('2026-09-29T06:00:00Z') });
    await page.goto('/schedules');
    await page.getByRole('button', { name: 'Edit Workday' }).click();
    await page.getByRole('combobox', { name: /^Turn off/ }).click();
    await page.getByRole('option', { name: 'When I get up' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('navigation', { name: 'Primary mobile' }).getByRole('link', { name: 'Bed', exact: true }).click();

    const caption = page.locator('[data-caption-slot]');
    // Page positions, so scrolling to the pause button does not count as movement.
    const measure = () => page.evaluate(() => {
      const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top + window.scrollY;
      const power = Array.from(document.querySelectorAll('[data-power-row] button'))
        .find(button => /^Turn (on|off)$/.test(button.textContent ?? ''))!;
      return {
        caption: top('[data-caption-slot]'),
        rowTop: top('[data-power-row]'),
        rowHeight: document.querySelector('[data-power-row]')!.getBoundingClientRect().height,
        power: power.getBoundingClientRect().top + window.scrollY,
        text: Array.from(document.querySelector('[data-caption-slot]')!.children)
          .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0),
      };
    });

    await expect(caption).toHaveText('Turns off when you get up, tomorrow by 9:45 AM');
    const long = await measure();

    await page.getByRole('button', { name: 'Pause schedule' }).click();
    await page.getByRole('radio', { name: /^Until I resume/ }).check();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(caption).toHaveText(/^Turns off at\s/);
    const short = await measure();

    // The long caption takes two lines only where the column is narrowest.
    if (width === 320) expect(short.text).toBeLessThan(long.text);
    else expect(short.text).toBeLessThanOrEqual(long.text);
    for (const key of ['caption', 'rowTop', 'rowHeight', 'power'] as const) {
      expect(Math.abs(short[key] - long[key])).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

for (const [width, height] of sizes) {
  test(`the power button never moves while toggling at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    // The tabs appear a moment after the page first paints and move everything below them.
    await expect(page.getByRole('link', { name: 'Elevation' })).toBeVisible();
    const power = page.getByRole('button', { name: /^Turn (on|off)$/ });
    await expect(power).toHaveText('Turn off');
    await power.scrollIntoViewIfNeeded();
    const rest = (await power.boundingBox())!;

    for (const next of ['Turn on', 'Turn off']) {
      await power.click();
      const boxes: { x: number; y: number; width: number }[] = [];
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(80);
        boxes.push((await power.boundingBox())!);
      }
      await expect(power).toHaveText(next);
      for (const box of boxes) {
        expect(Math.abs(box.y - rest.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.x - rest.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - rest.width)).toBeLessThanOrEqual(1);
      }
    }
  });
}

for (const [width, height] of [[360, 640], [375, 560], [375, 667], [390, 844], [1280, 800]] as const) {
  test(`nothing below the header moves while the page loads at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    // Sample every frame from the first one: the tiles, the caption slot, the power row and the Tonight card
    // exist from first paint. Keep sampling for 2 s after the power button appears.
    await page.addInitScript(() => {
      const selectors = ['[role="radiogroup"][aria-label="Bed side"]', '[data-caption-slot]', '[data-power-row]', '[data-tonight]'];
      const samples: Record<string, number[]> = Object.fromEntries(selectors.map(selector => [selector, []]));
      (window as unknown as { loadSamples: typeof samples }).loadSamples = samples;
      let powerSeenAt = 0;
      const sample = (now: number) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node) samples[selector].push(node.getBoundingClientRect().top + window.scrollY);
        }
        const power = Array.from(document.querySelectorAll('button')).find(button => /^Turn (on|off)$/.test(button.textContent ?? ''));
        if (power) powerSeenAt ||= now;
        if (!powerSeenAt || now - powerSeenAt < 2000) requestAnimationFrame(sample);
        else (window as unknown as { loadDone: boolean }).loadDone = true;
      };
      requestAnimationFrame(sample);
    });
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { loadDone?: boolean }).loadDone, undefined, { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Elevation' })).toBeVisible();
    const samples = await page.evaluate(() => (window as unknown as { loadSamples: Record<string, number[]> }).loadSamples);
    for (const [selector, series] of Object.entries(samples)) {
      expect(series.length, selector).toBeGreaterThan(10);
      expect(Math.max(...series) - Math.min(...series), selector).toBeLessThanOrEqual(1);
    }
  });
}

for (const [width, height] of sizes) {
  test(`the steppers and the power row sit above the bottom bar at ${width}x${height}, side on and off`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Elevation' })).toBeVisible();
    const power = page.getByRole('button', { name: /^Turn (on|off)$/ });
    await expect(power).toHaveText('Turn off');
    // At the top of the page, as it first paints: the bar's top, or the window's bottom where there is no bar.
    const clearance = () => page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Primary mobile"]');
      const navTop = nav && nav.getBoundingClientRect().height > 0 ? nav.getBoundingClientRect().top : window.innerHeight;
      const steppers = document.querySelector('[data-controls-row]')!.getBoundingClientRect();
      const row = document.querySelector('[data-power-row]')!.getBoundingClientRect();
      const padding = window.innerHeight - parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom);
      return { scrollY: window.scrollY, navTop, padding, steppers: steppers.bottom, row: row.bottom };
    });
    const on = await clearance();
    expect(on.scrollY).toBe(0);
    expect(on.steppers).toBeLessThanOrEqual(on.navTop);
    expect(on.row).toBeLessThanOrEqual(on.navTop);
    // Where there is room, clear of the scroll padding too, with a margin, so a tap or focus never scrolls the page.
    if (height >= 640) expect(on.row).toBeLessThanOrEqual(on.padding - 8);

    await power.click();
    await expect(power).toHaveText('Turn on');
    await page.evaluate(() => window.scrollTo(0, 0));
    const off = await clearance();
    expect(off.row).toBeLessThanOrEqual(off.navTop);
    expect(Math.abs(off.row - on.row)).toBeLessThanOrEqual(1);
  });
}

for (const [width, height] of sizes) {
  test(`the longest caption fits its two line slot at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    // Monday 11:00 PM, inside Monday's Workday sleep, so the get-up caption says tomorrow: the longest one there is.
    await page.clock.install({ time: new Date('2026-09-29T06:00:00Z') });
    await page.goto('/schedules');
    await page.getByRole('button', { name: 'Edit Workday' }).click();
    await page.getByRole('combobox', { name: /^Turn off/ }).click();
    await page.getByRole('option', { name: 'When I get up' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const nav = page.getByRole('navigation', { name: width >= 900 ? 'Primary desktop' : 'Primary mobile' });
    await nav.getByRole('link', { name: 'Bed', exact: true }).click();
    const caption = page.locator('[data-caption-slot]');
    await expect(caption).toHaveText('Turns off when you get up, tomorrow by 9:45 AM');
    const slot = (await caption.boundingBox())!;
    const text = await caption.evaluate(node => Array.from(node.children)
      .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0));
    expect(slot.height).toBeLessThanOrEqual(43);
    expect(text).toBeLessThanOrEqual(slot.height + 1);
  });
}

// Below about 550 px of height (a phone on its side) the column cannot fit above the bottom bar even with the
// smallest dial, so the page scrolls; here it only has to keep its order without overlaps or sideways scroll.
test('a phone on its side scrolls the page without overlaps at 844x390', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  const order = () => page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
    };
    const label = Array.from(document.querySelectorAll('.stepper-label')).map(node => node.getBoundingClientRect().bottom + window.scrollY);
    return {
      blocks: ['[role="radiogroup"][aria-label="Bed side"]', '[data-dial]', '[data-caption-slot]', '[data-controls-row]', '[data-power-row]']
        .map(box),
      labels: Math.max(0, ...label),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  for (const state of ['on', 'off']) {
    if (state === 'off') {
      await page.getByRole('button', { name: 'Turn off' }).click();
      await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
    }
    const { blocks, labels, scrollWidth } = await order();
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].top).toBeGreaterThanOrEqual(blocks[i - 1].bottom - 0.5);
    expect(labels).toBeLessThanOrEqual(blocks[4].top);
    expect(scrollWidth).toBeLessThanOrEqual(844);
  }
});

test('on a desktop the controls take a 440 px column and Tonight starts level with the tiles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  const tiles = (await page.getByRole('radiogroup', { name: 'Bed side' }).boundingBox())!;
  const card = (await page.locator('[data-tonight]').boundingBox())!;
  expect(Math.abs(tiles.width - 440)).toBeLessThanOrEqual(1);
  expect(Math.abs(card.y - tiles.y)).toBeLessThanOrEqual(1);
  expect(card.x - (tiles.x + tiles.width)).toBeGreaterThanOrEqual(47);
});

test('an off side\'s Tonight card leads with when it starts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Monday 9:41 PM in the demo's time zone, before the Workday sleep starts.
  await page.clock.install({ time: new Date('2026-09-29T04:41:00Z') });
  await page.goto('/');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expect(page.locator('[data-tonight]').getByText(/^Starts warming/))
    .toHaveText(/^Starts warming tonight at 10:00\sPM, \+1 \(Workday\)$/);
});
