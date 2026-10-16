import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import express from 'express';
import moment from 'moment-timezone';

// Isolated DATA_FOLDER, set before the dynamic imports (config.ts reads it at
// import time). Same pattern as jobs/scheduleOverride.test.ts.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-settings-validation-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';

let settingsRouter: express.Router;

let server: Server;
let baseUrl: string;

before(async () => {
  ({ default: settingsRouter } = await import('./settings.js'));

  const app = express();
  app.use(express.json());
  app.use(settingsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

const postSettings = async (body: unknown) => {
  const res = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const futureIso = () => moment().add(1, 'hour').format();

const postAlarmOverride = (timeOverride: string, expiresAt = futureIso()) => postSettings({
  left: { scheduleOverrides: { alarm: { disabled: false, timeOverride, expiresAt } } },
});

describe('POST /settings alarm timeOverride validation', () => {
  it('rejects an out-of-range HH:mm alarm timeOverride', async () => {
    const res = await postAlarmOverride('25:00');
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('rejects a non-time alarm timeOverride', async () => {
    const res = await postAlarmOverride('tomorrow morning');
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('accepts a valid HH:mm alarm timeOverride', async () => {
    const res = await postAlarmOverride('07:00');
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('accepts an empty timeOverride, which is how the UI clears an override', async () => {
    const res = await postAlarmOverride('', '');
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
});

describe('POST /settings expiresAt validation', () => {
  it('rejects a non-parseable alarm expiresAt', async () => {
    const res = await postAlarmOverride('07:00', 'not a date');
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('rejects a non-parseable temperature schedule expiresAt', async () => {
    const res = await postSettings({
      left: { scheduleOverrides: { temperatureSchedules: { disabled: true, expiresAt: 'soon' } } },
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('accepts the offset-bearing ISO string the server itself writes', async () => {
    const res = await postSettings({
      left: { scheduleOverrides: { temperatureSchedules: { disabled: true, expiresAt: futureIso() } } },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
});

describe('POST /settings one-off alarm fireAt validation', () => {
  const oneOffAlarm = (fireAt: string) => postSettings({
    left: {
      oneOffAlarm: {
        enabled: true, fireAt, vibrationIntensity: 50, vibrationPattern: 'rise', duration: 60,
      },
    },
  });

  it('rejects a non-ISO fireAt', async () => {
    const res = await oneOffAlarm('whenever');
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('rejects an HH:mm fireAt, which is not a datetime', async () => {
    const res = await oneOffAlarm('07:00');
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  });

  it('accepts an ISO fireAt', async () => {
    const res = await oneOffAlarm(futureIso());
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('accepts an empty fireAt, the stored unset value', async () => {
    const res = await oneOffAlarm('');
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });
});

describe('POST /settings rawArchiveRetentionDays', () => {
  it('writes the archiver conf when the retention changes', async () => {
    const res = await postSettings({ rawArchiveRetentionDays: 7 });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(readFileSync(path.join(dataFolder, 'raw-archive.conf'), 'utf8'), 'RETENTION_HOURS=168\n');
  });

  for (const days of [0, 61, 2.5]) {
    it(`rejects ${days} days`, async () => {
      const res = await postSettings({ rawArchiveRetentionDays: days });
      assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    });
  }
});

describe('POST /settings schedule pause', () => {
  const pause = (side: 'left' | 'right', active: boolean, expiresAt: string) =>
    postSettings({ [side]: { scheduleOverrides: { pause: { active, expiresAt } } } });

  beforeEach(async () => {
    await postSettings({
      left: { awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
      right: { awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
    });
  });

  it('saves a pause that ends tomorrow', async () => {
    const expiresAt = moment().add(1, 'day').format();
    const res = await pause('left', true, expiresAt);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.left.scheduleOverrides.pause, { active: true, expiresAt });
    assert.deepEqual(res.body.right.scheduleOverrides.pause, { active: false, expiresAt: '' });
  });

  it('saves a pause until resumed', async () => {
    const res = await pause('left', true, '');
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('rejects an end in the past', async () => {
    const res = await pause('left', true, moment().subtract(1, 'minute').format());
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Choose a pause end time in the future');
  });

  it('rejects an end more than 14 days away', async () => {
    const res = await pause('left', true, moment().add(15, 'days').format());
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A pause can end at most 14 days from now');
  });

  it('rejects an end that is not a datetime', async () => {
    const res = await pause('left', true, 'tomorrow');
    assert.equal(res.status, 400);
  });

  it('rejects pausing a side in away mode and keeps the stored pause', async () => {
    await postSettings({ left: { awayMode: true } });
    const res = await pause('left', true, '');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Turn off away mode before pausing this side\'s schedule');
    const after = await postSettings({});
    assert.deepEqual(after.body.left.scheduleOverrides.pause, { active: false, expiresAt: '' });
  });

  it('resumes a side even while it is away', async () => {
    await pause('left', true, '');
    await postSettings({ left: { awayMode: true } });
    const res = await pause('left', false, '');
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('accepts a bare active flag and rejects a non-boolean one', async () => {
    const ok = await postSettings({ left: { scheduleOverrides: { pause: { active: true } } } });
    assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${JSON.stringify(ok.body)}`);
    const bad = await postSettings({ left: { scheduleOverrides: { pause: { active: 'yes' } } } });
    assert.equal(bad.status, 400);
  });

  it('does not store unknown keys inside the pause', async () => {
    const res = await postSettings({
      left: { scheduleOverrides: { pause: { active: true, expiresAt: '', note: 'x' } } },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.left.scheduleOverrides.pause, { active: true, expiresAt: '' });
  });
});

describe('POST /settings features.rhythms', () => {
  it('starts off and leaves turning it on or off to the Rhythms routes', async () => {
    const before = await fetch(`${baseUrl}/settings`).then(res => res.json());
    assert.equal(before.features.rhythms, false);
    const res = await postSettings({ features: { rhythms: true } });
    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal((await postSettings({ features: { rhythms: false } })).status, 200);
    assert.equal((await postSettings({ features: { futureFeature: true } })).status, 400);
    assert.equal((await postSettings({ features: { rhythms: 'yes' } })).status, 400);
  });
});

describe('POST /settings tap gestures', () => {
  it('replaces a gesture instead of keeping fields of its previous action', async () => {
    await postSettings({ right: { taps: { doubleTap: {
      type: 'alarm', behavior: 'snooze', snoozeDuration: 300, inactiveAlarmBehavior: 'none',
    } } } });
    const res = await postSettings({ right: { taps: { doubleTap: { type: 'temperature', change: 'increment', amount: 3 } } } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.right.taps.doubleTap, { type: 'temperature', change: 'increment', amount: 3 });
  });

  it('saves a gesture that sets a temperature', async () => {
    const res = await postSettings({ left: { taps: { quadTap: { type: 'set_temperature', temperatureF: 78 } } } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.left.taps.quadTap, { type: 'set_temperature', temperatureF: 78 });
  });

  for (const temperatureF of [54, 111, 78.5, undefined]) {
    it(`refuses a set temperature of ${temperatureF}`, async () => {
      const res = await postSettings({ left: { taps: { quadTap: { type: 'set_temperature', temperatureF } } } });
      assert.equal(res.status, 400);
    });
  }
});
