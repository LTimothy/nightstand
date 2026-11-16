import assert from 'node:assert/strict';
import { it } from 'node:test';
import moment from 'moment-timezone';
import schedule from 'node-schedule';
import { scheduleZone, TIME_ZONES } from './timeZones.js';

it('every listed time zone is known to moment-timezone', () => {
  for (const zone of TIME_ZONES) assert.ok(moment.tz.zone(zone), zone);
});

it('keeps British Columbia on UTC-7 through the winter from 2026-11-01', () => {
  assert.equal(moment.tz('2026-12-15T12:00:00Z', 'America/Vancouver').utcOffset(), -7 * 60);
  assert.equal(moment.tz('2026-12-15T12:00:00Z', 'America/Los_Angeles').utcOffset(), -8 * 60);
});

it('schedules jobs on the offset moment-timezone uses, summer and winter', () => {
  const nextTen = (zone: string, from: string) => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = 22;
    rule.minute = 0;
    rule.tz = scheduleZone(zone);
    return rule.nextInvocationDate(new Date(from));
  };
  for (const zone of TIME_ZONES) {
    for (const from of ['2027-01-15T12:00:00Z', '2027-07-15T12:00:00Z']) {
      const fired = nextTen(zone, from);
      assert.equal(moment(fired).tz(zone).format('HH:mm'), '22:00', `${zone} ${from}`);
    }
  }
});
