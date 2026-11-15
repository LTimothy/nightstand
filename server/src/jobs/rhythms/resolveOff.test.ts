import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SMART, type RhythmsDB } from '../../db/rhythmsSchema.js';
import { resolveSleeps, turnsOffWhenUp, withPowerOff, type PowerOffFor, type ResolvedSleep } from './resolve.js';
import { latestOff } from '../../db/smartOff.js';
import { alarmAt, dbOf, nightOf, rhythmOf, sideOf } from './rhythmsTestData.js';

// Monday 2026-09-28, 22:00 to 07:00 UTC, an alarm at 06:30 and a step after it.
const NIGHT = nightOf({ on: '22:00', off: '07:00', temperatures: { '23:00': 78, '06:45': 80 }, alarms: [alarmAt('06:30')] });
const WINDOW = { side: 'left' as const, timeZone: 'UTC', from: new Date('2026-09-28T12:00:00Z'), to: new Date('2026-09-29T12:00:00Z') };
const manual = dbOf(sideOf([rhythmOf('night', NIGHT)], { monday: 'night' }));
const upNight = rhythmOf('night', NIGHT, { temperatureMode: 'smart', smart: { ...DEFAULT_SMART, offWhenUp: true } });
const smart = dbOf(sideOf([upNight], { monday: 'night' }));
const offAt = (iso: string): PowerOffFor => (side, date) => (side === 'left' && date === '2026-09-28' ? new Date(iso) : undefined);

function tonight(db: RhythmsDB, powerOffFor?: PowerOffFor): ResolvedSleep {
  const sleep = resolveSleeps({ db, ...WINDOW, powerOffFor }).find(item => item.date === '2026-09-28');
  assert.ok(sleep, 'no sleep resolved');
  return sleep;
}

const kinds = (sleep: ResolvedSleep) => sleep.events.map(event => `${event.kind} ${event.at.toISOString().slice(11, 16)}`);

describe('resolveSleeps with an actual off', () => {
  it('keeps the set off when there is none', () => {
    const sleep = tonight(manual);
    assert.equal(sleep.end.toISOString(), '2026-09-29T07:00:00.000Z');
    assert.equal(sleep.setOff, undefined);
  });

  it('ends later while kept on, moving only the power-off', () => {
    const plain = tonight(manual);
    const later = tonight(manual, offAt('2026-09-29T09:30:00Z'));
    assert.equal(later.end.toISOString(), '2026-09-29T09:30:00.000Z');
    assert.equal(later.setOff?.toISOString(), '2026-09-29T07:00:00.000Z');
    assert.deepEqual(kinds(later), [...kinds(plain).slice(0, -1), 'power-off 09:30']);
  });

  it('ends earlier once up, dropping what was still ahead', () => {
    const earlier = tonight(manual, offAt('2026-09-29T06:40:00Z'));
    assert.equal(earlier.end.toISOString(), '2026-09-29T06:40:00.000Z');
    assert.deepEqual(kinds(earlier), ['power-on 22:00', 'temperature 23:00', 'alarm 06:30', 'power-off 06:40']);
    assert.equal(earlier.wake.toISOString(), '2026-09-29T06:30:00.000Z');
  });

  it('returns the same sleep for an actual off at the set off', () => {
    const sleep = tonight(manual);
    assert.equal(withPowerOff(sleep, sleep.end), sleep);
    assert.equal(withPowerOff(sleep, undefined), sleep);
  });

  it('keeps a Smart Schedule curve at the wake level to the actual off', () => {
    const plain = tonight(smart);
    const later = tonight(smart, offAt('2026-09-29T09:30:00Z'));
    assert.deepEqual(later.smartCurve?.points, plain.smartCurve?.points);
    assert.equal(later.smartCurve?.points.at(-1)?.phase, 'wake');
  });

  it('keeps a set off that happens twice on the fall back night at the first, and ends 3 real hours later', () => {
    const late = nightOf({ on: '22:00', off: '01:30' });
    const saturday = dbOf(sideOf([rhythmOf('late', late)], { saturday: 'late' }));
    const window = {
      side: 'left' as const, timeZone: 'America/Los_Angeles', from: new Date('2026-10-31T19:00:00Z'), to: new Date('2026-11-01T19:00:00Z'),
    };
    const [sleep] = resolveSleeps({ db: saturday, ...window });
    // 01:30 PDT, the first of the two 01:30s on 2026-11-01.
    assert.equal(sleep.end.toISOString(), '2026-11-01T08:30:00.000Z');
    const [later] = resolveSleeps({ db: saturday, ...window, powerOffFor: () => latestOff({ setOff: sleep.end }) });
    assert.equal(later.setOff?.toISOString(), '2026-11-01T08:30:00.000Z');
    assert.equal(later.end.toISOString(), '2026-11-01T11:30:00.000Z');
  });

  it('tells a "When I get up" sleep apart', () => {
    const up = { ...DEFAULT_SMART, offWhenUp: true };
    const manualUp = dbOf(sideOf([rhythmOf('m', NIGHT, { temperatureMode: 'manual', offWhenUp: true, smart: up })], { monday: 'm' }));
    assert.equal(turnsOffWhenUp(tonight(manualUp)), true);
    const oldManual = dbOf(sideOf([rhythmOf('m', NIGHT, { temperatureMode: 'manual', smart: up })], { monday: 'm' }));
    assert.equal(turnsOffWhenUp(tonight(oldManual)), false);
    const oldSmart = dbOf(sideOf([rhythmOf('s', NIGHT, { temperatureMode: 'smart', smart: up })], { monday: 's' }));
    assert.equal(turnsOffWhenUp(tonight(oldSmart)), true);
    const rhythmOnly = rhythmOf('s', NIGHT, { temperatureMode: 'smart', offWhenUp: true, smart: { ...DEFAULT_SMART } });
    const onlyRhythm = tonight(dbOf(sideOf([rhythmOnly], { monday: 's' })));
    assert.equal(turnsOffWhenUp(onlyRhythm), true);
    assert.equal(onlyRhythm.smart?.offWhenUp, true);
    assert.equal('offWhenUp' in tonight(manual), false);
  });
});
