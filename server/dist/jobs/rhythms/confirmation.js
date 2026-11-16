const MINUTE = 60_000;
export const CONFIRM_MS = 20 * MINUTE;
export const WINDOW_BEFORE_MS = 60 * MINUTE;
export const CAP_MS = 120 * MINUTE;
export const UP_EARLY_WINDOW_MS = 90 * MINUTE;
export const UP_EARLY_ABSENT_MS = 30 * MINUTE;
export const NOT_OBSERVED_GRACE_MS = 2 * MINUTE;
export const DROPOUT_MS = 3 * MINUTE;
const stamp = (value) => (value ? Date.parse(value) : Number.NaN);
const ceilMinute = (ms) => Math.ceil(ms / MINUTE) * MINUTE;
// Presence across the sides that count for a sleep. Unknown when no side has
// reported within staleMs. The run start is the side's last state change.
export function presenceRun(snapshot, sides, now, staleMs) {
    const fresh = sides.filter((side) => {
        const updated = stamp(snapshot[side]?.lastUpdatedAt);
        return Number.isFinite(updated) && now - updated <= staleMs;
    });
    if (fresh.length === 0)
        return { known: false, presentSince: null, absentSince: null };
    const since = (side) => {
        const changed = stamp(snapshot[side].stateChangedAt);
        return Number.isFinite(changed) ? changed : stamp(snapshot[side].lastUpdatedAt);
    };
    const present = fresh.filter(side => snapshot[side].present);
    if (present.length > 0) {
        return { known: true, presentSince: Math.min(...present.map(since)), absentSince: null };
    }
    return { known: true, presentSince: null, absentSince: Math.max(...fresh.map(since)) };
}
// Merges absences of DROPOUT_MS or less into the present run, so a sensor
// blip does not restart confirmation. Absence itself passes through.
export function bridgeDropouts(kept, run, now) {
    if (!run.known)
        return { run, kept: null };
    if (run.presentSince === null) {
        if (!kept)
            return { run, kept: null };
        // The first exit seen after the run ends it. A later one belongs to a
        // short entry that fell between two looks, which is not part of the run.
        const endedAt = kept.exitAt === null ? run.absentSince : kept.endedAt ?? null;
        return { run, kept: { ...kept, exitAt: run.absentSince, endedAt } };
    }
    const gap = kept ? run.presentSince - (kept.exitAt ?? kept.lastPresent) : Infinity;
    const since = kept && gap <= DROPOUT_MS ? Math.min(kept.since, run.presentSince) : run.presentSince;
    return { run: { ...run, presentSince: since }, kept: { since, lastPresent: now, exitAt: null } };
}
// Confirmation: 20 unbroken minutes of presence inside [bedtime - 60 min,
// bedtime + 2 h], counted from the window opening at the earliest. Presence
// is looked at once a minute, so a run that reached 20 minutes and ended
// before the next look still counts; kept, from bridgeDropouts, holds that
// run's start and end.
export function confirmationAt(run, bedtime, now, kept = null) {
    if (!run.known)
        return null;
    const endedAt = kept?.endedAt;
    let since;
    let until;
    if (run.presentSince !== null) {
        since = run.presentSince;
        until = now;
    }
    else if (kept && typeof endedAt === 'number' && Number.isFinite(endedAt)) {
        since = kept.since;
        until = Math.min(now, endedAt);
    }
    else {
        return null;
    }
    const opens = bedtime.getTime() - WINDOW_BEFORE_MS;
    const confirmedAt = Math.max(opens, since) + CONFIRM_MS;
    if (confirmedAt > until || confirmedAt > bedtime.getTime() + CAP_MS)
        return null;
    return confirmedAt;
}
// One step of the per-sleep start decision. Delay only: the cool-down never
// starts before bedtime. Once decided, the start is final for the night.
export function stepStart(state, args) {
    if (state.status === 'decided')
        return state;
    const { run, now, firstSight } = args;
    const bedtime = args.bedtime.getTime();
    const decided = (coolStart, confirmedAt, reason) => ({
        status: 'decided', coolStart: new Date(coolStart), confirmedAt: confirmedAt === null ? null : new Date(confirmedAt), reason,
    });
    if (now < bedtime - WINDOW_BEFORE_MS)
        return state;
    if (firstSight && now > bedtime + NOT_OBSERVED_GRACE_MS)
        return decided(bedtime, null, 'not-observed');
    const confirmedAt = confirmationAt(run, args.bedtime, now, args.kept ?? null);
    if (confirmedAt !== null)
        return decided(Math.max(bedtime, confirmedAt), confirmedAt, 'confirmed');
    if (now < bedtime)
        return { status: 'watching' };
    if (now >= bedtime + CAP_MS)
        return decided(bedtime + CAP_MS, null, 'cap');
    if (!run.known) {
        return state.status === 'waiting'
            ? decided(Math.max(bedtime, ceilMinute(now)), null, 'stale')
            : decided(bedtime, null, 'unknown');
    }
    return { status: 'waiting' };
}
// The cool-down start the resolver should use for this state.
export function coolStartOverride(state, bedtime) {
    if (state.status === 'decided')
        return state.coolStart;
    if (state.status === 'waiting')
        return new Date(bedtime.getTime() + CAP_MS);
    return undefined;
}
// Up early: 30 unbroken minutes of absence inside [wake - 90 min, wake].
export function upEarlyDue(run, wake, now) {
    if (!run.known || run.absentSince === null)
        return false;
    const opens = wake.getTime() - UP_EARLY_WINDOW_MS;
    if (now < opens || now > wake.getTime())
        return false;
    return now - Math.max(opens, run.absentSince) >= UP_EARLY_ABSENT_MS;
}
//# sourceMappingURL=confirmation.js.map