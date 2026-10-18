import { expect, test, type Page } from '@playwright/test';
import { SWEEP } from './routes';
import { probeLayout } from './layoutProbe';
import { smallTargets } from './themeHelpers';

// Charts draw in with JavaScript, which the screenshot animations option does not stop.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

// Pages that stream (logs) never go idle, so settle for a bounded time.
const settle = (page: Page) => page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
// Sheets slide in, so measure once every finite transition has ended.
const transitionsDone = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
  .map(animation => animation.finished.catch(() => undefined))));

// Key screens keep a picture at phone widths. The baselines are Linux renders from the Playwright image CI runs.
const PICTURED = new Set(['bed', 'bed off', 'schedule', 'rhythm editor', 'sleep night', 'settings', 'software', 'system status']);
const pictured = (name: string, project: string) =>
  process.platform === 'linux' && PICTURED.has(name) && ['sweep-320', 'sweep-390'].includes(project);

for (const state of SWEEP) {
  test(`layout: ${state.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.clock.install({ time: new Date('2026-10-01T21:00:00-07:00') });
    await page.goto(state.path);
    await settle(page);
    if (state.open) await state.open(page);
    await transitionsDone(page);
    expect(await probeLayout(page)).toEqual([]);
    expect(await smallTargets(page)).toEqual([]);
    expect(errors).toEqual([]);
    if (pictured(state.name, testInfo.project.name)) {
      await page.addStyleTag({ content: '[aria-label="Saving changes"] { display: none !important; }' });
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${state.name}.png`, { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' });
    }
  });
}

// Negative controls: the probe must report what the sweep is meant to catch, in each engine.
test.describe('the probe reports', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!['sweep-390', 'webkit'].includes(testInfo.project.name), 'Checked once per engine');
    await page.goto('/');
    await page.getByRole('button', { name: /^Turn (off|on)$/ }).waitFor();
  });

  const add = (page: Page, html: string) => page.evaluate(markup => {
    const host = document.createElement('div');
    host.innerHTML = markup;
    document.body.append(host);
  }, html);

  test('sideways scroll', async ({ page }) => {
    await add(page, '<p style="width: 2000px">Too wide</p>');
    const problems = await probeLayout(page);
    expect(problems).toContain('p "Too wide" ends past the right edge');
    expect(problems.some(problem => /^page scrolls sideways \(\d+ > 390\)$/.test(problem))).toBe(true);
  });

  test('overlapping text', async ({ page }) => {
    await add(page, [
      '<div style="position: absolute; top: 300px; left: 20px">',
      '<span>First label</span><span style="margin-left: -40px">Second label</span></div>',
    ].join(''));
    expect(await probeLayout(page)).toContain('span "First label" overlaps span "Second label"');
  });

  test('a word broken mid-word but not a compound wrapped at its hyphen', async ({ page }) => {
    await add(page, '<p style="width: 40px; word-break: break-all">Hardware</p><p style="width: 60px">Sun-to-Thu</p>');
    const problems = await probeLayout(page);
    expect(problems).toContain('"Hardware" breaks across lines in p "Hardware"');
    expect(problems.filter(problem => problem.includes('Sun'))).toEqual([]);
  });

  test('a break inside one part of a hyphenated compound', async ({ page }) => {
    await add(page, '<p style="width: 30px; word-break: break-all">Workday-Weekend</p>');
    expect(await probeLayout(page)).toContain('"Workday" breaks across lines in p "Workday-Weekend"');
  });

  test('overlaps within one fixed or sticky layer, but not across layers', async ({ page }) => {
    const pair = (first: string, second: string) => `<span>${first}</span><span style="margin-left: -40px">${second}</span>`;
    await add(page, [
      `<div style="position: fixed; top: 200px; left: 20px">${pair('Fixed one', 'Fixed two')}</div>`,
      `<div style="position: absolute; top: 400px; left: 20px; height: 80px; overflow: auto">`,
      `<div style="position: sticky; top: 0">${pair('Sticky one', 'Sticky two')}</div>`,
      '<p style="margin-top: -24px">Under the header</p><div style="height: 200px"></div></div>',
    ].join(''));
    const problems = await probeLayout(page);
    expect(problems).toContain('span "Fixed one" overlaps span "Fixed two"');
    expect(problems).toContain('span "Sticky one" overlaps span "Sticky two"');
    expect(problems.filter(problem => problem.includes('Sticky') && problem.includes('Under the header'))).toEqual([]);
  });

  test('only what an open modal shows, and a filled label over its field', async ({ page }) => {
    await add(page, [
      '<div style="position: absolute; top: 300px; left: 20px" aria-hidden="true">',
      '<span>Hidden one</span><span style="margin-left: -40px">Hidden two</span></div>',
      '<div style="position: absolute; top: 400px; left: 20px"><label for="probe-field">Field label</label>',
      '<input id="probe-field" value="Typed" style="margin-left: -60px"></div>',
    ].join(''));
    let problems = await probeLayout(page);
    expect(problems).toContain('span "Hidden one" overlaps span "Hidden two"');
    expect(problems).toContain('label "Field label" overlaps input ""');
    await add(page, '<div role="dialog" aria-modal="true" style="position: fixed; inset: 0; background: black"><p>Sheet</p></div>');
    problems = await probeLayout(page);
    expect(problems.filter(problem => problem.includes('overlaps'))).toEqual([]);
  });

  test('a control under 44 px', async ({ page }) => {
    await add(page, '<button style="width: 24px; height: 24px; padding: 0">x</button>');
    expect(await smallTargets(page)).toContain('x 24x24');
  });
});
