const level = (text, max) => {
    const value = text ? Number.parseInt(text, 16) : Number.NaN;
    return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
};
export function parseFlashWear(lifeTime, preEol, stat, uptime) {
    const [a, b] = lifeTime.trim().split(/\s+/);
    const sectors = Number(stat.trim().split(/\s+/)[6]);
    const seconds = Number(uptime.trim().split(/\s+/)[0]);
    const wear = {
        lifeTimeA: level(a, 11),
        lifeTimeB: level(b, 11),
        preEolInfo: level(preEol.trim(), 3),
        // Under an hour after boot the average says little.
        writtenBytesPerDay: Number.isFinite(sectors) && seconds >= 3600 ? Math.round(sectors * 512 / seconds * 86400) : null,
    };
    return Object.values(wear).every(value => value === null) ? null : wear;
}
//# sourceMappingURL=parseFlashWear.js.map