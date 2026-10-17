// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/
import { z } from 'zod';
import { DailyScheduleSchema, MAX_TEMPERATURES_PER_DAY, SideSchema, TemperatureSchema, TimeSchema } from './schedulesSchema.js';
import { MAX_SUGGESTIONS, WINDOW_NIGHTS } from './suggestionRules.js';
// The update and rollback scripts skip the pre-stop handoff for a target that
// has the prepare-to-stop route, assuming it can continue a rhythm sleep. A
// new version here must keep that true or change that check.
export const RHYTHMS_FILE_VERSION = 1;
export const MAX_RHYTHMS_PER_SIDE = 12;
export const RhythmIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SmartScheduleSchema = z.object({
    baseLevel: z.number().int().min(-10).max(10),
    intensity: z.enum(['gentle', 'standard']),
    warmStart: z.boolean(),
    warmUp: z.boolean(),
    upEarly: z.boolean(),
    // Turn off when the person gets up. Stored only when on; 3.5.0 drops it on
    // read and turns off at the set time.
    offWhenUp: z.boolean().optional(),
}).strict();
export const RhythmSchema = z.object({
    id: RhythmIdSchema,
    name: z.string().trim().min(1).max(24),
    // DailyScheduleSchema leaves power open, and POST /schedules relies on that.
    night: DailyScheduleSchema.extend({ power: DailyScheduleSchema.shape.power.strict() }),
    // When the person gets up, with or without an alarm.
    wake: TimeSchema,
    temperatureMode: z.enum(['manual', 'smart']),
    smart: SmartScheduleSchema,
}).strict();
export const WeekPlanSchema = z.object({
    sunday: RhythmIdSchema.nullable(),
    monday: RhythmIdSchema.nullable(),
    tuesday: RhythmIdSchema.nullable(),
    wednesday: RhythmIdSchema.nullable(),
    thursday: RhythmIdSchema.nullable(),
    friday: RhythmIdSchema.nullable(),
    saturday: RhythmIdSchema.nullable(),
}).strict();
export const DateChangeSchema = z.object({
    date: IsoDateSchema,
    rhythmId: RhythmIdSchema.nullable(),
}).strict();
export const SideRhythmsSchema = z.object({
    rhythms: z.record(RhythmIdSchema, RhythmSchema),
    week: WeekPlanSchema,
    changes: z.array(DateChangeSchema).max(120),
}).strict();
export const RhythmsDBSchema = z.object({
    version: z.literal(RHYTHMS_FILE_VERSION),
    legacyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    left: SideRhythmsSchema,
    right: SideRhythmsSchema,
}).strict();
// Body shape for POST /rhythms. A side that is sent replaces the stored side.
export const RhythmsUpdateSchema = z.object({
    left: SideRhythmsSchema.optional(),
    right: SideRhythmsSchema.optional(),
}).strict();
export const ACTIVATION_REASONS = ['flag-off', 'absent', 'invalid', 'unsupported-version', 'fingerprint-mismatch'];
export const RhythmsStatusSchema = z.object({
    enabled: z.boolean(),
    active: z.boolean(),
    reason: z.enum(ACTIVATION_REASONS).optional(),
}).strict();
export const RhythmsResponseSchema = z.object({
    status: RhythmsStatusSchema,
    data: RhythmsDBSchema.nullable(),
}).strict();
export const RhythmsSleepsQuerySchema = z.object({
    side: SideSchema,
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
}).strict();
export const DEFAULT_SMART = { baseLevel: 0, intensity: 'standard', warmStart: true, warmUp: true, upEarly: false };
// GET /rhythms/live: the running Smart Schedule night, read from memory.
export const CURVE_PHASES = ['prewarm', 'bedtime', 'cooldown', 'hold', 'warmup', 'wake', 'after'];
export const InstantSchema = z.string().datetime({ offset: true });
// Set while a "When I get up" sleep runs and presence is fresh: the latest it turns off.
export const OffWhenUpLiveSchema = z.object({ by: InstantSchema }).strict();
export const RhythmsLiveSchema = z.object({
    side: SideSchema,
    date: IsoDateSchema,
    phase: z.enum(CURVE_PHASES).nullable(),
    waiting: z.boolean(),
    coolStart: InstantSchema,
    hold: z.object({ until: InstantSchema }).strict().nullable(),
    baseSince: InstantSchema.nullable(),
    nextChange: z.object({ at: InstantSchema, level: z.number().int(), phase: z.enum(CURVE_PHASES) }).strict().nullable(),
    offWhenUp: OffWhenUpLiveSchema.nullable().optional(),
}).strict();
export const RhythmsLiveResponseSchema = RhythmsLiveSchema.nullable();
export const RhythmsLiveQuerySchema = z.object({ side: SideSchema }).strict();
// GET /rhythms/suggestions, and the bodies that hide, restore and exclude.
const Evidence = {
    key: z.string().max(24),
    direction: z.enum(['down', 'up']),
    supporting: z.number().int().min(1),
    firstNight: IsoDateSchema,
    lastNight: IsoDateSchema,
    // The review chart draws these nights from the log.
    supportingDates: z.array(IsoDateSchema).max(WINDOW_NIGHTS),
};
export const ThenBackSchema = z.object({
    time: TimeSchema, temperatureF: TemperatureSchema, supporting: z.number().int().min(1), replaces: TimeSchema.optional(),
}).strict();
export const SuggestionRowSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('step'), ...Evidence, time: TimeSchema, temperatureF: TemperatureSchema, plannedF: TemperatureSchema,
        replaces: TimeSchema.optional(), thenBack: ThenBackSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('on'), ...Evidence, temperatureF: TemperatureSchema, plannedF: TemperatureSchema, thenBack: ThenBackSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('base'), ...Evidence,
        baseLevel: z.number().int().min(-10).max(10), currentBaseLevel: z.number().int().min(-10).max(10),
    }).strict(),
]);
export const RhythmSuggestionSchema = z.object({
    rhythmId: RhythmIdSchema,
    // A near miss: the rhythm's leading pattern below the gate, always one row.
    near: z.boolean(),
    rows: z.array(SuggestionRowSchema).min(1).max(MAX_SUGGESTIONS),
}).strict();
export const SUGGESTION_REASONS = ['few-nights', 'no-change', 'inconsistent', 'too-small', 'refused', 'dismissed', 'suggested'];
export const RhythmNightsSchema = z.object({
    counted: z.number().int().min(0),
    needed: z.number().int().min(1),
    changed: z.number().int().min(0),
    earlier: z.boolean(),
    reason: z.enum(SUGGESTION_REASONS),
}).strict();
export const NightChangeSchema = z.object({
    at: InstantSchema, fromF: TemperatureSchema.nullable(), targetF: TemperatureSchema, plannedF: TemperatureSchema,
    held: z.boolean(), source: z.enum(['api', 'tap']),
}).strict();
export const NightLogSchema = z.object({
    date: IsoDateSchema,
    rhythmId: RhythmIdSchema,
    tonight: z.boolean(),
    excluded: z.boolean(),
    // The plan's steps that night, the power-on first.
    plan: z.array(z.object({ offsetMin: z.number().int().min(0), temperatureF: TemperatureSchema }).strict())
        .max(MAX_TEMPERATURES_PER_DAY + 1),
    endMin: z.number().int().min(1),
    changes: z.array(NightChangeSchema),
    // The night as the bed ran it, for the rhythm card; optional, so an older answer still reads.
    start: InstantSchema.optional(),
    samePlan: z.boolean().optional(),
    sets: z.array(z.object({ at: InstantSchema, temperatureF: TemperatureSchema.nullable() }).strict())
        .max(2 * MAX_TEMPERATURES_PER_DAY).optional(),
}).strict();
export const DismissIdSchema = z.string().regex(/^[0-9a-f]{12}$/);
export const DismissedSchema = z.object({
    id: DismissIdSchema,
    rhythmId: RhythmIdSchema,
    key: z.string().max(24).nullable(),
    time: TimeSchema.nullable(),
    scope: z.enum(['later', 'plan']),
    nightsLeft: z.number().int().min(0),
}).strict();
export const SuggestionsResponseSchema = z.object({
    enabled: z.boolean(),
    nights: z.record(RhythmIdSchema, RhythmNightsSchema),
    suggestions: z.array(RhythmSuggestionSchema),
    dismissed: z.array(DismissedSchema),
    log: z.array(NightLogSchema),
}).strict();
export const SuggestionsQuerySchema = z.object({ side: SideSchema }).strict();
const DismissRowSchema = z.object({ key: z.string().max(24), time: TimeSchema.nullable() }).strict();
export const SuggestionDismissSchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('later'), side: SideSchema, rhythmId: RhythmIdSchema }).strict(),
    z.object({
        scope: z.literal('plan'), side: SideSchema, rhythmId: RhythmIdSchema, rows: z.array(DismissRowSchema).min(1).max(MAX_SUGGESTIONS),
    }).strict(),
]);
export const SuggestionDismissResponseSchema = z.object({ ids: z.array(DismissIdSchema).min(1).max(MAX_SUGGESTIONS) }).strict();
export const SuggestionRestoreSchema = z.object({ side: SideSchema, ids: z.array(DismissIdSchema).min(1).max(MAX_SUGGESTIONS) }).strict();
export const NightExcludeSchema = z.object({
    side: SideSchema, rhythmId: RhythmIdSchema, date: IsoDateSchema, excluded: z.boolean(),
}).strict();
//# sourceMappingURL=rhythmsSchema.js.map