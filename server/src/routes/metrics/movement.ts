import express, { Request, Response } from 'express';
import { legacyMovement, loadPersonMovement } from '../../db/movement.js';
import { parseRowsQuery, ROWS_QUERY_ERROR } from './metricsQuery.js';

const router = express.Router();

router.get('/movement', async (req: Request, res: Response) => {
  const query = parseRowsQuery(req.query);
  if (!query) return res.status(400).json({ error: ROWS_QUERY_ERROR });

  const movementRecords = await loadPersonMovement(query.side, query.start, query.end);

  // Epoch seconds, as stored, matching the vitals route.
  res.json(legacyMovement(movementRecords));
});

export default router;
