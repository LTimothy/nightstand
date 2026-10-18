import { defineConfig, devices } from '@playwright/test';
import { THEME_STORAGE_KEY } from './src/design/themes/ids';

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;
// NIGHTSTAND_THEME=<id> runs every spec in that look, for checking a look against the layout specs.
const theme = process.env.NIGHTSTAND_THEME;

// Drives the pre-built demo (app/dist) in headless Chromium and WebKit. The demo's MSW
// service worker intercepts every request, so this runs fully offline. Build
// the demo first with `npm run build:demo` (the CI job does this in a prior
// step); the webServer below only serves it.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    // Not Pacific, the demo's own zone, so a spec that only passes on a Pacific-time machine fails here.
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
    ...(theme ? {
      storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: THEME_STORAGE_KEY, value: theme }] }] },
    } : {}),
  },
  projects: [
    // The bottom navigation (aria-label per item, what these specs target)
    // only renders below the MUI 'md' breakpoint (900px); the AppBar variant
    // takes over above it. Narrow the viewport so the app's real mobile
    // layout is what gets exercised.
    { name: 'chromium', testIgnore: /layout-sweep/, use: { ...devices['Desktop Chrome'], viewport: { width: 480, height: 854 } } },
    ...[320, 360, 390, 430, 768, 1280].map(width => ({
      name: `sweep-${width}`,
      testMatch: /layout-sweep\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width, height: width < 768 ? 800 : 900 },
        deviceScaleFactor: 2,
        isMobile: width < 768,
        hasTouch: width < 768,
        timezoneId: 'America/Los_Angeles',
      },
    })),
    // Most people add the app from Safari on an iPhone.
    {
      name: 'webkit',
      testMatch: /(bed-off|sleep-context|rhythms|pause-schedule|navigation|layout-sweep)\.spec\.ts/,
      use: { ...devices['iPhone 13'], timezoneId: 'America/Los_Angeles' },
    },
  ],
  webServer: {
    command: `VITE_ENV=demo npx vite preview --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
