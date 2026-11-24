import express from 'express';
import { otherSlotSupported } from '../../jobs/otherSlot.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  res.json({ supported: await otherSlotSupported() });
});

export default router;
