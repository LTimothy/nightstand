import { describe, expect, it } from 'vitest';
import { DEFAULT_SMART, type Dismissed, type NightLog, type Rhythm, type RhythmNights, type SuggestionRow } from '@api/rhythmsSchema';
import { SUGGESTION_RULES } from '@api/suggestionRules';
import { createDemoRhythms } from '../../../mocks/rhythmsMock';
import { withRows } from './rhythmsModel';
import {
  addLabel, cardEvidence, cardLine, cardRowLine, chartCaption, DONT_SUGGEST, dontSuggestLabel, evidenceSentence, hiddenForLine,
  hiddenIntro, hiddenRow, lastNightText, nearLine, overlayCaption,
  provenance, reviewName, sheetHeading, sheetOverline, showAgainName, showNightsLabel, startsLine,
  uncheckedNote, undoAddMessage, undoHideMessage, withChangeRows,
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

const offDays = createDemoRhythms(new Date('2026-10-12T19:00:00Z')).right.rhythms['off-days'];
const workday: Rhythm = { ...createDemoRhythms(new Date('2026-10-12T19:00:00Z')).left.rhythms.workday, smart: { ...DEFAULT_SMART } };
const evidence = { supportingDates: ['2026-10-01'], firstNight: '2026-10-01', lastNight: '2026-10-11' };
const step: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', supporting: 9, ...evidence, time: '23:45', temperatureF: 79, plannedF: 82,
  thenBack: { time: '02:00', temperatureF: 82, supporting: 8 },
};
const up: SuggestionRow = {
  kind: 'step', key: 'step:up', direction: 'up', supporting: 7, ...evidence, time: '05:00', temperatureF: 84, plannedF: 79,
};
const replacing: SuggestionRow = {
  kind: 'step', key: 'step:down', direction: 'down', supporting: 9, ...evidence, time: '03:00', replaces: '03:00',
  temperatureF: 77, plannedF: 79,
};
const on: SuggestionRow = {
  kind: 'on', key: 'on:down', direction: 'down', supporting: 8, ...evidence, temperatureF: 80, plannedF: 82,
  thenBack: { time: '01:00', temperatureF: 82, supporting: 7 },
};
const base: SuggestionRow = {
  kind: 'base', key: 'base:down', direction: 'down', supporting: 9, ...evidence, baseLevel: -1, currentBaseLevel: 0,
};

describe('cards and near misses', () => {
  it('names every setting Add writes', () => {
    expect(cardLine('Off days', [step], 'fahrenheit')).toBe('Off days: 79°F at 11:45 PM, back to 82°F at 2:00 AM');
    expect(cardLine('Off days', [{ ...step, thenBack: undefined }], 'fahrenheit')).toBe('Off days: 79°F at 11:45 PM');
    expect(cardLine('Off days', [on], 'fahrenheit')).toBe('Off days: starts at 80°F, back to 82°F at 1:00 AM');
    expect(cardLine('Workday', [base], 'level')).toBe('Workday: base one step cooler');
    expect(cardLine('Off days', [{ ...step, thenBack: undefined }, up], 'fahrenheit')).toBe('Off days: 79°F at 11:45 PM, 84°F at 5:00 AM');
    expect(cardLine('Off days', [step], 'level')).toBe('Off days: −1 at 11:45 PM, back to 0 at 2:00 AM');
    expect(cardLine('Off days', [{ ...step, temperatureF: 83, plannedF: 82, thenBack: undefined }], 'level')).toBe('Off days: 83°F at 11:45 PM');
  });

  it('gives each row its own count, and a name that contains the visible word', () => {
    expect(cardEvidence(step, 14)).toBe('From 9 of 14 nights');
    expect(cardRowLine(step, 14, 'fahrenheit')).toBe('79°F at 11:45 PM, back to 82°F at 2:00 AM · 9 of 14 nights');
    expect(cardRowLine(up, 14, 'fahrenheit')).toBe('84°F at 5:00 AM · 7 of 14 nights');
    expect(reviewName('Off days')).toBe('Review suggestion for Off days');
  });

  it('describes a near miss by direction and count', () => {
    expect(nearLine('Off days', { ...step, supporting: 6 }, 14)).toBe('Off days: cooler around 11:45 PM on 6 of 14 nights');
    expect(nearLine('Off days', { ...on, supporting: 5 }, 12)).toBe('Off days: a cooler start on 5 of 12 nights');
    expect(nearLine('Workday', { ...base, supporting: 5 }, 12)).toBe('Workday: cooler than the night temperature on 5 of 12 nights');
    expect(hiddenForLine('Off days', 9)).toBe('Off days: hidden for 9 more nights');
    expect(hiddenForLine('Off days', 1)).toBe('Off days: hidden for 1 more night');
  });
});

describe('the review sheet', () => {
  it('names the habit', () => {
    expect(sheetOverline('Off days', 'right')).toBe('Off days, right side');
    expect(sheetHeading([step])).toBe('Cooler around 11:45 PM');
    expect(sheetHeading([{ ...step, time: '00:30' }, up])).toBe('Cooler around 12:30 AM, warmer around 5:00 AM');
    expect(sheetHeading([on])).toBe('Cooler start');
    expect(sheetHeading([base])).toBe('Base one step cooler');
  });

  it('gives the evidence for each kind, with about once', () => {
    expect(evidenceSentence(step, 14, 'fahrenheit'))
      .toBe('9 of 14 nights: 82°F to about 79°F around 11:45 PM. 8 of those: back to 82°F around 2:00 AM.');
    expect(evidenceSentence(replacing, 14, 'fahrenheit')).toBe('9 of 14 nights: about 77°F instead of 79°F at 3:00 AM.');
    expect(evidenceSentence(on, 12, 'fahrenheit'))
      .toBe('8 of 12 nights: about 80°F within 15 minutes of turning on, instead of 82°F. 7 of those: back to 82°F around 1:00 AM.');
    expect(evidenceSentence(base, 12, 'level'))
      .toBe('9 of 12 nights: cooler than the night temperature. The whole curve moves, warm start included.');
    expect(evidenceSentence({ ...step, direction: 'up', temperatureF: 83, thenBack: undefined }, 14, 'level'))
      .toBe('9 of 14 nights: 82°F to about 83°F around 11:45 PM.');
    expect(uncheckedNote(1)).toBe('The unchecked change starts counting again after you add.');
    expect(uncheckedNote(2)).toBe('The unchecked changes start counting again after you add.');
  });

  it('lists the whole night with this change, marking new and changed rows', () => {
    expect(withChangeRows(offDays, withRows(offDays, [step, up]), 'fahrenheit')).toEqual([
      '11:00 PM | On, 82°F', '11:45 PM | 79°F | new', '2:00 AM | 82°F | new', '3:00 AM | 79°F', '5:00 AM | 84°F | new', '7:00 AM | Off',
    ]);
    expect(withChangeRows(offDays, withRows(offDays, [replacing]), 'fahrenheit')).toEqual([
      '11:00 PM | On, 82°F', '3:00 AM | 77°F | changed, was 79°F', '7:00 AM | Off',
    ]);
    expect(withChangeRows(offDays, withRows(offDays, [on]), 'fahrenheit')).toEqual([
      '11:00 PM | On, 80°F | changed, was 82°F', '1:00 AM | 82°F | new', '3:00 AM | 79°F', '7:00 AM | Off',
    ]);
    expect(withChangeRows(workday, withRows(workday, [base]), 'level')).toEqual(['Base: 0 now, −1 with this change']);
    expect(withChangeRows(workday, withRows(workday, [base]), 'fahrenheit')).toEqual(['Base: 83°F now, 80°F with this change']);
  });

  it('says where the numbers come from and when the change starts', () => {
    expect(provenance('Off days')).toBe('Middle values of those nights, rounded. Counted since you last changed Off days.');
    expect(startsLine({ kind: 'tonight' }, 'Off days')).toBe('Starts tonight.');
    expect(startsLine({ kind: 'today', at: '14:00' }, 'Night shift')).toBe('Starts at 2:00 PM today.');
    expect(startsLine({ kind: 'date', date: '2026-10-18' }, 'Off days')).toBe('Starts Sun, Oct 18.');
    expect(startsLine({ kind: 'paused' }, 'Off days')).toBe('Starts after the pause.');
    expect(startsLine({ kind: 'none' }, 'Off days')).toBe('Starts next time Off days runs.');
    expect([
      addLabel('Off days'), addLabel('Off days', 2, 2), addLabel('Off days', 3, 3), addLabel('Off days', 1, 2), addLabel('Off days', 0, 2),
    ]).toEqual(['Add to Off days', 'Add both to Off days', 'Add all 3 to Off days', 'Add 1 of 2 to Off days', 'Add to Off days']);
    expect([DONT_SUGGEST, dontSuggestLabel(2, 2), dontSuggestLabel(1, 2), showNightsLabel(14)])
      .toEqual(["Don't suggest this", "Don't suggest this", "Don't suggest the checked", 'Show the 14 nights']);
  });
});

describe('undo and the hidden list', () => {
  it('says what Add changed', () => {
    expect(undoAddMessage('Off days', [step], 'fahrenheit')).toBe('Off days now sets 79°F at 11:45 PM and 82°F at 2:00 AM');
    expect(undoAddMessage('Off days', [{ ...on, thenBack: undefined }], 'fahrenheit')).toBe('Off days now starts at 80°F');
    expect(undoAddMessage('Off days', [on], 'fahrenheit')).toBe('Off days now starts at 80°F and sets 82°F at 1:00 AM');
    expect(undoAddMessage('Workday', [base], 'level')).toBe('Workday base is now one step cooler');
    expect(undoAddMessage('Off days', [step, up], 'fahrenheit'))
      .toBe('Off days now sets 79°F at 11:45 PM, 82°F at 2:00 AM and 84°F at 5:00 AM');
    expect(undoHideMessage('Off days')).toBe('Off days: suggestion hidden');
  });

  it('lists what is hidden and how to show it again', () => {
    const entry = (over: Partial<Dismissed>): Dismissed => ({
      id: 'a1b2c3d4e5f6', rhythmId: 'off-days', key: 'step:down', time: '23:45', scope: 'plan', nightsLeft: 0, ...over,
    });
    expect(hiddenIntro('Off days')).toBe('Not suggested again until you change Off days, or press Show again.');
    expect(hiddenRow(entry({}))).toBe('Hidden: cooler around 11:45 PM');
    expect(hiddenRow(entry({ key: 'on:up', time: null }))).toBe('Hidden: a warmer start');
    expect(hiddenRow(entry({ key: 'base:down', time: null }))).toBe('Hidden: a cooler base');
    expect(hiddenRow(entry({ scope: 'later', key: null, time: null, nightsLeft: 9 }))).toBe('All suggestions hidden for 9 more nights');
    expect(showAgainName(entry({}))).toBe('Show again, cooler around 11:45 PM');
    expect(showAgainName(entry({ scope: 'later', key: null, time: null, nightsLeft: 9 }))).toBe('Show again, all suggestions');
  });

  it('captions the chart from the log', () => {
    const logged = (date: string, changes: number): NightLog => night({
      date, changes: Array.from({ length: changes }, () => change()),
    });
    const all = [logged('2026-10-01', 1), logged('2026-10-02', 0), logged('2026-10-03', 0), logged('2026-10-04', 1)];
    expect(chartCaption(all, ['2026-10-01'])).toBe('One line per night. 2 had no change and sit on the dashed line. 1 had other changes.');
    expect(chartCaption(all.slice(0, 2), ['2026-10-01'])).toBe('One line per night. 1 had no change and sits on the dashed line.');
  });
});

describe('the card chart caption', () => {
  it('names the bold line and counts the nights, with no colours', () => {
    expect(overlayCaption(14, false)).toBe('The bold line is your schedule. The thin lines are the last 14 nights, brighter is more recent.');
    expect(overlayCaption(5, true)).toBe('The bold line is tonight\'s curve. The thin lines are the last 5 nights, brighter is more recent.');
    expect(overlayCaption(1, false)).toBe('The bold line is your schedule. The thin line is last night, 1 night so far.');
  });

  it('reads last night\'s set points to a screen reader', () => {
    const points = [{ x: 0, f: 82 }, { x: 45, f: 81 }, { x: 180, f: 83 }];
    expect(lastNightText(points, 480, '23:00', 'fahrenheit', false))
      .toBe('Last night: 82°F, then 81°F at 11:45 PM, then 83°F at 2:00 AM, off at 7:00 AM.');
    expect(lastNightText([{ x: 120, f: 70 }], 480, '23:00', 'celsius', false)).toBe('Last night: 21°C at 1:00 AM, off at 7:00 AM.');
    expect(lastNightText([{ x: 120, f: 79 }, { x: 180, f: 81 }], 480, '23:00', 'fahrenheit', false))
      .toBe('Last night: 79°F at 1:00 AM, then 81°F at 2:00 AM, off at 7:00 AM.');
  });

  it('reads a Smart night short: its start, its coolest and its end', () => {
    const points = [{ x: 0, f: 85 }, { x: 60, f: 82 }, { x: 210, f: 79 }, { x: 300, f: 79 }, { x: 400, f: 83 }];
    expect(lastNightText(points, 465, '23:00', 'fahrenheit', true))
      .toBe('Last night: 85°F at 11:00 PM, coolest 79°F at 2:30 AM, off at 6:45 AM.');
    expect(lastNightText([{ x: 0, f: 80 }], 465, '23:00', 'fahrenheit', true)).toBe('Last night: 80°F at 11:00 PM, off at 6:45 AM.');
  });
});
