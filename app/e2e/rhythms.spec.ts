import { test, expect, type Page } from '@playwright/test';

const MONDAY_NOON = new Date('2026-09-28T19:00:00Z');
const TUESDAY_MORNING = new Date('2026-09-29T17:00:00Z');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary mobile' });

async function open(page: Page, path: string, time = MONDAY_NOON) {
  await page.clock.install({ time });
  await page.goto(path);
}

test('Schedule shows the week, the next two weeks and the rhythms', async ({ page }) => {
  await open(page, '/schedules');
  await expect(page.getByRole('heading', { name: 'Week', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Coming up', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rhythms', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sun to Thu: Workday' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fri and Sat: Weekend' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wed, Sep 30: No sleep scheduled, changed' })).toBeVisible();
});

test('choosing a rhythm for some days of a line saves it and can be undone', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Fri and Sat: Weekend' }).click();
  const picker = page.getByRole('dialog', { name: 'Fri and Sat' });
  await expect(picker.getByRole('button', { name: 'Friday', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await picker.getByRole('button', { name: 'Friday', exact: true }).click();
  // The title follows the days still chosen.
  const saturday = page.getByRole('dialog', { name: 'Saturday' });
  await expect(saturday.getByText('Use for Saturday')).toBeVisible();
  await saturday.getByRole('button', { name: /^Workday/ }).click();
  // Saturday joins the Sunday run, since the week wraps; six days read as every day but one.
  await expect(page.getByRole('button', { name: 'Every day but Fri: Workday' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Friday: Weekend' })).toBeVisible();
  const undo = page.getByRole('alert').filter({ hasText: 'Saturday now uses Workday' });
  await expect(undo).toBeVisible();
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Fri and Sat: Weekend' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sun to Thu: Workday' })).toBeVisible();
});

test('the undo bar sits fully inside a wide viewport with its message', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Fri and Sat: Weekend' }).click();
  await page.getByRole('dialog', { name: 'Fri and Sat' }).getByRole('button', { name: /^Workday/ }).click();
  const undo = page.getByRole('alert').filter({ hasText: 'Fri and Sat now use Workday' });
  await expect(undo.getByText('Fri and Sat now use Workday')).toBeVisible();
  const box = await undo.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
});

test('the undo bar does not cover Add one-time alarm at the end of the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Fri and Sat: Weekend' }).click();
  await page.getByRole('dialog', { name: 'Fri and Sat' }).getByRole('button', { name: /^Workday/ }).click();
  const undo = page.getByRole('alert').filter({ hasText: 'Fri and Sat now use Workday' });
  await expect(undo).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const add = await page.getByRole('button', { name: 'Add one-time alarm' }).first().boundingBox();
  const bar = await undo.boundingBox();
  expect(add!.y + add!.height).toBeLessThanOrEqual(bar!.y);
});

test('Edit opens the editor at the top, and Back brings the rhythm card into view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await open(page, '/schedules');
  const edit = page.getByRole('button', { name: 'Edit Weekend' });
  await edit.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await edit.click();
  await expect(page.getByLabel('Turn on at', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('button', { name: 'Rhythms', exact: true }).click();
  await expect(edit).toBeInViewport();
});

test('opening another picker puts the undo bar away', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Fri and Sat: Weekend' }).click();
  await page.getByRole('dialog', { name: 'Fri and Sat' }).getByRole('button', { name: /^Workday/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Fri and Sat now use Workday' })).toBeVisible();
  await page.getByRole('button', { name: 'Every day: Workday' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'now use Workday' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Every day' }).getByRole('button', { name: 'No sleep scheduled' })).toBeInViewport();
});

test('a date change is marked and can go back to Week', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: /^Tomorrow, Sep 29: Workday/ }).click();
  await page.getByRole('dialog', { name: 'Tomorrow, Sep 29' }).getByRole('button', { name: 'No sleep scheduled' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Tomorrow, Sep 29 now has no sleep scheduled' })).toBeVisible();
  const changed = page.getByRole('button', { name: 'Tomorrow, Sep 29: No sleep scheduled, changed' });
  await expect(changed).toBeVisible();
  await changed.click();
  await page.getByRole('dialog', { name: 'Tomorrow, Sep 29' }).getByRole('button', { name: 'Back to Week: Workday' }).click();
  await expect(page.getByRole('button', { name: /^Tomorrow, Sep 29: Workday/ })).toBeVisible();
});

test('a change past Coming up is listed and can be taken back', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Change a later date' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pick a date' });
  await sheet.getByLabel('Date').fill('2026-12-31');
  await expect(sheet.getByText('Pick a date from today to Fri, Nov 27')).toBeVisible();
  await sheet.getByLabel('Date').fill('2026-11-05');
  await sheet.getByRole('button', { name: 'Choose a rhythm' }).click();
  await page.getByRole('dialog', { name: 'Thu, Nov 5' }).getByRole('button', { name: 'No sleep scheduled' }).click();
  await page.getByRole('button', { name: 'Date changes (2)' }).click();
  await page.getByRole('button', { name: 'Thu, Nov 5: back to Week: Workday' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Thu, Nov 5 is back to Week: Workday' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Date changes (1)' })).toBeVisible();
});

test('several dates take one rhythm in one save with one undo', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Change several dates' }).click();
  const calendar = page.getByRole('dialog', { name: 'Change several dates' });
  await calendar.getByRole('button', { name: 'Tue, Sep 29', exact: true }).click();
  // Arrow keys move between dates; Space picks the focused one.
  await calendar.getByRole('button', { name: 'Tue, Sep 29', exact: true }).press('ArrowRight');
  await expect(calendar.getByRole('button', { name: /^Wed, Sep 30/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(calendar.getByRole('group', { name: 'October 2026' })).toBeVisible();
  await expect(calendar.getByRole('button', { name: 'Thu, Oct 1', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(calendar.getByRole('status')).toHaveText('2 dates selected');
  await expect(calendar.getByRole('button', { name: 'Fri, Nov 27', exact: true })).toHaveCount(0);
  const saves: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/rhythms')) saves.push(request.url()); });
  await calendar.getByRole('button', { name: 'Choose a rhythm' }).click();
  await page.getByRole('dialog', { name: '2 dates' }).getByRole('button', { name: /^Weekend/ }).click();
  const undo = page.getByRole('alert').filter({ hasText: '2 dates now use Weekend' });
  await expect(undo).toBeVisible();
  expect(saves).toHaveLength(1);
  await expect(page.getByRole('button', { name: /^Tomorrow, Sep 29: Weekend.*changed$/ })).toBeVisible();
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Tomorrow, Sep 29: Workday/ })).toBeVisible();
});

test('a pause shows on the Rhythms screen and marks the dates it skips', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: 'Pause schedule' }).click();
  await page.getByRole('radio', { name: /^Until I resume/ }).check();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await nav(page).getByRole('link', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('Schedule paused until you resume')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tomorrow, Sep 29: Workday.*, paused$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Resume schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Week', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: /^Tomorrow, Sep 29: Workday.*, paused$/ })).toHaveCount(0);
});

test('editing a rhythm reuses the night editor and leaving the tab discards without asking', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', async dialog => {
    dialogs += 1;
    await dialog.dismiss();
  });
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Edit Weekend' }).click();
  const turnOn = page.getByLabel('Turn on at', { exact: true });
  await expect(turnOn).toHaveValue('23:30');
  await turnOn.fill('23:15');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await nav(page).getByRole('link', { name: 'Bed', exact: true }).click();
  await nav(page).getByRole('link', { name: 'Schedule', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Weekend' }).click();
  await expect(page.getByLabel('Turn on at', { exact: true })).toHaveValue('23:30');
  expect(dialogs).toBe(0);
});

test('a Smart Schedule rhythm shows its controls and a preview', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Edit Workday' }).click();
  await expect(page.getByRole('button', { name: 'Smart Schedule', pressed: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Base temperature' })).toBeVisible();
  await expect(page.getByRole('figure', { name: /^Smart Schedule preview: \S+ at bedtime, \S+ overnight, \S+ at wake-up$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bedtime' }).getByLabel('Bedtime', { exact: true })).toHaveValue('22:30');
  await expect(page.getByText('The bed starts warming at 10:00 PM.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Through the night' })).toHaveCount(0);
  // The times come before the temperature controls.
  const wakeBox = await page.getByRole('region', { name: 'Wake up' }).boundingBox();
  const temperatureBox = await page.getByRole('region', { name: 'Temperature' }).boundingBox();
  expect(wakeBox!.y).toBeLessThan(temperatureBox!.y);
  // Turning the alarm off keeps the wake time and the warm-up.
  await page.getByRole('switch', { name: 'Enable alarm 1' }).click();
  await expect(page.getByRole('heading', { name: 'Wake up', exact: true })).toBeVisible();
  await expect(page.getByLabel('Wake at', { exact: true })).toBeEnabled();
  await expect(page.getByText(/at wake-up$/)).toBeVisible();
  // Without a warm start above the base, the bed only turns on early.
  await page.getByRole('switch', { name: 'Warm start' }).click();
  await expect(page.getByText('The bed turns on at 10:00 PM.')).toBeVisible();
  await page.getByRole('switch', { name: 'Warm start' }).click();
  await expect(page.getByText('The bed starts warming at 10:00 PM.')).toBeVisible();
  // A cool sleeper's warm start still pre-warms below neutral, so the bed only turns on early.
  for (let step = 0; step < 6; step++) await page.getByRole('button', { name: 'Decrease base temperature' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Base temperature' })).toHaveAttribute('aria-valuenow', '-7');
  await expect(page.getByText('The bed turns on at 10:00 PM.')).toBeVisible();
  await page.getByRole('button', { name: 'The research behind it' }).click();
  const sources = page.getByRole('dialog', { name: 'The research behind it' });
  for (const studies of await sources.getByRole('button', { name: /^Studies/ }).all()) await studies.click();
  await expect(sources.getByRole('link').first()).toBeVisible();
  for (const link of await sources.getByRole('link').all()) await expect(link).toHaveAttribute('href', /^https:\/\/doi\.org\/10\./);
  await expect(sources).toContainText('not a medical recommendation');
  await expect(sources.getByRole('heading', { name: 'Once you have settled in' })).toBeVisible();
  await expect(sources).not.toContainText('Once you are asleep');
  await expect(sources).not.toContainText(/minutes a night|beats a minute|about \d/);
  await sources.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Set by hand' }).click();
  await expect(page.getByRole('region', { name: 'Through the night' })).toBeVisible();
});

test('the Night shift example is a day sleep', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('radiogroup', { name: 'Bed side' }).getByRole('radio', { name: /^Sam/ }).click();
  const nightShift = page.getByRole('button', { name: 'Edit Night shift' });
  await expect(nightShift).toContainText('8:00 AM to 3:30 PM · Smart Schedule');
  await nightShift.click();
  await expect(page.getByRole('note')).toContainText('mostly during the day');
  await expect(page.getByText('Off for this rhythm, because its sleep is mostly during the day.')).toBeVisible();
});

test('a new rhythm starts on Smart Schedule and offers to be used', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'New rhythm' }).click();
  await expect(page.getByRole('button', { name: 'Smart Schedule', pressed: true })).toBeVisible();
  await expect(page.getByRole('figure', { name: /^Smart Schedule preview/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const use = page.getByRole('button', { name: 'Use Rhythm 3 on some days' });
  await expect(use).toBeFocused();
  await use.click();
  const sheet = page.getByRole('dialog', { name: 'Use Rhythm 3 on' });
  await sheet.getByRole('button', { name: 'Saturday', exact: true }).click();
  await sheet.getByRole('button', { name: 'Use on Saturday' }).click();
  await expect(page.getByRole('button', { name: 'Saturday: Rhythm 3' })).toBeVisible();
});

test('deleting a rhythm in use moves its days and can be undone', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Edit Weekend' }).click();
  await page.getByRole('button', { name: 'Delete rhythm' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Weekend?' });
  await expect(dialog).toContainText('Fri and Sat will use:');
  await dialog.getByRole('button', { name: 'Move and delete' }).click();
  await expect(page.getByRole('heading', { name: 'Rhythms', exact: true })).toBeFocused();
  const undo = page.getByRole('alert').filter({ hasText: 'Weekend deleted. Fri and Sat now use Workday' });
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Fri and Sat: Weekend' })).toBeVisible();
});

test('an overlapping change names the days and shows above the draft bar', async ({ page }) => {
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Edit Weekend' }).click();
  await page.getByRole('combobox', { name: /^Turn off/ }).click();
  await page.getByRole('option', { name: 'At a set time' }).click();
  await page.getByLabel('Turn off at', { exact: true }).fill('23:00');
  await expect(page.getByText(/^Turns off the next day at 11:00 PM,\s+23 h 30 min after bedtime$/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'would overlap' });
  await expect(error).toContainText('The sleeps starting Saturday and Sunday would overlap.');
  await expect(error).toBeFocused();
  await expect(error).toBeInViewport();
});

test('Bed reads the resolved sleep while Rhythms is on', async ({ page }) => {
  await open(page, '/');
  // Workday is a Smart Schedule rhythm with a 10:30 PM bedtime, so the bed powers on for the pre-warm at 10:00 PM.
  await expect(page.getByText(/^Starts warming tonight at 10:00 PM for a 10:30 PM bedtime/)).toBeVisible();
  await expect(page.getByText('Alarm tomorrow at 6:30 AM')).toBeVisible();
  await page.getByRole('button', { name: 'Pause schedule' }).click();
  await expect(page.getByRole('radio', { name: /^Tonight only.*Skips: 10:00 PM start, temperature changes, 6:30 AM alarm/ })).toBeChecked();
  await page.getByRole('radio', { name: /^Tonight only/ }).press('Enter');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByText(/^Back on schedule tomorrow at 10:00 PM \(Workday\)$/)).toBeVisible();
});

test('a day sleep is this sleep on Bed and in the pause sheet', async ({ page }) => {
  await open(page, '/', TUESDAY_MORNING);
  await page.getByRole('radiogroup', { name: 'Bed side' }).getByRole('radio', { name: /^Sam/ }).click();
  await expect(page.getByRole('heading', { name: 'This sleep' })).toBeVisible();
  await expect(page.getByText(/^Warm-up starts at 2:50 PM for your 3:15 PM wake-up$/)).toBeVisible();
  await page.getByRole('button', { name: 'Pause schedule' }).click();
  await expect(page.getByRole('radio', { name: /^This sleep only\s*until 3:30 PM today/ })).toBeChecked();
  await expect(page.getByText(/^Sam's side is on now and stays/)).toBeVisible();
});

test('a Smart Schedule sleep without a warm start says turns on', async ({ page }) => {
  await open(page, '/', new Date('2026-09-29T05:00:00Z'));
  await page.getByRole('radiogroup', { name: 'Bed side' }).getByRole('radio', { name: /^Sam/ }).click();
  await expect(page.getByText(/^Turns on tomorrow at 7:40 AM for an 8:00 AM bedtime, set to/)).toBeVisible();
});

test('turning Rhythms off previews the handoff and brings back the weekly schedule', async ({ page }) => {
  await open(page, '/settings/features');
  const toggle = page.getByRole('switch', { name: 'Rhythms', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  const dialog = page.getByRole('dialog', { name: 'Turn off Rhythms?' });
  await expect(dialog).toContainText('Your rhythms are kept for next time.');
  const night = /^(Tonight|Today|Tomorrow|\w{3}): weekly schedule, \d+:\d{2} [AP]M to \d+:\d{2} [AP]M\.$/;
  await expect(dialog.getByText(night).first()).toBeVisible();
  await expect(dialog.getByText(/^Alarm: /).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Turn off Rhythms' }).click();
  await expect(page.getByRole('alert')).toContainText('Rhythms is off. The weekly schedule is back for both sides.');
  await nav(page).getByRole('link', { name: 'Schedule', exact: true }).click();
  await expect(page.getByLabel('Turn on at', { exact: true })).toBeVisible();
  // A reload would reset the demo's in-memory store, so go back through the app.
  await nav(page).getByRole('link', { name: /^Settings/ }).click();
  await page.getByRole('link', { name: /^Features/ }).click();
  await page.getByRole('switch', { name: 'Rhythms', exact: true }).click();
  await page.getByRole('dialog', { name: 'Turn on Rhythms?' }).getByRole('button', { name: 'Turn on Rhythms' }).click();
  await expect(page.getByRole('alert')).toContainText('Rhythms is on. Your saved rhythms are back');
});

test('turning off during a sleep offers to keep that side on until the sleep ends', async ({ page }) => {
  await open(page, '/settings/features', TUESDAY_MORNING);
  await page.getByRole('switch', { name: 'Rhythms', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn off Rhythms?' });
  await expect(dialog.getByRole('radio', { name: 'Keep Sam\'s side on until 3:30 PM (its 3:15 PM alarm still rings)' })).toBeChecked();
  await expect(dialog.getByText(/^Alarm: .*3:15 PM still rings/)).toBeVisible();
  await dialog.getByRole('radio', { name: 'Turn off now' }).check();
  await expect(dialog.getByText(/^Alarm: .*still rings/)).toHaveCount(0);
  const request = page.waitForRequest(item => item.url().endsWith('/api/rhythms/disable'));
  await dialog.getByRole('button', { name: 'Turn off Rhythms' }).click();
  expect((await request).postDataJSON()).toEqual({ powerOffNow: true });
});

test('turning Rhythms on converts the weekly schedule and offers renaming', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nightstand-demo-rhythms', 'off'));
  await open(page, '/settings/features');
  await page.getByRole('switch', { name: 'Rhythms', exact: true }).click();
  await page.getByRole('dialog', { name: 'Turn on Rhythms?' }).getByRole('button', { name: 'Turn on Rhythms' }).click();
  const summary = page.getByRole('dialog', { name: 'Rhythms is on' });
  // Converted rhythms are named after their days, and each field says what sets it apart.
  const sunday = summary.getByRole('textbox', { name: 'Name for Sunday' }).first();
  await expect(sunday).toBeFocused();
  await expect(sunday).toHaveValue('Sunday');
  await expect(summary.getByText('Alarm Double pulse, strength 60, 30 s', { exact: true })).toBeVisible();
  await sunday.fill('School night');
  await summary.getByRole('button', { name: 'Save and open Schedule' }).click();
  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByRole('heading', { name: 'Week', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Edit School night' })).toBeVisible();
});

test('the Rhythms screen and editor fit 320px without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page, '/schedules');
  await expect(page.getByRole('heading', { name: 'Coming up', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'Change several dates' }).click();
  await expect(page.getByRole('button', { name: 'Tue, Sep 29', exact: true })).toBeVisible();
  const cell = await page.getByRole('button', { name: 'Tue, Sep 29', exact: true }).boundingBox();
  expect(cell!.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit Workday' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Base temperature' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('"When I get up" saves, and Bed says when it turns off at the latest', async ({ page }) => {
  // Tuesday 3:00 AM, inside Monday's Workday sleep, which turns off at 6:45 AM.
  await open(page, '/schedules', new Date('2026-09-29T10:00:00Z'));
  await page.getByRole('button', { name: 'Edit Workday' }).click();
  await page.getByRole('combobox', { name: /^Turn off/ }).click();
  await page.getByRole('option', { name: 'When I get up' }).click();
  await expect(page.getByLabel('Usually off at', { exact: true })).toHaveValue('06:45');
  await expect(page.getByText(/^After your wake time, it turns off once you've been out of bed for 10 minutes/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await nav(page).getByRole('link', { name: 'Bed', exact: true }).click();
  const caption = page.getByText('Turns off when you get up, today by 9:45 AM');
  await expect(caption).toBeVisible();
  // At most two lines.
  const box = (await caption.boundingBox())!;
  expect(box.height).toBeLessThan(2.6 * parseFloat(await caption.evaluate(node => getComputedStyle(node).lineHeight)));
});

test('a manual rhythm converted to Smart Schedule holds its line to wake with warm-up off', async ({ page }) => {
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await open(page, '/schedules');
  await page.getByRole('button', { name: 'Edit Weekend' }).click();
  await expect(page.getByRole('button', { name: 'Set by hand', pressed: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Enable alarm 1', exact: true }).uncheck();
  await page.getByLabel('Turn on at', { exact: true }).fill('20:00');
  await page.getByLabel('Wake at', { exact: true }).fill('08:00');
  await page.getByRole('button', { name: 'Smart Schedule', exact: true }).click();
  await page.getByRole('group', { name: 'Warm-up before wake', exact: true }).getByRole('button', { name: 'Off', exact: true }).click();
  await page.getByRole('combobox', { name: /^Turn off/ }).click();
  await page.getByRole('option', { name: 'At wake time', exact: true }).click();
  const chart = page.getByRole('figure', { name: /^Smart Schedule preview: .* at wake-up$/ });
  await expect(chart).toBeVisible();
  const wake = chart.locator('.MuiChartsAxis-tickLabel').filter({ hasText: /^Wake$/ });
  await expect(wake).toBeVisible();
  const line = chart.locator('.MuiLineElement-root');
  await expect(line).toHaveCount(1);
  await expect.poll(async () => line.evaluate(path => {
    const svgPath = path as SVGPathElement;
    const last = svgPath.getPointAtLength(svgPath.getTotalLength());
    const tick = Array.from(path.closest('svg')!.querySelectorAll('.MuiChartsAxis-tickLabel'))
      .find(node => node.textContent === 'Wake')!;
    const transform = tick.parentElement!.getAttribute('transform')!;
    const x = Number(transform.match(/translate\(([-\d.]+)/)![1]);
    return Math.abs(last.x - x);
  })).toBeLessThan(1);
});
