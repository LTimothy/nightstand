import { describe, expect, it } from 'vitest';
import moment from 'moment-timezone';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import {
  formatPauseEnd, pauseEndError, pauseResumeAt, setTimeDefault, setTimeDefaultWith, tonightOnlyEnd, tonightOnlyEndWith,
} from './pauseTimes';

const night = (on: string, off: string) => ({ power: { on, off, enabled: true, onTemperature: 82 }, temperatures: {} });
// 2026-09-28 is a Monday.
const MONDAY_8PM = moment.utc('2026-09-28T20:00:00Z');
const LA = 'America/Los_Angeles';
// Saturday night before the fall-back and the spring-forward changes.
const FALL_BACK_8PM = moment.tz('2026-10-31 20:00', LA);
const SPRING_FORWARD_8PM = moment.tz('2027-03-13 20:00', LA);
const sunday = { sunday: night('22:00', '07:00') };

describe('tonightOnlyEnd', () => {
  it('ends at tonight\'s scheduled power off', () => {
    const end = tonightOnlyEnd({ monday: night('21:00', '07:00') }, 'UTC', MONDAY_8PM);
    expect(end.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  });

  it('ends at the running night\'s power off after midnight', () => {
    const end = tonightOnlyEnd({ monday: night('21:00', '07:00') }, 'UTC', moment.utc('2026-09-29T02:00:00Z'));
    expect(end.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  });

  it('falls back to noon tomorrow when tonight has no schedule', () => {
    expect(tonightOnlyEnd({}, 'UTC', MONDAY_8PM).toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });

  it('falls back to noon today in the small hours', () => {
    expect(tonightOnlyEnd({}, 'UTC', moment.utc('2026-09-29T03:00:00Z')).toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });

  it('ignores a power off more than a day away', () => {
    const end = tonightOnlyEnd({ wednesday: night('21:00', '07:00') }, 'UTC', MONDAY_8PM);
    expect(end.toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });

  it('works in the Pod timezone', () => {
    const end = tonightOnlyEnd({ monday: night('22:00', '06:30') }, 'America/Los_Angeles', moment.utc('2026-09-29T03:00:00Z'));
    expect(end.toISOString()).toBe('2026-09-29T13:30:00.000Z');
  });

  it('lands exactly on a minute when now has seconds', () => {
    const now = moment.utc('2026-09-28T20:13:47.321Z');
    for (const schedule of [{ monday: night('21:00', '07:00') }, {}]) {
      const end = tonightOnlyEnd(schedule, 'UTC', now);
      expect(end.seconds()).toBe(0);
      expect(end.milliseconds()).toBe(0);
    }
  });
});

describe('tonightOnlyEnd across a time change', () => {
  it('ends at the scheduled power off on the 25-hour fall-back night', () => {
    const end = tonightOnlyEnd({ saturday: night('22:00', '07:00') }, LA, FALL_BACK_8PM);
    expect(end.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('keeps the noon fallback at noon after the fall-back', () => {
    expect(tonightOnlyEnd({}, LA, FALL_BACK_8PM).toISOString()).toBe('2026-11-01T20:00:00.000Z');
  });

  it('ends at the scheduled power off on the 23-hour spring-forward night', () => {
    const end = tonightOnlyEnd({ saturday: night('22:00', '07:00') }, LA, SPRING_FORWARD_8PM);
    expect(end.toISOString()).toBe('2027-03-14T14:00:00.000Z');
  });

  it('keeps the noon fallback at noon after the spring-forward', () => {
    expect(tonightOnlyEnd({}, LA, SPRING_FORWARD_8PM).toISOString()).toBe('2027-03-14T19:00:00.000Z');
  });
});

describe('setTimeDefault', () => {
  it('picks the next bedtime after tonight', () => {
    const schedule = { monday: night('21:00', '07:00'), tuesday: night('22:00', '07:00') };
    expect(setTimeDefault(schedule, 'UTC', MONDAY_8PM).toISOString()).toBe('2026-09-29T22:00:00.000Z');
  });

  it('uses the following week when only tonight is scheduled', () => {
    expect(setTimeDefault({ monday: night('21:00', '07:00') }, 'UTC', MONDAY_8PM).toISOString())
      .toBe('2026-10-05T21:00:00.000Z');
  });

  it('falls back to a day after tonight\'s end without any schedule', () => {
    expect(setTimeDefault({}, 'UTC', MONDAY_8PM).toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('lands exactly on a minute when now has seconds', () => {
    const now = moment.utc('2026-09-28T20:13:47.321Z');
    for (const schedule of [{ monday: night('21:00', '07:00'), tuesday: night('22:00', '07:00') }, {}]) {
      const end = setTimeDefault(schedule, 'UTC', now);
      expect(end.seconds()).toBe(0);
      expect(end.milliseconds()).toBe(0);
    }
  });
});

describe('setTimeDefault across a time change', () => {
  it('picks the next bedtime after the fall-back night', () => {
    expect(setTimeDefault({ saturday: night('22:00', '07:00'), ...sunday }, LA, FALL_BACK_8PM).toISOString())
      .toBe('2026-11-02T06:00:00.000Z');
  });

  it('keeps the one-day fallback at noon after the fall-back', () => {
    expect(setTimeDefault({}, LA, FALL_BACK_8PM).toISOString()).toBe('2026-11-02T20:00:00.000Z');
  });

  it('keeps the one-day fallback at noon after the spring-forward', () => {
    expect(setTimeDefault({}, LA, SPRING_FORWARD_8PM).toISOString()).toBe('2027-03-15T19:00:00.000Z');
  });
});

describe('an unset Pod time zone', () => {
  it('computes in UTC', () => {
    const schedule = { monday: night('21:00', '07:00'), tuesday: night('22:00', '07:00') };
    expect(tonightOnlyEnd(schedule, '', MONDAY_8PM).toISOString()).toBe('2026-09-29T07:00:00.000Z');
    expect(tonightOnlyEnd({}, '', MONDAY_8PM).toISOString()).toBe('2026-09-29T12:00:00.000Z');
    expect(setTimeDefault(schedule, '', MONDAY_8PM).toISOString()).toBe('2026-09-29T22:00:00.000Z');
    expect(setTimeDefault({}, '', MONDAY_8PM).toISOString()).toBe('2026-09-30T12:00:00.000Z');
  });

  it('formats in UTC', () => {
    expect(formatPauseEnd(moment.utc('2026-09-29T07:00:00Z'), '', MONDAY_8PM)).toBe('7:00 AM tomorrow');
  });

  it('defaults now without throwing', () => {
    expect(() => tonightOnlyEnd({}, '')).not.toThrow();
    expect(() => setTimeDefault({}, '')).not.toThrow();
    expect(() => formatPauseEnd(moment.utc(), '')).not.toThrow();
  });
});

describe('formatPauseEnd', () => {
  it('says today, tomorrow or the date', () => {
    expect(formatPauseEnd(moment.utc('2026-09-28T23:00:00Z'), 'UTC', MONDAY_8PM)).toBe('11:00 PM today');
    expect(formatPauseEnd(moment.utc('2026-09-29T07:00:00Z'), 'UTC', MONDAY_8PM)).toBe('7:00 AM tomorrow');
    expect(formatPauseEnd(moment.utc('2026-09-30T18:00:00Z'), 'UTC', MONDAY_8PM)).toBe('Wed, Sep 30 at 6:00 PM');
  });
});

describe('pauseEndError', () => {
  it('accepts a future end up to 14 days away', () => {
    expect(pauseEndError(moment.utc('2026-09-29T07:00:00Z'), MONDAY_8PM)).toBeNull();
    expect(pauseEndError(moment.utc('2026-10-12T20:00:00Z'), MONDAY_8PM)).toBeNull();
  });

  it('rejects the past and anything past 14 days', () => {
    expect(pauseEndError(moment.utc('2026-09-28T20:00:00Z'), MONDAY_8PM)).toBe('Pick a time in the future');
    expect(pauseEndError(moment.utc('2026-10-12T20:01:00Z'), MONDAY_8PM)).toBe('Pick a time within 14 days');
  });
});

describe('pause times from any source of bed times', () => {
  it('uses the next power off and power on the source reports', () => {
    const off = moment.utc('2026-09-29T14:00:00Z');
    const on = moment.utc('2026-09-29T23:30:00Z');
    const next = (after: moment.Moment, kind: 'on' | 'off') => (kind === 'off' ? off : on).isAfter(after)
      ? (kind === 'off' ? off : on) : undefined;
    expect(tonightOnlyEndWith(next, 'UTC', MONDAY_8PM).toISOString()).toBe('2026-09-29T14:00:00.000Z');
    expect(setTimeDefaultWith(next, 'UTC', MONDAY_8PM).toISOString()).toBe('2026-09-29T23:30:00.000Z');
  });
});


describe('weekly resume at pause end', () => {
  it('does not resume when the delayed check reaches the night end', () => {
    const schedule = { monday: night('21:00', '07:00') };
    expect(pauseResumeAt({ state: 'legacy' }, schedule, 'UTC', moment.utc('2026-09-29T06:59:00Z'))).toBeUndefined();
    expect(pauseResumeAt({ state: 'legacy' }, schedule, 'UTC', moment.utc('2026-09-29T06:58:59Z'))?.toISOString())
      .toBe('2026-09-29T06:58:59.000Z');
  });

  it('resumes the Sunday night after the spring-forward change', () => {
    expect(pauseResumeAt({ state: 'legacy' }, { sunday: night('21:00', '02:30') }, LA, moment.tz('2027-03-15 02:00', LA))?.format())
      .toBe('2027-03-15T02:00:00-07:00');
  });

  it('does not resume a disabled night', () => {
    const disabled = night('21:00', '07:00');
    disabled.power.enabled = false;
    expect(pauseResumeAt({ state: 'legacy' }, { monday: disabled }, 'UTC', moment.utc('2026-09-28T23:00:00Z'))).toBeUndefined();
  });

  it('includes the start of a night with equal on and off times', () => {
    const schedule = { monday: night('21:00', '21:00') };
    expect(pauseResumeAt({ state: 'legacy' }, schedule, 'UTC', moment.utc('2026-09-28T21:00:00Z'))?.toISOString())
      .toBe('2026-09-28T21:00:00.000Z');
    expect(pauseResumeAt({ state: 'legacy' }, schedule, 'UTC', moment.utc('2026-09-29T12:00:00Z'))?.toISOString())
      .toBe('2026-09-29T12:00:00.000Z');
    expect(pauseResumeAt({ state: 'legacy' }, schedule, 'UTC', moment.utc('2026-09-29T21:00:00Z'))).toBeUndefined();
  });

  it('does not resume without a configured time zone', () => {
    expect(pauseResumeAt({ state: 'legacy' }, { monday: night('21:00', '07:00') }, '', moment.utc('2026-09-28T23:00:00Z')))
      .toBeUndefined();
  });
});

describe('Rhythms resume across a spring gap', () => {
  const sleep: ResolvedSleepResponse = {
    side: 'left', date: '2027-03-13', rhythmId: 'weekend', mode: 'smart',
    start: '2027-03-14T05:00:00Z', end: '2027-03-14T13:30:00Z',
    night: { ...night('21:00', '02:30'),
      alarm: { enabled: false, time: '02:30', vibrationIntensity: 30, vibrationPattern: 'rise', duration: 30, alarmTemperature: 83 },
      alarms: [] },
    smart: { baseLevel: 0, intensity: 'standard', warmStart: false, warmUp: true, upEarly: false, offWhenUp: true },
    offWhenUp: true,
    events: [
      { kind: 'power-on', at: '2027-03-14T05:00:00Z', temperatureF: 82 },
      { kind: 'power-off', at: '2027-03-14T13:30:00Z' },
    ],
  };

  it.each([
    ['01:45:00', '2027-03-14T09:45:00.000Z'],
    ['03:28:59', '2027-03-14T10:28:59.000Z'],
    ['03:29:00', undefined],
    ['03:30:00', undefined],
  ])('checks the delayed resume against the resolved off at %s', (time, expected) => {
    const end = moment.tz(`2027-03-14 ${time}`, LA);
    expect(pauseResumeAt({ state: 'rhythms', sleeps: [sleep] }, undefined, LA, end)?.toISOString()).toBe(expected);
  });

  it('stops resume at the scheduled off for a manual "When I get up" sleep', () => {
    const manual: ResolvedSleepResponse = { ...sleep, mode: 'manual', smart: undefined, offWhenUp: true };
    expect(pauseResumeAt({ state: 'rhythms', sleeps: [manual] }, undefined, LA, moment.tz('2027-03-14 03:29:00', LA))).toBeUndefined();
    expect(pauseResumeAt({ state: 'rhythms', sleeps: [manual] }, undefined, LA, moment.tz('2027-03-14 01:45:00', LA))?.toISOString())
      .toBe('2027-03-14T09:45:00.000Z');
  });
});
