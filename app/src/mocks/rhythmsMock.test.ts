import { afterEach, expect, it } from 'vitest';
import type { Schedules } from '@api/schedulesSchema';
import { getDeviceStatus, getSchedules, updateDeviceStatus, updateSchedules } from './mockData';
import { createDemoRhythms, disableMockRhythms, mockLive, resetMockRhythms, resolveMockSleeps, scheduledSecondsRemaining } from './rhythmsMock';

const TUESDAY_MORNING = new Date('2026-09-29T17:00:00Z');
const MONDAY_NOON = new Date('2026-09-28T19:00:00Z');
const actions = (now: Date, body = {}) => disableMockRhythms(body, now).sides.map(item => item.action);

it('keeps a spring-gap wake at bedtime, as the resolver does', () => {
  const db = createDemoRhythms(MONDAY_NOON);
  const rhythm = db.left.rhythms.workday;
  rhythm.night.power = { ...rhythm.night.power, on: '02:50', off: '04:00' };
  rhythm.wake = '03:20';
  rhythm.smart.warmUp = false;
  const sleep = resolveMockSleeps(db, 'left', 'America/Los_Angeles', new Date('2026-03-08T08:00:00Z'),
    new Date('2026-03-08T12:00:00Z')).find(item => item.date === '2026-03-08')!;
  expect(sleep.wake).toBe('2026-03-08T10:50:00.000Z');
  expect(sleep.smartCurve?.wake).toBe(sleep.smartCurve?.bedtime);
  const times = sleep.smartCurve!.points.map(point => Date.parse(point.at));
  expect(times).toEqual([...times].sort((first, second) => first - second));
});

afterEach(() => resetMockRhythms());

it('keeps a side on until its sleep ends when Rhythms is turned off during that sleep', () => {
  resetMockRhythms(createDemoRhythms(TUESDAY_MORNING), true);
  const report = disableMockRhythms({}, TUESDAY_MORNING);
  expect(report.sides).toEqual([
    { side: 'left', action: 'none', alarmOverrideSet: false },
    { side: 'right', action: 'kept-on-until', until: '2026-09-29T22:30:00.000Z', alarmOverrideSet: false },
  ]);
});

it('powers a side off when asked to, and reports none when no sleep is running', () => {
  resetMockRhythms(createDemoRhythms(TUESDAY_MORNING), true);
  expect(actions(TUESDAY_MORNING, { powerOffNow: true })).toEqual(['none', 'powered-off']);
  resetMockRhythms(createDemoRhythms(MONDAY_NOON), true);
  expect(actions(MONDAY_NOON)).toEqual(['none', 'none']);
});

it('leaves a side that is off alone', () => {
  const wasOn = getDeviceStatus().right.isOn;
  updateDeviceStatus({ right: { ...getDeviceStatus().right, isOn: false } });
  resetMockRhythms(createDemoRhythms(TUESDAY_MORNING), true);
  expect(actions(TUESDAY_MORNING)).toEqual(['none', 'none']);
  updateDeviceStatus({ right: { ...getDeviceStatus().right, isOn: wasOn } });
});

it('hands over to a weekly night that covers the sleep', () => {
  const before = structuredClone(getSchedules().right.tuesday);
  const covering = { ...before, power: { ...before.power, on: '07:00', off: '16:00', enabled: true } };
  updateSchedules({ right: { tuesday: covering } } as unknown as Partial<Schedules>);
  resetMockRhythms(createDemoRhythms(TUESDAY_MORNING), true);
  expect(disableMockRhythms({}, TUESDAY_MORNING).sides[1]).toMatchObject({ action: 'legacy-takes-over', until: '2026-09-29T23:00:00.000Z' });
  updateSchedules({ right: { tuesday: before } } as unknown as Partial<Schedules>);
});

it('runs a side\'s firmware timer until its next scheduled turn-off', () => {
  // Monday 12:00 PM in Los Angeles. Workday turns off at 6:45 AM, the weekly Monday night at 7:00 AM.
  resetMockRhythms(createDemoRhythms(MONDAY_NOON), true);
  expect(scheduledSecondsRemaining('left', MONDAY_NOON)).toBe((Date.parse('2026-09-29T13:45:00Z') - MONDAY_NOON.getTime()) / 1000);
  resetMockRhythms(createDemoRhythms(MONDAY_NOON), false);
  expect(scheduledSecondsRemaining('left', MONDAY_NOON)).toBe((Date.parse('2026-09-29T14:00:00Z') - MONDAY_NOON.getTime()) / 1000);
});

it('serves any running sleep as live, with a latest off only for "When I get up", and nothing when none runs', () => {
  const db = createDemoRhythms(new Date('2026-09-28T19:00:00Z'));
  db.left.rhythms.workday.smart = { ...db.left.rhythms.workday.smart, offWhenUp: true };
  resetMockRhythms(db, true);
  try {
    // Tuesday 3:00 AM in Los Angeles, inside Monday's Workday sleep (6:45 AM off).
    const live = mockLive('left', new Date('2026-09-29T10:00:00Z'));
    expect(live?.date).toBe('2026-09-28');
    expect(live?.offWhenUp?.by).toBe('2026-09-29T16:45:00.000Z');
    expect(mockLive('right', new Date('2026-09-29T10:00:00Z'))).toBeNull();
    db.left.rhythms.workday.smart = { ...db.left.rhythms.workday.smart, offWhenUp: false };
    resetMockRhythms(db, true);
    expect(mockLive('left', new Date('2026-09-29T10:00:00Z'))?.offWhenUp).toBeNull();
  } finally {
    resetMockRhythms();
  }
});

it('serves a live manual "When I get up" sleep with no phase', () => {
  const db = createDemoRhythms(new Date('2026-09-28T19:00:00Z'));
  db.left.rhythms.weekly = { ...db.left.rhythms.workday, id: 'weekly', temperatureMode: 'manual', offWhenUp: true };
  db.left.week = { ...db.left.week, monday: 'weekly' };
  resetMockRhythms(db, true);
  try {
    const live = mockLive('left', new Date('2026-09-29T10:00:00Z'));
    expect(live?.phase).toBeNull();
    expect(live?.offWhenUp?.by).toBe('2026-09-29T16:45:00.000Z');
  } finally {
    resetMockRhythms();
  }
});

it('keeps the next-day wake clock after spring forward, as the resolver does', () => {
  const db = createDemoRhythms(MONDAY_NOON);
  const rhythm = db.left.rhythms.workday;
  rhythm.night.power = { ...rhythm.night.power, on: '20:00', off: '03:00' };
  rhythm.wake = '02:15';
  const sleeps = resolveMockSleeps(db, 'left', 'America/Los_Angeles', new Date('2026-03-09T03:00:00Z'),
    new Date('2026-03-09T11:00:00Z'));
  expect(sleeps.find(sleep => sleep.date === '2026-03-08')?.wake).toBe('2026-03-09T09:15:00.000Z');
});
