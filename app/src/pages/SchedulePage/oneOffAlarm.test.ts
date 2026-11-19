import { describe, expect, it } from 'vitest';
import { pendingOneOffText } from './oneOffAlarm';
import type { Settings } from '@api/settingsSchema';

const now = new Date('2026-11-19T15:00:00Z');
const make = (fireAt: string, over: { flag?: boolean; enabled?: boolean; away?: boolean; paused?: boolean } = {}) => ({
  timeZone: 'America/Los_Angeles',
  features: { oneOffAlarms: over.flag ?? true },
  left: {
    awayMode: over.away ?? false,
    alarmsEnabled: false,
    scheduleOverrides: { temperatureSchedules: { disabled: over.paused ?? true, expiresAt: '2099-01-01T00:00:00Z' } },
    oneOffAlarm: { enabled: over.enabled ?? true, fireAt },
  },
}) as unknown as Settings;

describe('pendingOneOffText', () => {
  it('names today, tomorrow and later dates in the Pod time zone', () => {
    expect(pendingOneOffText(make('2026-11-19T19:00:00-08:00'), 'left', now)).toBe('today at 7:00 PM');
    expect(pendingOneOffText(make('2026-11-20T07:00:00-08:00'), 'left', now)).toBe('tomorrow at 7:00 AM');
    expect(pendingOneOffText(make('2026-11-21T07:00:00-08:00'), 'left', now)).toBe('Sat, Nov 21 at 7:00 AM');
  });

  it('is null when off, disabled, past, unparsable or away', () => {
    const fire = '2026-11-20T07:00:00-08:00';
    expect(pendingOneOffText(make(fire, { flag: false }), 'left', now)).toBeNull();
    expect(pendingOneOffText(make(fire, { enabled: false }), 'left', now)).toBeNull();
    expect(pendingOneOffText(make('2026-11-19T06:00:00-08:00'), 'left', now)).toBeNull();
    expect(pendingOneOffText(make('nonsense'), 'left', now)).toBeNull();
    expect(pendingOneOffText(make(fire, { away: true }), 'left', now)).toBeNull();
  });

  it('still shows through a schedule pause and Alarms off', () => {
    expect(pendingOneOffText(make('2026-11-20T07:00:00-08:00', { paused: true }), 'left', now)).toBe('tomorrow at 7:00 AM');
  });
});
