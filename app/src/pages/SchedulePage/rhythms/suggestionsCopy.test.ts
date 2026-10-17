import { describe, expect, it } from 'vitest';
import type { NightLog, RhythmNights } from '@api/rhythmsSchema';
import { SUGGESTION_RULES } from '@api/suggestionRules';
import {
  clockOf, featureDescription, howSuggestionsWork, LEAVE_OUT_HINT, leaveOutName, nightLabel, noteLines, notesCountLine, notesTitle,
  pairTemperatures, reasonLine, sectionCaption, whatCounts,
} from './suggestionsCopy';

const nights = (over: Partial<RhythmNights>): RhythmNights => ({
  counted: 14, needed: 5, changed: 8, earlier: false, reason: 'inconsistent', ...over,
});
const night = (over: Partial<NightLog> = {}): NightLog => ({
  date: '2026-10-10', rhythmId: 'off-days', tonight: false, excluded: false, plan: [{ offsetMin: 0, temperatureF: 82 }], endMin: 480,
  changes: [], ...over,
});
const change = (over: Partial<NightLog['changes'][number]> = {}): NightLog['changes'][number] => ({
  at: '2026-10-11T00:31:00.000Z', fromF: 82, targetF: 79, plannedF: 82, held: false, source: 'api', ...over,
});

describe('temperatures', () => {
  it('shows both values in °F only when two values share a level', () => {
    expect(pairTemperatures(82, 83, 'level')).toEqual(['82°F', '83°F']);
    expect(pairTemperatures(82, 79, 'level')).toEqual(['0', '−1']);
    expect(pairTemperatures(82, 83, 'celsius')).toEqual(['28°C', '28.5°C']);
    expect(pairTemperatures(82, 79, 'fahrenheit')).toEqual(['82°F', '79°F']);
  });

  it('reads clock times the way the rest of the app does', () => {
    expect(clockOf('23:45')).toBe('11:45 PM');
    expect(clockOf('04:00')).toBe('4:00 AM');
  });
});

describe('reason lines', () => {
  it.each([
    [nights({ counted: 3, reason: 'few-nights' }), 'manual', 'Off days: 3 of 5 nights so far'],
    [nights({ counted: 0, earlier: true, reason: 'few-nights' }), 'manual', 'Off days: counting again from tonight'],
    [nights({ counted: 0, reason: 'few-nights' }), 'manual', 'Off days: 0 of 5 nights so far'],
    [nights({ reason: 'no-change' }), 'manual', 'Off days: no changes in 14 nights'],
    [nights({ counted: 12, reason: 'no-change' }), 'smart', 'Off days: no night temperature changes in 12 nights'],
    [nights({ reason: 'inconsistent' }), 'manual', 'Off days: changes on 8 of 14 nights, but not the same one'],
    [nights({ reason: 'too-small' }), 'manual', 'Off days: already does what you set'],
    [nights({ reason: 'too-small' }), 'smart', 'Off days: changes too small to suggest'],
    [nights({ reason: 'refused' }), 'manual', 'Off days: no room for this change'],
    [nights({ reason: 'dismissed' }), 'manual', 'Off days: suggestion hidden'],
  ] as const)('line %#', (value, mode, line) => {
    expect(reasonLine('Off days', value, mode)).toBe(line);
  });

  it('has no line for a rhythm whose card already says it', () => {
    expect(reasonLine('Off days', nights({ reason: 'suggested' }), 'manual')).toBeNull();
  });
});

describe('rule texts', () => {
  it('reads the gate from the rules', () => {
    expect(sectionCaption()).toBe('Nightstand writes down changes you make by hand during a rhythm. One you repeat on half or more of '
      + 'your nights is suggested here after 5 nights.');
    expect(howSuggestionsWork()).toBe('A change you make the same way, within about 2 hours, on half or more of your last 14 nights is '
      + 'suggested after 5 nights. The suggested time and temperature are the middle of those nights. On a Smart Schedule rhythm it '
      + 'suggests the base, one step at a time. Nothing changes until you add it.');
    expect(whatCounts(false)).toBe('Changes you make by hand in this app, on the cover, or from another app on your network. '
      + 'Nightstand does not check whether anyone was in bed, so leave out a night you were away. A change undone within 10 minutes, '
      + 'or made during a pause, is not noted.');
    expect(whatCounts(true)).toBe(`${whatCounts(false)} On a Smart Schedule rhythm, only changes during the night count, of half a `
      + 'level or more.');
    expect(featureDescription()).toBe('Writes down when and how you change the temperature by hand during a rhythm, from any app or '
      + 'the cover. A change you repeat on half or more of your nights is suggested on Schedule. Nothing changes until you add it. '
      + 'Notes stay on this Pod for 90 days, not in backups.');
  });

  it('follows a changed rule', () => {
    const rules = { ...SUGGESTION_RULES, MIN_NIGHTS: 7, MIN_SHARE: 0.6, NOTE_DAYS: 60, COALESCE_MIN: 5 };
    expect(howSuggestionsWork(rules)).toMatch(/on 6 in 10 or more of your last 14 nights is suggested after 7 nights\./);
    expect(sectionCaption(rules)).toContain('after 7 nights');
    expect(whatCounts(false, rules)).toContain('undone within 5 minutes');
    expect(featureDescription(rules)).toContain('for 60 days');
  });
});

describe('notes', () => {
  it('writes each change on its own line, with only the tags that explain it', () => {
    const second = change({ at: '2026-10-11T04:00:00.000Z', fromF: 79, targetF: 82, held: true, source: 'tap' });
    const third = change({ at: '2026-10-11T05:00:00.000Z', fromF: 70, targetF: 82, plannedF: 79 });
    expect(noteLines(night({ changes: [change(), second, third] }), 'fahrenheit', 'UTC')).toEqual([
      '82°F to 79°F at 12:31 AM',
      '79°F to 82°F at 4:00 AM (cover)',
      '70°F to 82°F at 5:00 AM (planned 79°F)',
    ]);
  });

  it('says when a night had no change, and names tonight on its first line', () => {
    expect(noteLines(night(), 'fahrenheit', 'UTC')).toEqual(['no change']);
    expect(noteLines(night({ date: '2026-10-11', tonight: true }), 'fahrenheit', 'UTC')).toEqual(['Tonight: no change']);
    const tonight = night({ date: '2026-10-11', tonight: true, changes: [change(), change({ fromF: 79, targetF: 82 })] });
    expect(noteLines(tonight, 'fahrenheit', 'UTC')).toEqual(['Tonight: 82°F to 79°F at 12:31 AM', '79°F to 82°F at 12:31 AM']);
  });

  it('shows the person\'s format, falling back to °F where two values share a level', () => {
    expect(noteLines(night({ changes: [change({ fromF: null })] }), 'level', 'UTC')).toEqual(['0 to −1 at 12:31 AM']);
    expect(noteLines(night({ changes: [change({ fromF: 82, targetF: 83 })] }), 'level', 'UTC')).toEqual(['82°F to 83°F at 12:31 AM']);
    expect(noteLines(night({ changes: [change()] }), 'celsius', 'UTC')).toEqual(['28°C to 26°C at 12:31 AM']);
  });

  it('counts nights, names the sheet and the Leave out toggle', () => {
    expect(notesCountLine('Off days', 3, false)).toBe('3 nights so far.');
    expect(notesCountLine('Workday', 1, false)).toBe('1 night so far.');
    expect(notesCountLine('Off days', 3, true)).toBe('3 nights since you changed Off days.');
    expect(notesCountLine('Off days', 14, true)).toBe('Your last 14 nights.');
    expect(LEAVE_OUT_HINT).toBe('Press Leave out on a night that should not count, such as a night away.');
    expect(notesTitle()).toBe('Notes');
    expect(notesTitle('Off days')).toBe('Notes for Off days');
    expect(nightLabel(night())).toBe('Sat, Oct 10');
    expect(nightLabel(night(), true)).toBe('Sat, Oct 10, left out');
    expect(leaveOutName(night())).toBe('Leave out, Sat, Oct 10');
  });
});
