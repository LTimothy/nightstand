import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changesRhythmsFlag, pauseRejection } from './settingsGuards.js';
import { Settings } from '../../db/settingsSchema.js';

describe('pauseRejection', () => {
  const now = new Date('2026-09-28T20:00:00Z');
  const current = (awayMode = false, storedEnd = '') => ({
    left: { awayMode, scheduleOverrides: { pause: { active: false, expiresAt: storedEnd } } },
    right: { awayMode: false, scheduleOverrides: { pause: { active: false, expiresAt: '' } } },
  }) as unknown as Settings;
  const pause = (active: boolean, expiresAt: string) => ({ left: { scheduleOverrides: { pause: { active, expiresAt } } } });

  it('allows a pause until resumed', () => {
    assert.equal(pauseRejection(current(), pause(true, ''), now), null);
  });

  it('allows an end exactly 14 days away', () => {
    assert.equal(pauseRejection(current(), pause(true, '2026-10-12T20:00:00Z'), now), null);
  });

  it('rejects an end more than 14 days away', () => {
    assert.equal(
      pauseRejection(current(), pause(true, '2026-10-12T20:01:00Z'), now),
      'A pause can end at most 14 days from now',
    );
  });

  it('rejects an end that is now or in the past', () => {
    for (const end of ['2026-09-28T20:00:00Z', '2026-09-28T19:00:00Z']) {
      assert.equal(pauseRejection(current(), pause(true, end), now), 'Choose a pause end time in the future');
    }
  });

  it('rejects pausing a side that is away', () => {
    assert.equal(
      pauseRejection(current(true), pause(true, ''), now),
      'Turn off away mode before pausing this side\'s schedule',
    );
  });

  it('rejects turning on away mode and a pause in one update', () => {
    const update = { left: { awayMode: true, scheduleOverrides: { pause: { active: true, expiresAt: '' } } } };
    assert.equal(pauseRejection(current(), update, now), 'Turn off away mode before pausing this side\'s schedule');
  });

  it('always allows resuming, even while away', () => {
    assert.equal(pauseRejection(current(true), pause(false, ''), now), null);
  });

  it('ignores updates that do not touch the pause', () => {
    assert.equal(pauseRejection(current(true), { left: { awayMode: true } }, now), null);
  });

  it('judges a partial update against the stored end', () => {
    const update = { left: { scheduleOverrides: { pause: { active: true } } } };
    assert.equal(
      pauseRejection(current(false, '2026-09-28T19:00:00Z'), update, now),
      'Choose a pause end time in the future',
    );
  });

  it('lets the partner pause while one side is away', () => {
    const update = { right: { scheduleOverrides: { pause: { active: true, expiresAt: '' } } } };
    assert.equal(pauseRejection(current(true), update, now), null);
  });
});

describe('changesRhythmsFlag', () => {
  it('flags only a body that would turn Rhythms on or off', () => {
    const off = { features: { rhythms: false } } as Settings;
    assert.equal(changesRhythmsFlag(off, { features: { rhythms: true } }), true);
    assert.equal(changesRhythmsFlag(off, { features: { rhythms: false } }), false);
    assert.equal(changesRhythmsFlag(off, { features: {} }), false);
    assert.equal(changesRhythmsFlag(off, {}), false);
  });
});
