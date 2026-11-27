import { test, expect, type Page } from '@playwright/test';

test('loads fonts and styles without contacting third-party hosts', async ({ page, baseURL }) => {
  const external: string[] = [];
  page.on('request', request => {
    if (['font', 'stylesheet'].includes(request.resourceType()) && new URL(request.url()).origin !== new URL(baseURL!).origin) {
      external.push(request.url());
    }
  });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary mobile' })).toBeVisible();
  expect(external).toEqual([]);
});

// The only off-origin requests the app makes are the two GitHub files it
// reads to offer updates and show release notes. Anything else, including
// serverInfo.json on GitHub, which no screen reads today, fails the test.
const ALLOWED = new Set([
  'https://raw.githubusercontent.com/LTimothy/nightstand/main/releases.json',
  'https://raw.githubusercontent.com/LTimothy/nightstand/main/CHANGELOG.md',
]);

type Opener = (page: Page) => Promise<void>;
// Each opener runs on a fresh load of the screen, so one dialog never hides another.
type Screen = { path: string; update?: boolean; rhythmsOff?: boolean; opens?: Opener[] };

const click = (name: string | RegExp, exact = true): Opener => async page => {
  await page.getByRole('button', { name, exact: typeof name === 'string' ? exact : undefined }).first().click();
};
const clickThenDialog = (name: string | RegExp): Opener => async page => {
  await click(name)(page);
  await expect(page.getByRole('dialog')).toBeVisible();
};
const toggleThenDialog = (name: string): Opener => async page => {
  await page.getByRole('switch', { name, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
};
const editRhythm = async (page: Page) => {
  await click('Edit Workday')(page);
  await expect(page.getByRole('button', { name: 'Smart Schedule' })).toBeVisible();
};

const SWEEP: Screen[] = [
  { path: '/', opens: [clickThenDialog('Pause schedule'), clickThenDialog('Change')] },
  // The side sticks between screens, so end on the left, whose rhythms the openers name.
  { path: '/right' },
  { path: '/left' },
  { path: '/elevation' },
  {
    path: '/schedules',
    opens: [
      clickThenDialog('Sun to Thu: Workday'),
      clickThenDialog(/^Today, .*: /),
      clickThenDialog('Change dates'),
      click('Changed dates (1)'),
      click('New rhythm'),
      click('Add one-time alarm'),
      editRhythm,
      async page => {
        await editRhythm(page);
        await clickThenDialog(/^Vibrate: /)(page);
      },
      async page => {
        await editRhythm(page);
        await clickThenDialog('The research behind it')(page);
      },
    ],
  },
  { path: '/sleep' },
  { path: '/sleep?metric=heart_rate' },
  { path: '/settings' },
  { path: '/settings/bed', opens: [click('Prime now')] },
  { path: '/settings/features', opens: [toggleThenDialog('Rhythms')] },
  { path: '/settings/device', opens: [clickThenDialog('Restart Pod')] },
  { path: '/settings/about', opens: [clickThenDialog('View license and disclaimer')] },
  { path: '/settings/system' },
  { path: '/settings/logs' },
  { path: '/changelog' },
  {
    path: '/settings/versions',
    opens: [
      async page => {
        await click('Recovery')(page);
        await expect(page.getByRole('button', { name: /^Go back to v/ })).toBeVisible();
      },
      async page => {
        await click('Recovery')(page);
        await clickThenDialog(/^Go back to v/)(page);
      },
      async page => {
        await click('Recovery')(page);
        await clickThenDialog('Install (downgrade)')(page);
      },
      async page => {
        await click('Recovery')(page);
        await clickThenDialog('Switch to upstream free-sleep')(page);
      },
    ],
  },
  { path: '/no-such-page' },
  // Screens that offer an update come after the plain ones; the preference then stays on.
  {
    path: '/settings/versions',
    update: true,
    opens: [clickThenDialog(/^Update to/), click("What's new")],
  },
  { path: '/changelog', update: true },
  // Rhythms off shows the other enable and disable paths.
  { path: '/settings/features', rhythmsOff: true, opens: [toggleThenDialog('Rhythms')] },
  { path: '/schedules', rhythmsOff: true },
];

// Collects every request and socket that leaves the app's own origin and
// does not match the allow list.
function watchOrigins(page: Page, ownOrigin: string) {
  const unexpected = new Set<string>();
  const allowedSeen = new Set<string>();
  const check = (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (['data:', 'blob:'].includes(url.protocol)) return;
    const origin = ['ws:', 'wss:'].includes(url.protocol) ? url.origin.replace(/^ws/, 'http') : url.origin;
    if (origin === ownOrigin) return;
    const file = `${url.origin}${url.pathname}`;
    if (ALLOWED.has(file) && url.search === '') allowedSeen.add(file);
    else unexpected.add(rawUrl);
  };
  // The context sees page requests and the mock worker's own fetches.
  page.context().on('request', request => check(request.url()));
  page.on('websocket', socket => check(socket.url()));
  return { unexpected, allowedSeen };
}

// Pages that stream (logs) never go idle, so settle for a bounded time.
const settle = (page: Page) => page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);

test('makes no off-origin request except the version check', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const { unexpected, allowedSeen } = watchOrigins(page, new URL(baseURL!).origin);

  let updatesOn = false;
  let rhythmsOff = false;
  for (const screen of SWEEP) {
    if (screen.update && !updatesOn) {
      updatesOn = true;
      await page.addInitScript(() => localStorage.setItem('nightstand-demo-update', 'on'));
    }
    if (screen.rhythmsOff && !rhythmsOff) {
      rhythmsOff = true;
      await page.addInitScript(() => localStorage.setItem('nightstand-demo-rhythms', 'off'));
    }
    for (const open of [undefined, ...(screen.opens ?? [])]) {
      await page.goto(screen.path);
      await expect(page.getByRole('navigation', { name: 'Primary mobile' })).toBeVisible();
      await settle(page);
      if (open) {
        await test.step(`${screen.path} opener ${screen.opens!.indexOf(open) + 1}`, () => open(page));
        await settle(page);
      }
    }
  }

  expect([...unexpected]).toEqual([]);
  // Guards against a sweep that stops reaching the version check.
  expect([...allowedSeen].sort()).toEqual([...ALLOWED].sort());
});

// Negative controls: the watcher must report what the sweep is meant to catch.
test.describe('the watcher reports off-origin traffic', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary mobile' })).toBeVisible();
  });

  test('a fetch', async ({ page, baseURL }) => {
    const { unexpected } = watchOrigins(page, new URL(baseURL!).origin);
    await page.evaluate(() => fetch('https://leak.invalid/collect?x=1').catch(() => undefined));
    expect([...unexpected]).toEqual(['https://leak.invalid/collect?x=1']);
  });

  test('an image tag', async ({ page, baseURL }) => {
    const { unexpected } = watchOrigins(page, new URL(baseURL!).origin);
    await page.evaluate(() => {
      const image = document.createElement('img');
      image.src = 'https://leak.invalid/pixel.png';
      document.body.append(image);
    });
    await expect.poll(() => [...unexpected]).toEqual(['https://leak.invalid/pixel.png']);
  });

  test('a WebSocket to a host that is not the Pod', async ({ page, baseURL }) => {
    const { unexpected } = watchOrigins(page, new URL(baseURL!).origin);
    await page.evaluate(() => {
      new WebSocket('wss://leak.invalid/stream').addEventListener('error', () => undefined);
    });
    await expect.poll(() => [...unexpected]).toEqual(['wss://leak.invalid/stream']);
  });

  test('but not a WebSocket to the app\'s own origin', async ({ page, baseURL }) => {
    const { unexpected } = watchOrigins(page, new URL(baseURL!).origin);
    await page.evaluate(() => {
      const socket = new WebSocket(`ws://${location.host}/socket`);
      socket.addEventListener('error', () => undefined);
    });
    await page.waitForTimeout(500);
    expect([...unexpected]).toEqual([]);
  });
});
