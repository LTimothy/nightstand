// When the two sides last swapped people, as epoch seconds. Sleep history
// stays on the side that recorded it; this log lets a request for "the person
// on this side" read their earlier nights from the other side.
import { readFileSync } from 'node:fs';
import logger from '../logger.js';
export const SIDE_SWAPS_FILE = 'side-swaps.json';
// config.dbFolder, read here so the metrics helpers load without config.
export const sideSwapsPath = () => `${process.env.DATA_FOLDER}${SIDE_SWAPS_FILE}`;
export function loadSideSwaps(path = sideSwapsPath()) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return [];
    }
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every(value => Number.isInteger(value)))
            return [...parsed].sort((a, b) => a - b);
    }
    catch {
        // Reported below.
    }
    logger.warn(`Ignoring ${path}: not a list of swap times`);
    return [];
}
let cached;
export const sideSwaps = () => (cached ??= loadSideSwaps());
export function setSideSwaps(swaps) {
    cached = [...swaps].sort((a, b) => a - b);
}
const other = (side) => (side === 'left' ? 'right' : 'left');
// A time equal to a swap counts as after it.
export function physicalSide(side, at, swaps = sideSwaps()) {
    return swaps.filter(swap => swap > at).length % 2 === 0 ? side : other(side);
}
// A Prisma filter for the rows of the person now on this side, by the given time column.
export function personWhere(side, column, swaps = sideSwaps()) {
    if (!side)
        return {};
    if (swaps.length === 0)
        return { side };
    const bounds = [undefined, ...swaps, undefined];
    return { OR: bounds.slice(1).map((to, index) => {
            const from = bounds[index];
            const range = { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lt: to }) };
            return { side: (swaps.length - index) % 2 === 0 ? side : other(side), [column]: range };
        }) };
}
//# sourceMappingURL=sideSwaps.js.map