import express, { Request, Response } from 'express';
import { legacyMovement } from '../../db/movement.js';
import { prisma } from '../../db/prisma.js';
import { personWhere } from '../../db/sideSwaps.js';
import { parseRowsQuery, ROWS_QUERY_ERROR } from './metricsQuery.js';

const router = express.Router();

router.get('/movement', async (req: Request, res: Response) => {
  const query = parseRowsQuery(req.query);
  if (!query) return res.status(400).json({ error: ROWS_QUERY_ERROR });

  const movementRecords = await prisma.movement.findMany({
    where: { ...personWhere(query.side, 'timestamp'), timestamp: { gte: query.start, lte: query.end } },
    orderBy: { timestamp: 'asc' },
  });

  // Epoch seconds, as stored, matching the vitals route.
  res.json(legacyMovement(movementRecords));
});

export default router;
