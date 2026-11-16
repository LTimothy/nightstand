import assert from 'node:assert/strict';
import { it } from 'node:test';
import moment from 'moment-timezone';
import { TIME_ZONES } from './timeZones.js';

it('every listed time zone is known to moment-timezone', () => {
  for (const zone of TIME_ZONES) assert.ok(moment.tz.zone(zone), zone);
});

it('keeps British Columbia on UTC-7 through the winter from 2026-11-01', () => {
  assert.equal(moment.tz('2026-12-15T12:00:00Z', 'America/Vancouver').utcOffset(), -7 * 60);
  assert.equal(moment.tz('2026-12-15T12:00:00Z', 'America/Los_Angeles').utcOffset(), -8 * 60);
});
