// Turns one side's note lines and its saved rhythms into counts, suggestions
// and the notes log. Pure: no clock, no disk, no hashing.
import { z } from 'zod';
import { MAX_TEMPERATURES_PER_DAY, SideSchema, TemperatureSchema, TimeSchema } from '../../db/schedulesSchema.js';
import { CURVE_PHASES, InstantSchema, IsoDateSchema, RhythmIdSchema, } from '../../db/rhythmsSchema.js';
import { minutesAfterOn, nightMinutes, temperatureInPowerWindow } from '../../db/rhythmWake.js';
import { F_PER_LEVEL, levelToF } from '../../db/smartCurve.js';
import { BASE_STEP, CLUSTER_MIN, COALESCE_MIN, HIDE_SHARE, MAX_SUGGESTIONS, MIN_NIGHTS, MIN_SHARE, NEAR_MIN_NIGHTS, NEAR_MIN_SUPPORT, NEAR_SHARE, NOTE_DAYS, ON_WINDOW_MIN, REPLACE_MIN, SNOOZE_NIGHTS, TIME_ROUND_MIN, WINDOW_NIGHTS, } from '../../db/suggestionRules.js';
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
// What the scheduler wrote; null is a power-off. The reason is free text so a later release may add one.
const SetLineSchema = z.object({
    v: z.literal(1), kind: z.literal('set'), at: InstantSchema, side: SideSchema, rhythmId: RhythmIdSchema, planKey: PlanKeySchema,
    date: IsoDateSchema, targetF: TemperatureSchema.nullable(), reason: z.string().max(16),
});
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
const LineSchema = z.discriminatedUnion('kind', [
    ChangeLineSchema, NightLineSchema, DismissLineSchema, RestoreLineSchema, ExcludeLineSchema, SetLineSchema,
]);
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
function indexNights(sleeps, excludes) {
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
    return { all, latest };
}
function windowAt({ all, latest }, now) {
    const ended = all.filter(night => night.sleepEnd <= now.getTime())
        .map(night => ({ ...night, excluded: latest.get(night.date) === true }));
    const kept = ended.filter(night => !night.excluded);
    const counted = kept.slice(-WINDOW_NIGHTS);
    const since = counted.length === WINDOW_NIGHTS ? counted[0].date : '';
    const open = all.filter(night => night.sleepEnd > now.getTime());
    return {
        counted,
        excluded: ended.filter(night => night.excluded && night.date >= since),
        tonight: open[open.length - 1] ?? null,
        ended: kept,
    };
}
export const collapseNights = (sleeps, excludes, now) => windowAt(indexNights(sleeps, excludes), now);
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
function rhythmScope(lines, { rhythm, planKey }) {
    const own = lines.filter(line => line.rhythmId === rhythm.id);
    const sleeps = own.filter(isSleepLine);
    const scoped = sleeps.filter(line => line.planKey === planKey && line.mode === rhythm.temperatureMode);
    const changes = new Map();
    for (const line of scoped)
        if (line.kind === 'change')
            changes.set(line.date, [...(changes.get(line.date) ?? []), line]);
    return {
        nights: indexNights(scoped, own.filter((line) => line.kind === 'exclude')),
        byDate: new Map([...changes].map(([date, dated]) => [date, coalesceEpisodes(dated)])),
        earlier: sleeps.length > scoped.length,
    };
}
function evidenceAt(scope, now) {
    const collapsed = windowAt(scope.nights, now);
    const episodes = new Map();
    for (const night of [...collapsed.counted, ...collapsed.excluded, ...(collapsed.tonight ? [collapsed.tonight] : [])]) {
        episodes.set(night.date, scope.byDate.get(night.date) ?? []);
    }
    return { ...collapsed, earlier: scope.earlier, episodes };
}
// Everything the notes and the rules need for one rhythm, scoped to its current plan and mode.
export const rhythmEvidence = (lines, planned, now) => evidenceAt(rhythmScope(lines, planned), now);
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
// Every night of one rhythm id under any plan or mode, newest first, each by the latest end written for its date,
// and on a tie by the line under the current plan and mode (a plan edited mid-night without moving the wake time).
function recordedNights(own, { rhythm, planKey }) {
    const current = (line) => line.planKey === planKey && line.mode === rhythm.temperatureMode;
    const byDate = new Map();
    for (const line of own) {
        if (!isSleepLine(line))
            continue;
        const end = Date.parse(line.sleepEnd);
        const known = byDate.get(line.date);
        if (!known || end > known.end || (end === known.end && !current(known) && current(line))) {
            byDate.set(line.date, { date: line.date, start: Date.parse(line.sleepStart), end, planKey: line.planKey, mode: line.mode });
        }
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}
// One rhythm's log: the nights the rules see (counted, left out, tonight) and the last WINDOW_NIGHTS ended nights
// under any plan, which its card draws. Only a night under the saved plan and mode carries the plan's steps.
export function nightLog(own, planned, evidence, now) {
    const { rhythm, planKey } = planned;
    const nights = recordedNights(own, planned);
    const recent = nights.filter(night => night.end <= now.getTime()).slice(0, WINDOW_NIGHTS);
    const seen = new Set([...evidence.counted, ...evidence.excluded, ...(evidence.tonight ? [evidence.tonight] : [])].map(night => night.date));
    const leftOut = new Map();
    const excludes = own.filter((line) => line.kind === 'exclude');
    for (const line of excludes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)))
        leftOut.set(line.date, line.excluded);
    return nights.filter(night => seen.has(night.date) || recent.includes(night)).map((night) => {
        const tonight = night.end > now.getTime();
        const endMin = Math.max(1, Math.round((night.end - night.start) / MINUTE));
        const samePlan = night.planKey === planKey && night.mode === rhythm.temperatureMode;
        const dated = own.filter(line => 'date' in line && line.date === night.date);
        const sets = dated.filter((line) => line.kind === 'set')
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .slice(0, 2 * MAX_TEMPERATURES_PER_DAY)
            .map(line => ({ at: line.at, temperatureF: line.targetF }));
        return {
            date: night.date, rhythmId: rhythm.id, tonight, excluded: !tonight && leftOut.get(night.date) === true,
            plan: samePlan ? planSteps(rhythm, endMin) : [], endMin,
            changes: coalesceEpisodes(dated.filter((line) => line.kind === 'change'))
                .map(({ at, fromF, targetF, plannedF, held, source }) => ({ at, fromF, targetF, plannedF, held, source })),
            start: new Date(night.start).toISOString(), samePlan, ...(sets.length ? { sets } : {}),
        };
    });
}
const directionOf = (change) => (change < 0 ? 'down' : 'up');
export function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
// A night's vote in a cluster is its net change there, timed at its first change in it.
function nightVotes(episodes) {
    const byNight = new Map();
    for (const episode of episodes)
        byNight.set(episode.date, [...(byNight.get(episode.date) ?? []), episode]);
    return [...byNight].flatMap(([date, list]) => {
        const ordered = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const first = ordered[0];
        const last = ordered[ordered.length - 1];
        const net = last.targetF - first.from;
        return net === 0 ? [] : [{ date, direction: directionOf(net), value: last.targetF, offset: first.offsetMin, from: first.from }];
    });
}
// Takes the CLUSTER_MIN window holding the most nights (the earliest on a tie) as one cluster, until none are left.
export function clusterEpisodes(episodes) {
    let remaining = [...episodes].sort((a, b) => a.offsetMin - b.offsetMin || Date.parse(a.at) - Date.parse(b.at));
    const clusters = [];
    while (remaining.length) {
        let best = [];
        let bestNights = 0;
        for (const start of remaining) {
            const window = remaining.filter(episode => episode.offsetMin >= start.offsetMin && episode.offsetMin <= start.offsetMin + CLUSTER_MIN);
            const nights = new Set(window.map(episode => episode.date)).size;
            if (nights > bestNights) {
                best = window;
                bestNights = nights;
            }
        }
        remaining = remaining.filter(episode => !best.includes(episode));
        clusters.push({ votes: nightVotes(best) });
    }
    return clusters;
}
// The direction most nights took; a tie has none.
export function majority(votes) {
    const down = votes.filter(vote => vote.direction === 'down');
    const up = votes.filter(vote => vote.direction === 'up');
    if (down.length === up.length)
        return null;
    return down.length > up.length ? { direction: 'down', supporting: down } : { direction: 'up', supporting: up };
}
const needed = (share, of) => Math.ceil(share * of);
const isShown = (shown, key, at) => shown.some(entry => entry.key === key && (entry.at === null || at === null || Math.abs(entry.at - at) <= CLUSTER_MIN));
const minuteOfDay = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clockOf = (minute) => {
    const wrapped = ((minute % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
};
// The value a night's plan has `offset` minutes after the power-on.
function planValueAt(night, offset, steps = night.temperatures, onF = night.power.onTemperature) {
    let value = onF;
    let latest = -1;
    for (const [time, temperatureF] of Object.entries(steps)) {
        if (!temperatureInPowerWindow(time, night.power))
            continue;
        const at = minutesAfterOn(time, night.power.on);
        if (at <= offset && at > latest) {
            latest = at;
            value = temperatureF;
        }
    }
    return value;
}
// A half-degree middle value goes to the plan's side: the smaller change.
const towardPlan = (value, plan) => {
    if (Number.isInteger(value))
        return value;
    return Math.abs(Math.floor(value) - plan) <= Math.abs(Math.ceil(value) - plan) ? Math.floor(value) : Math.ceil(value);
};
// The rounded clock time, kept strictly inside the night when a mark fits there, and snapped
// onto a saved step close to it. Only the saved night is looked at.
export function suggestedTime(night, offset) {
    const on = minuteOfDay(night.power.on);
    const length = nightMinutes(night.power);
    const first = Math.floor(on / TIME_ROUND_MIN) * TIME_ROUND_MIN + TIME_ROUND_MIN;
    const last = Math.ceil((on + length) / TIME_ROUND_MIN) * TIME_ROUND_MIN - TIME_ROUND_MIN;
    const rounded = Math.round((on + offset) / TIME_ROUND_MIN) * TIME_ROUND_MIN;
    // A habit that rounds onto an end of the night moves to the nearest mark inside it.
    const nearEnd = offset > 0 && offset < length + TIME_ROUND_MIN / 2;
    const time = clockOf(nearEnd && first <= last ? Math.min(last, Math.max(first, rounded)) : rounded);
    const at = minutesAfterOn(time, night.power.on);
    const [near] = Object.keys(night.temperatures)
        .filter(key => temperatureInPowerWindow(key, night.power))
        .map(key => ({ key, after: minutesAfterOn(key, night.power.on) }))
        .filter(step => Math.abs(step.after - at) <= REPLACE_MIN)
        .sort((a, b) => Math.abs(a.after - at) - Math.abs(b.after - at) || a.after - b.after);
    return near ? { time: near.key, replaces: near.key } : { time };
}
function candidatesOf(night, clusters) {
    const candidates = [];
    for (const cluster of clusters) {
        const top = majority(cluster.votes);
        if (!top)
            continue;
        const offset = median(top.supporting.map(vote => vote.offset));
        if (offset < ON_WINDOW_MIN) {
            candidates.push({ ...top, offset, at: 0, kind: 'on' });
            continue;
        }
        const { time, replaces } = suggestedTime(night, offset);
        candidates.push({ ...top, offset, at: minutesAfterOn(time, night.power.on), kind: 'step', time, ...(replaces ? { replaces } : {}) });
    }
    return candidates.sort((a, b) => a.at - b.at || a.offset - b.offset);
}
function evidenceOf(direction, key, supporting) {
    const dates = supporting.map(vote => vote.date).sort();
    return { key, direction, supporting: dates.length, firstNight: dates[0], lastNight: dates[dates.length - 1], supportingDates: dates };
}
// The editor's own limits: strictly inside the night, and no new step past the cap.
const refused = (night, steps, time) => !temperatureInPowerWindow(time, night.power) || (!Object.hasOwn(steps, time) && Object.keys(steps).length >= MAX_TEMPERATURES_PER_DAY);
// Places the clusters in night order against a working copy of the saved night, so each row is an absolute write.
export function placeManual(rhythm, clusters, counted, gate) {
    const { night } = rhythm;
    const steps = { ...night.temperatures };
    let onF = night.power.onTemperature;
    const rows = [];
    const stages = clusters.filter(cluster => cluster.votes.length > 0 && !majority(cluster.votes)).map(() => 'inconsistent');
    let last;
    for (const candidate of candidatesOf(night, clusters)) {
        const saved = candidate.kind === 'on' ? night.power.onTemperature : planValueAt(night, candidate.at);
        const temperatureF = towardPlan(median(candidate.supporting.map(vote => vote.value)), saved);
        const working = candidate.kind === 'on' ? onF : planValueAt(night, candidate.at, steps, onF);
        if (temperatureF === saved && median(candidate.supporting.map(vote => vote.from)) === planValueAt(night, candidate.offset)) {
            stages.push('too-small');
            continue;
        }
        if (temperatureF === saved) {
            // A return rides on the row before it, gated among the nights that made that change.
            const parent = last?.row;
            if (!last || !parent || parent.kind === 'base' || candidate.kind === 'on')
                continue;
            const both = candidate.supporting.filter(vote => parent.supportingDates.includes(vote.date)).length;
            const share = gate.kind === 'full' && isShown(gate.shown, `back:${parent.key}`, candidate.at) ? HIDE_SHARE : MIN_SHARE;
            if (both < needed(share, parent.supporting) || refused(night, steps, candidate.time))
                continue;
            parent.thenBack = {
                time: candidate.time, temperatureF: saved, supporting: both, ...(candidate.replaces ? { replaces: candidate.replaces } : {}),
            };
            last.backAt = candidate.at;
            steps[candidate.time] = saved;
            continue;
        }
        if (temperatureF === working) {
            stages.push('too-small');
            continue;
        }
        const key = `${candidate.kind}:${candidate.direction}`;
        const floor = gate.kind === 'near' ? gate.floor
            : needed(isShown(gate.shown, key, candidate.kind === 'step' ? candidate.at : null) ? HIDE_SHARE : MIN_SHARE, counted);
        if (candidate.supporting.length < floor) {
            stages.push('inconsistent');
            continue;
        }
        if (candidate.kind === 'step' && refused(night, steps, candidate.time)) {
            stages.push('refused');
            continue;
        }
        const evidence = evidenceOf(candidate.direction, key, candidate.supporting);
        let row;
        if (candidate.kind === 'on') {
            row = { kind: 'on', ...evidence, temperatureF, plannedF: saved };
            onF = temperatureF;
        }
        else {
            row = {
                kind: 'step', ...evidence, time: candidate.time, temperatureF, plannedF: saved,
                ...(candidate.replaces ? { replaces: candidate.replaces } : {}),
            };
            steps[candidate.time] = temperatureF;
        }
        last = { row, at: candidate.at };
        rows.push(last);
    }
    return { rows, stages };
}
const halfAway = (value) => Math.sign(value) * Math.round(Math.abs(value));
// A Smart rhythm learns only its base: from changes at the night level, or cooler during the cool-down.
export function placeSmart(rhythm, evidence, gate) {
    const votes = [];
    let seen = false;
    for (const night of evidence.counted) {
        const deltas = [];
        for (const episode of evidence.episodes.get(night.date) ?? []) {
            if ((episode.phase !== 'cooldown' && episode.phase !== 'hold') || episode.holdF === null)
                continue;
            seen = true;
            if (episode.phase === 'cooldown' && episode.targetF >= episode.holdF)
                continue;
            deltas.push(halfAway((episode.targetF - episode.holdF) / F_PER_LEVEL));
        }
        const delta = deltas.length ? halfAway(median(deltas)) : 0;
        if (delta !== 0)
            votes.push({ date: night.date, direction: directionOf(delta), value: delta, offset: 0, from: 0 });
    }
    if (!seen)
        return { rows: [], stages: ['no-change'], changed: 0 };
    if (!votes.length)
        return { rows: [], stages: ['too-small'], changed: 0 };
    const counted = evidence.counted.length;
    const top = majority(votes);
    const key = top ? `base:${top.direction}` : '';
    const floor = gate.kind === 'near' ? gate.floor : needed(isShown(gate.shown, key, null) ? HIDE_SHARE : MIN_SHARE, counted);
    if (!top || (gate.kind === 'full' && counted < MIN_NIGHTS) || top.supporting.length < floor) {
        return { rows: [], stages: ['inconsistent'], changed: votes.length };
    }
    const current = rhythm.smart.baseLevel;
    const baseLevel = Math.max(-10, Math.min(10, current + (top.direction === 'down' ? -BASE_STEP : BASE_STEP)));
    if (baseLevel === current)
        return { rows: [], stages: ['too-small'], changed: votes.length };
    const row = { kind: 'base', ...evidenceOf(top.direction, key, top.supporting), baseLevel, currentBaseLevel: current };
    return { rows: [{ row, at: 0 }], stages: [], changed: votes.length };
}
function analyse(scope, planned, at, gate) {
    const evidence = evidenceAt(scope, at);
    if (planned.rhythm.temperatureMode === 'smart')
        return placeSmart(planned.rhythm, evidence, gate);
    const episodes = evidence.counted.flatMap(night => evidence.episodes.get(night.date) ?? []);
    if (!episodes.length)
        return { rows: [], stages: ['no-change'], changed: 0 };
    const clusters = clusterEpisodes(episodes);
    const changed = new Set(clusters.flatMap(cluster => cluster.votes.map(vote => vote.date))).size;
    const counted = evidence.counted.length;
    if (gate.kind === 'full' && counted < MIN_NIGHTS)
        return { rows: [], stages: [], changed };
    // Changes that every night undid: they match the plan.
    if (changed === 0)
        return { rows: [], stages: ['too-small'], changed };
    return { ...placeManual(planned.rhythm, clusters, counted, gate), changed };
}
const shownOf = (rows) => rows.flatMap(placed => [
    { key: placed.row.key, at: placed.row.kind === 'step' ? placed.at : null },
    ...(placed.backAt === undefined ? [] : [{ key: `back:${placed.row.key}`, at: placed.backAt }]),
]);
// What is on show is never stored: every ended night of the plan is replayed in order, each on
// its own window, and carries what showed after it, so a row stays until support falls below HIDE_SHARE.
function replay(scope, planned, now) {
    const { ended } = evidenceAt(scope, now);
    if (!ended.length)
        return analyse(scope, planned, now, { kind: 'full', shown: [] });
    let shown = [];
    let result = { rows: [], stages: [], changed: 0 };
    for (const night of ended) {
        result = analyse(scope, planned, new Date(night.sleepEnd), { kind: 'full', shown });
        shown = shownOf(result.rows);
    }
    return result;
}
const STAGE_ORDER = ['no-change', 'inconsistent', 'too-small', 'refused', 'dismissed', 'suggested'];
function reasonOf(counted, full, showing) {
    if (counted < MIN_NIGHTS)
        return 'few-nights';
    if (showing > 0)
        return 'suggested';
    if (full.rows.length > 0)
        return 'dismissed';
    return full.stages.reduce((best, stage) => (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(best) ? stage : best), full.stages[0] ?? 'inconsistent');
}
const DAY = 24 * 60 * 60 * 1000;
const byNightOrder = (a, b) => a.at - b.at;
// Every ended night of a rhythm id, under any plan or mode, by its latest end.
function nightEnds(lines, rhythmId, now) {
    const byDate = new Map();
    for (const line of lines) {
        if (isSleepLine(line) && line.rhythmId === rhythmId) {
            byDate.set(line.date, Math.max(byDate.get(line.date) ?? 0, Date.parse(line.sleepEnd)));
        }
    }
    return [...byDate.values()].filter(end => end <= now.getTime());
}
// Unrestored hides of a rhythm: per plan under its current key, and "for 14 nights" until that many nights have ended.
function hiddenFor(lines, { rhythm, planKey }, now) {
    const restored = new Set(lines.flatMap(line => (line.kind === 'restore' ? line.ids : [])));
    const own = lines.filter((line) => line.kind === 'dismiss' && line.rhythmId === rhythm.id && !restored.has(line.id));
    const ends = nightEnds(lines, rhythm.id, now);
    return {
        plan: own.filter(line => line.scope === 'plan' && line.planKey === planKey),
        later: own.filter(line => line.scope === 'later')
            .map(line => ({ line, nightsLeft: SNOOZE_NIGHTS - ends.filter(end => end > Date.parse(line.at)).length }))
            // The notes prune night lines at NOTE_DAYS but keep the hide, so a rare rhythm could never count 14.
            .filter(entry => entry.nightsLeft > 0 && Date.parse(entry.line.at) >= now.getTime() - NOTE_DAYS * DAY),
    };
}
// A per-plan hide matches the kind and direction, and for a step a time within CLUSTER_MIN, both after the power-on.
const visible = (rows, hidden, on) => (hidden.later.length ? [] : rows.filter(placed => !hidden.plan.some(line => line.key === placed.row.key && (placed.row.kind !== 'step'
    || (line.time !== null && Math.abs(minutesAfterOn(line.time, on) - placed.at) <= CLUSTER_MIN)))));
const dismissedOf = (rhythmId, hidden) => [
    ...hidden.plan.map(line => ({ id: line.id, rhythmId, key: line.key, time: line.time, scope: 'plan', nightsLeft: 0 })),
    ...hidden.later.map(({ line, nightsLeft }) => ({ id: line.id, rhythmId, key: null, time: null, scope: 'later', nightsLeft })),
];
export function learnSuggestions(lines, rhythms, now) {
    const learned = { nights: {}, suggestions: [], dismissed: [], log: [] };
    for (const planned of rhythms) {
        const { rhythm } = planned;
        const scope = rhythmScope(lines, planned);
        const evidence = evidenceAt(scope, now);
        const counted = evidence.counted.length;
        const full = replay(scope, planned, now);
        const hidden = hiddenFor(lines, planned, now);
        const rows = visible(full.rows, hidden, rhythm.night.power.on).sort(byNightOrder).slice(0, MAX_SUGGESTIONS);
        const nights = {
            counted, needed: MIN_NIGHTS, changed: full.changed, earlier: evidence.earlier, reason: reasonOf(counted, full, rows.length),
        };
        learned.nights[rhythm.id] = nights;
        if (rows.length) {
            learned.suggestions.push({ rhythmId: rhythm.id, near: false, rows: rows.map(placed => placed.row) });
        }
        else if (counted >= NEAR_MIN_NIGHTS && !hidden.later.length) {
            // The leading pattern below the gate, computed fresh from the floor each time.
            const floor = Math.max(NEAR_MIN_SUPPORT, needed(NEAR_SHARE, counted));
            const [near] = visible(analyse(scope, planned, now, { kind: 'near', floor }).rows, hidden, rhythm.night.power.on)
                .sort((a, b) => b.row.supporting - a.row.supporting || a.at - b.at);
            if (near)
                learned.suggestions.push({ rhythmId: rhythm.id, near: true, rows: [near.row] });
        }
        learned.dismissed.push(...dismissedOf(rhythm.id, hidden));
        learned.log.push(...nightLog(lines.filter(line => line.rhythmId === rhythm.id), planned, evidence, now));
    }
    learned.log.sort((a, b) => b.date.localeCompare(a.date) || a.rhythmId.localeCompare(b.rhythmId));
    return learned;
}
//# sourceMappingURL=learn.js.map