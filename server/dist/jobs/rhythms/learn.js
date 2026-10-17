// Turns one side's note lines and its saved rhythms into counts, suggestions
// and the notes log. Pure: no clock, no disk, no hashing.
import { z } from 'zod';
import { SideSchema, TemperatureSchema, TimeSchema } from '../../db/schedulesSchema.js';
import { CURVE_PHASES, InstantSchema, IsoDateSchema, RhythmIdSchema, } from '../../db/rhythmsSchema.js';
import { minutesAfterOn } from '../../db/rhythmWake.js';
import { levelToF } from '../../db/smartCurve.js';
import { COALESCE_MIN, MIN_NIGHTS, WINDOW_NIGHTS } from '../../db/suggestionRules.js';
const MINUTE = 60_000;
const ModeSchema = z.enum(['manual', 'smart']);
const PlanKeySchema = z.string().regex(/^[0-9a-f]{12}$/);
const NoteIdSchema = z.string().regex(/^[0-9a-f]{12}$/);
const sleepFields = {
    side: SideSchema, rhythmId: RhythmIdSchema, mode: ModeSchema, planKey: PlanKeySchema,
    date: IsoDateSchema, sleepStart: InstantSchema, sleepEnd: InstantSchema,
};
const ChangeLineSchema = z.object({
    v: z.literal(1), kind: z.literal('change'), at: InstantSchema, ...sleepFields,
    offsetMin: z.number().int().min(0), plannedF: TemperatureSchema, holdF: TemperatureSchema.nullable(),
    fromF: TemperatureSchema.nullable(), targetF: TemperatureSchema, phase: z.enum(CURVE_PHASES).nullable(),
    held: z.boolean(), source: z.enum(['api', 'tap']),
});
const NightLineSchema = z.object({ v: z.literal(1), kind: z.literal('night'), at: InstantSchema, ...sleepFields });
const DismissLineSchema = z.object({
    v: z.literal(1), kind: z.literal('dismiss'), id: NoteIdSchema, at: InstantSchema, side: SideSchema, rhythmId: RhythmIdSchema,
    planKey: PlanKeySchema, key: z.string().max(24).nullable(), time: TimeSchema.nullable(), scope: z.enum(['later', 'plan']),
});
const RestoreLineSchema = z.object({
    v: z.literal(1), kind: z.literal('restore'), at: InstantSchema, side: SideSchema, rhythmId: RhythmIdSchema,
    ids: z.array(NoteIdSchema).min(1),
});
const ExcludeLineSchema = z.object({
    v: z.literal(1), kind: z.literal('exclude'), at: InstantSchema, side: SideSchema, rhythmId: RhythmIdSchema,
    date: IsoDateSchema, excluded: z.boolean(),
});
const LineSchema = z.discriminatedUnion('kind', [ChangeLineSchema, NightLineSchema, DismissLineSchema, RestoreLineSchema, ExcludeLineSchema]);
export function parseLine(text) {
    try {
        const parsed = LineSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
export const isSleepLine = (line) => line.kind === 'change' || line.kind === 'night';
// One entry per date, with the latest end among its lines (a resume or a kept-on night moves it).
export function collapseNights(sleeps, excludes, now) {
    const byDate = new Map();
    for (const line of sleeps) {
        const sleepEnd = Date.parse(line.sleepEnd);
        const known = byDate.get(line.date);
        if (!known || sleepEnd > known.sleepEnd) {
            byDate.set(line.date, { date: line.date, sleepStart: Date.parse(line.sleepStart), sleepEnd, excluded: false });
        }
    }
    const latest = new Map();
    for (const line of [...excludes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))
        latest.set(line.date, line.excluded);
    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const ended = all.filter(night => night.sleepEnd <= now.getTime())
        .map(night => ({ ...night, excluded: latest.get(night.date) === true }));
    const counted = ended.filter(night => !night.excluded).slice(-WINDOW_NIGHTS);
    const since = counted.length === WINDOW_NIGHTS ? counted[0].date : '';
    const open = all.filter(night => night.sleepEnd > now.getTime());
    return {
        counted,
        excluded: ended.filter(night => night.excluded && night.date >= since),
        tonight: open[open.length - 1] ?? null,
    };
}
// One night's changes as episodes: anything within COALESCE_MIN of an
// episode's first change joins it. A press and undo nets to nothing and goes.
export function coalesceEpisodes(changes) {
    const episodes = [];
    let first;
    for (const line of [...changes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const current = episodes[episodes.length - 1];
        if (first && current && Date.parse(line.at) - Date.parse(first.at) <= COALESCE_MIN * MINUTE) {
            Object.assign(current, { targetF: line.targetF, phase: line.phase, held: line.held, source: line.source });
            continue;
        }
        first = line;
        episodes.push({
            date: line.date, at: line.at, offsetMin: line.offsetMin, from: line.fromF ?? line.plannedF, fromF: line.fromF,
            plannedF: line.plannedF, holdF: line.holdF, targetF: line.targetF, phase: line.phase, held: line.held, source: line.source,
        });
    }
    return episodes.filter(episode => episode.targetF !== episode.from);
}
// Everything the notes and the rules need for one rhythm, scoped to its current plan and mode.
export function rhythmEvidence(lines, { rhythm, planKey }, now) {
    const own = lines.filter(line => line.rhythmId === rhythm.id);
    const sleeps = own.filter(isSleepLine);
    const scoped = sleeps.filter(line => line.planKey === planKey && line.mode === rhythm.temperatureMode);
    const excludes = own.filter((line) => line.kind === 'exclude');
    const collapsed = collapseNights(scoped, excludes, now);
    const changes = scoped.filter((line) => line.kind === 'change');
    const episodes = new Map();
    for (const night of [...collapsed.counted, ...collapsed.excluded, ...(collapsed.tonight ? [collapsed.tonight] : [])]) {
        episodes.set(night.date, coalesceEpisodes(changes.filter(line => line.date === night.date)));
    }
    return { ...collapsed, earlier: sleeps.length > scoped.length, episodes };
}
function planSteps(rhythm, endMin) {
    if (rhythm.temperatureMode === 'smart')
        return [{ offsetMin: 0, temperatureF: levelToF(rhythm.smart.baseLevel) }];
    const { power, temperatures } = rhythm.night;
    const steps = Object.entries(temperatures)
        .map(([time, temperatureF]) => ({ offsetMin: minutesAfterOn(time, power.on), temperatureF }))
        .filter(step => step.offsetMin > 0 && step.offsetMin < endMin)
        .sort((a, b) => a.offsetMin - b.offsetMin);
    return [{ offsetMin: 0, temperatureF: power.onTemperature }, ...steps];
}
export function nightLogs(evidence, rhythm) {
    const entry = (night, tonight) => {
        const endMin = Math.max(1, Math.round((night.sleepEnd - night.sleepStart) / MINUTE));
        return {
            date: night.date, rhythmId: rhythm.id, tonight, excluded: night.excluded, plan: planSteps(rhythm, endMin), endMin,
            changes: (evidence.episodes.get(night.date) ?? [])
                .map(({ at, fromF, targetF, plannedF, held, source }) => ({ at, fromF, targetF, plannedF, held, source })),
        };
    };
    return [
        ...[...evidence.counted, ...evidence.excluded].map(night => entry(night, false)),
        ...(evidence.tonight ? [entry(evidence.tonight, true)] : []),
    ];
}
// Counts for the notes until the rules below decide more.
function notesSummary(evidence) {
    const counted = evidence.counted.length;
    const changed = evidence.counted.filter(night => (evidence.episodes.get(night.date) ?? []).length > 0).length;
    // Changed nights say nothing yet: the rules that tell a repeat from noise come next.
    const reason = counted < MIN_NIGHTS ? 'few-nights' : changed === 0 ? 'no-change' : 'suggested';
    return { counted, needed: MIN_NIGHTS, changed, earlier: evidence.earlier, reason };
}
export function learnSuggestions(lines, rhythms, now) {
    const nights = {};
    const log = [];
    for (const planned of rhythms) {
        const evidence = rhythmEvidence(lines, planned, now);
        nights[planned.rhythm.id] = notesSummary(evidence);
        log.push(...nightLogs(evidence, planned.rhythm));
    }
    log.sort((a, b) => b.date.localeCompare(a.date) || a.rhythmId.localeCompare(b.rhythmId));
    return { nights, suggestions: [], dismissed: [], log };
}
//# sourceMappingURL=learn.js.map