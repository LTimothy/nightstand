import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NightExcludeSchema, NightLogSchema, SuggestionDismissSchema, SuggestionRestoreSchema, SuggestionsResponseSchema, } from './rhythmsSchema.js';
import { DEFAULT_SMART, RhythmIdSchema, RhythmSchema, RhythmsDBSchema, RhythmsUpdateSchema, SideRhythmsSchema, SmartScheduleSchema, } from './rhythmsSchema.js';
import { responseSchema } from './responseSchema.js';
import { dbOf, rhythmOf, sideOf, WORKDAY } from '../jobs/rhythms/rhythmsTestData.js';
describe('rhythmsSchema', () => {
    const db = dbOf(sideOf([rhythmOf('workday', WORKDAY, { name: 'Workday' })], { monday: 'workday' }, [
        { date: '2026-10-12', rhythmId: null },
    ]));
    it('accepts a complete file and the default Smart Schedule settings', () => {
        assert.equal(RhythmsDBSchema.safeParse(db).success, true);
        assert.equal(SmartScheduleSchema.safeParse(DEFAULT_SMART).success, true);
    });
    it('limits ids to short lowercase slugs', () => {
        for (const id of ['a', 'workday', 'night-shift-2', '9'.repeat(32)])
            assert.equal(RhythmIdSchema.safeParse(id).success, true, id);
        for (const id of ['', '-a', 'Workday', 'a b', '9'.repeat(33)])
            assert.equal(RhythmIdSchema.safeParse(id).success, false, id);
    });
    it('keeps a wake time of its own, in HH:mm', () => {
        assert.equal(db.left.rhythms.workday.wake, '06:30');
        assert.equal(RhythmSchema.safeParse({ ...db.left.rhythms.workday, wake: '07:15' }).success, true);
        for (const wake of ['7:15', '24:00', '', undefined]) {
            assert.equal(RhythmSchema.safeParse({ ...db.left.rhythms.workday, wake }).success, false, String(wake));
        }
    });
    it('trims names and caps them at 24 characters', () => {
        assert.equal(RhythmSchema.parse({ ...db.left.rhythms.workday, name: '  Workday ' }).name, 'Workday');
        assert.equal(RhythmSchema.safeParse({ ...db.left.rhythms.workday, name: '   ' }).success, false);
        assert.equal(RhythmSchema.safeParse({ ...db.left.rhythms.workday, name: 'x'.repeat(25) }).success, false);
    });
    it('rejects unknown keys, other versions and more than 120 changes', () => {
        assert.equal(RhythmsDBSchema.safeParse({ ...db, extra: 1 }).success, false);
        assert.equal(RhythmsDBSchema.safeParse({ ...db, version: 2 }).success, false);
        assert.equal(RhythmsDBSchema.safeParse({ ...db, legacyFingerprint: 'abc' }).success, false);
        const changes = Array.from({ length: 121 }, () => ({ date: '2026-10-12', rhythmId: null }));
        assert.equal(SideRhythmsSchema.safeParse({ ...db.left, changes }).success, false);
    });
    it('rejects unknown keys in a rhythm\'s power settings but the stored reader strips them', () => {
        const withExtra = structuredClone(db);
        withExtra.left.rhythms.workday.night.power.futurePower = true;
        const strict = RhythmsDBSchema.safeParse(withExtra);
        assert.equal(strict.success, false);
        assert.deepEqual(strict.success ? [] : strict.error.issues.map(issue => [issue.code, issue.path.join('.')]), [['unrecognized_keys', 'left.rhythms.workday.night.power']]);
        assert.deepEqual(responseSchema(RhythmsDBSchema).parse(withExtra), db);
    });
    it('accepts updates for either side and nothing else', () => {
        assert.equal(RhythmsUpdateSchema.safeParse({ left: db.left }).success, true);
        assert.equal(RhythmsUpdateSchema.safeParse({}).success, true);
        assert.equal(RhythmsUpdateSchema.safeParse({ left: db.left, version: 1 }).success, false);
    });
});
describe('suggestion shapes', () => {
    const row = {
        kind: 'step', key: 'step:down', direction: 'down', supporting: 9, firstNight: '2026-09-28', lastNight: '2026-10-10',
        supportingDates: ['2026-09-28', '2026-10-10'], time: '23:45', temperatureF: 79, plannedF: 82,
        thenBack: { time: '04:00', temperatureF: 82, supporting: 8 },
    };
    const night = {
        date: '2026-10-10', rhythmId: 'off-days', tonight: false, excluded: false,
        plan: [{ offsetMin: 0, temperatureF: 82 }], endMin: 480,
        start: '2026-10-10T23:00:00.000Z', samePlan: true,
        sets: [{ at: '2026-10-10T23:00:00.000Z', temperatureF: 82 }, { at: '2026-10-11T07:00:00.000Z', temperatureF: null }],
        changes: [{ at: '2026-10-11T00:31:00.000Z', fromF: 82, targetF: 79, plannedF: 82, held: false, source: 'api' }],
    };
    const response = {
        enabled: true,
        nights: { 'off-days': { counted: 14, needed: 5, changed: 9, earlier: false, reason: 'suggested' } },
        suggestions: [{ rhythmId: 'off-days', near: false, rows: [row] }],
        dismissed: [{ id: 'a1b2c3d4e5f6', rhythmId: 'off-days', key: 'step:up', time: '04:00', scope: 'plan', nightsLeft: 0 }],
        log: [night],
    };
    it('accepts a full response and refuses an unknown row kind or reason', () => {
        assert.equal(SuggestionsResponseSchema.safeParse(response).success, true);
        const unknownKind = structuredClone(response);
        unknownKind.suggestions[0].rows[0].kind = 'curve';
        assert.equal(SuggestionsResponseSchema.safeParse(unknownKind).success, false);
        const unknownReason = structuredClone(response);
        unknownReason.nights['off-days'].reason = 'sleepy';
        assert.equal(SuggestionsResponseSchema.safeParse(unknownReason).success, false);
    });
    it('allows a plan step for every set point a rhythm can hold, plus the power-on', () => {
        const plan = Array.from({ length: 49 }, (_, index) => ({ offsetMin: index, temperatureF: 80 }));
        assert.equal(NightLogSchema.safeParse({ ...night, plan }).success, true);
        assert.equal(NightLogSchema.safeParse({ ...night, plan: [...plan, { offsetMin: 49, temperatureF: 80 }] }).success, false);
    });
    it('keeps request bodies strict', () => {
        assert.equal(SuggestionDismissSchema.safeParse({ scope: 'later', side: 'right', rhythmId: 'off-days' }).success, true);
        assert.equal(SuggestionDismissSchema.safeParse({
            scope: 'plan', side: 'right', rhythmId: 'off-days', rows: [{ key: 'step:down', time: '23:45' }],
        }).success, true);
        assert.equal(SuggestionDismissSchema.safeParse({ scope: 'plan', side: 'right', rhythmId: 'off-days', rows: [] }).success, false);
        assert.equal(SuggestionRestoreSchema.safeParse({ side: 'left', ids: ['A1B2C3D4E5F6'] }).success, false);
        assert.equal(NightExcludeSchema.safeParse({ side: 'left', rhythmId: 'workday', date: '2026-10-10', excluded: true, x: 1 }).success, false);
    });
});
//# sourceMappingURL=rhythmsSchema.test.js.map