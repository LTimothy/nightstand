import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

export type MovementRow = { id: number; timestamp: number; side: string; total_movement: number };

// Movement is stored with fractions.
export async function loadMovement(
  side?: string, startUnix?: number, endUnix?: number, client: Pick<Prisma.TransactionClient, 'movement'> = prisma,
): Promise<MovementRow[]> {
  return client.movement.findMany({
    where: { side, timestamp: { gte: startUnix, lte: endUnix } },
    orderBy: { timestamp: 'asc' },
  });
}

// The /movement response and the current stage rules have always read whole
// numbers, so they keep doing so.
export function legacyMovement<T extends { total_movement: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, total_movement: Math.trunc(row.total_movement) }));
}
