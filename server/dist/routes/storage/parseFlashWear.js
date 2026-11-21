const KEEP_SECONDS = 3600;
const MIN_SPAN_SECONDS = 1800;
const level = (text, max) => {
    const value = text ? Number.parseInt(text, 16) : Number.NaN;
    return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
};
export function parseWriteSample(stat, uptime) {
    const sectors = Number(stat.trim().split(/\s+/)[6]);
    const seconds = Number(uptime.trim().split(/\s+/)[0]);
    return Number.isFinite(sectors) && Number.isFinite(seconds) && stat.trim() && uptime.trim() ? { seconds, sectors } : null;
}
// Keeps about the last hour. A counter or clock that went back (a new boot) starts over.
export function addWriteSample(samples, sample) {
    const last = samples[samples.length - 1];
    const kept = last && (sample.seconds <= last.seconds || sample.sectors < last.sectors) ? [] : [...samples];
    kept.push(sample);
    while (kept.length > 1 && sample.seconds - kept[0].seconds > KEEP_SECONDS)
        kept.shift();
    return kept;
}
// A recent rate, not an average since boot: an update or deploy writes about a gigabyte once,
// and a since-boot average spread that over the rest of the day.
export function recentWriteRate(samples, now) {
    const oldest = samples[0];
    if (!oldest || now.sectors < oldest.sectors)
        return null;
    const span = now.seconds - oldest.seconds;
    if (span < MIN_SPAN_SECONDS)
        return null;
    return { bytesPerDay: Math.round((now.sectors - oldest.sectors) * 512 / span * 86400), overSeconds: Math.round(span) };
}
export function parseFlashWear(lifeTime, preEol, rate) {
    const [a, b] = lifeTime.trim().split(/\s+/);
    const wear = {
        lifeTimeA: level(a, 11),
        lifeTimeB: level(b, 11),
        preEolInfo: level(preEol.trim(), 3),
        writtenBytesPerDay: rate?.bytesPerDay ?? null,
        writtenOverSeconds: rate?.overSeconds ?? null,
    };
    return Object.values(wear).every(value => value === null) ? null : wear;
}
//# sourceMappingURL=parseFlashWear.js.map