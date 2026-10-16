import { prisma } from './prisma.js';
// Movement is stored with fractions.
export async function loadMovement(side, startUnix, endUnix, client = prisma) {
    return client.movement.findMany({
        where: { side, timestamp: { gte: startUnix, lte: endUnix } },
        orderBy: { timestamp: 'asc' },
    });
}
// The /movement response and the current stage rules have always read whole
// numbers, so they keep doing so.
export function legacyMovement(rows) {
    return rows.map((row) => ({ ...row, total_movement: Math.trunc(row.total_movement) }));
}
//# sourceMappingURL=movement.js.map