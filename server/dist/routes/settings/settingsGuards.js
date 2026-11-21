export const MAX_PAUSE_MS = 14 * 24 * 60 * 60 * 1000;
// Checks the pause each side would have after this update is merged, so a
// partial update is judged against the stored values it keeps. Resuming is
// always allowed.
export function pauseRejection(current, update, now) {
    for (const side of ['left', 'right']) {
        const change = update[side]?.scheduleOverrides?.pause;
        if (!change)
            continue;
        const pause = { ...current[side].scheduleOverrides.pause, ...change };
        if (!pause.active)
            continue;
        if (update[side]?.awayMode ?? current[side].awayMode) {
            return 'Turn off away mode before pausing this side\'s schedule';
        }
        if (!pause.expiresAt)
            continue;
        const end = Date.parse(pause.expiresAt);
        if (!(end > now.getTime()))
            return 'Choose a pause end time in the future';
        if (end - now.getTime() > MAX_PAUSE_MS)
            return 'A pause can end at most 14 days from now';
    }
    return null;
}
// Rhythms is turned on and off through its own routes, which hand a sleep in
// progress over. A plain settings write would skip that.
export function changesRhythmsFlag(current, update) {
    const requested = update.features?.rhythms;
    return requested !== undefined && requested !== current.features.rhythms;
}
//# sourceMappingURL=settingsGuards.js.map