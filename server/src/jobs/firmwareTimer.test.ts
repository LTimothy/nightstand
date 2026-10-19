import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-firmware-timer-'));
mkdirSync(path.join(folder, 'lowdb'));
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { firmwareSecondsUntil, nextScheduledOff, WEEKLY_FIRMWARE_MARGIN_SECONDS } = await import('./firmwareTimer.js');
const { MAX_ON_DURATION_SECONDS } = await import('../routes/deviceStatus/deviceStatusSchema.js');
after(() => rmSync(folder, { recursive: true, force: true }));

const LA = 'America/Los_Angeles';
const secondsUntilOff = (now: Date, off: string, tz: string) =>
  firmwareSecondsUntil(new Date(nextScheduledOff(now, off, tz).getTime() + WEEKLY_FIRMWARE_MARGIN_SECONDS * 1000), now);

describe('weekly firmware end', () => {
  it('counts to the next off across midnight, plus the margin', () => {
    const on = new Date('2026-10-05T04:00:00Z'); // 21:00 Pacific
    assert.equal(secondsUntilOff(on, '07:00', LA), 10 * 3600 + WEEKLY_FIRMWARE_MARGIN_SECONDS);
  });
  it('counts to a later off on the same day', () => {
    const on = new Date('2026-10-05T20:00:00Z'); // 13:00 Pacific
    assert.equal(secondsUntilOff(on, '15:30', LA), 2.5 * 3600 + WEEKLY_FIRMWARE_MARGIN_SECONDS);
  });
  it('never exceeds the firmware maximum', () => {
    const on = new Date('2026-10-05T01:00:00Z'); // 18:00 Pacific
    assert.equal(secondsUntilOff(on, '09:00', LA), MAX_ON_DURATION_SECONDS);
  });
  it('uses real elapsed time across the spring daylight-saving change', () => {
    const on = new Date('2027-03-14T05:00:00Z'); // 21:00 PST, Mar 13
    assert.equal(secondsUntilOff(on, '07:00', LA), 9 * 3600 + WEEKLY_FIRMWARE_MARGIN_SECONDS);
  });
  it('treats an off equal to now as tomorrow, so the cap applies', () => {
    const on = new Date('2026-10-05T04:00:00Z');
    assert.equal(secondsUntilOff(on, '21:00', LA), MAX_ON_DURATION_SECONDS);
  });
});

describe('firmwareSecondsUntil', () => {
  it('falls back to the firmware maximum for an end that is not a time', () => {
    assert.equal(firmwareSecondsUntil(new Date(Number.NaN), new Date()), MAX_ON_DURATION_SECONDS);
  });
});

describe('nextScheduledOff', () => {
  const UTC = 'UTC';
  it('is later today until the minute itself, then tomorrow', () => {
    assert.equal(nextScheduledOff(new Date('2026-10-05T06:59:59Z'), '07:00', UTC).toISOString(), '2026-10-05T07:00:00.000Z');
    assert.equal(nextScheduledOff(new Date('2026-10-05T07:00:00Z'), '07:00', UTC).toISOString(), '2026-10-06T07:00:00.000Z');
  });
  it('lands on the local wall clock across a daylight-saving change', () => {
    // 2026-11-01 is the fall change in Los Angeles; 07:00 that day is 15:00 UTC.
    assert.equal(nextScheduledOff(new Date('2026-11-01T05:00:00Z'), '07:00', LA).toISOString(), '2026-11-01T15:00:00.000Z');
  });
});
