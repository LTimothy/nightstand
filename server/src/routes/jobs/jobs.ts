import express, { Request, Response } from 'express';
import logger from '../../logger.js';
import { analyzeSleepKey, executeAnalyzeSleep } from '../../jobs/analyzeSleep.js';
import { calibrateSensorsKey, executeCalibrateSensors } from '../../jobs/calibrateSensors.js';
import { isPythonJobPending } from '../../jobs/executePython.js';
import moment from 'moment-timezone';
import { Job, JobKeyListSchema } from './jobsSchema.js';
import update from '../../jobs/update.js';
import { PrivilegedCommandError, privilegedErrorStatus } from '../../jobs/privilegedCommand.js';
import reboot from '../../jobs/reboot.js';
import { restoreCover } from '../../jobs/coverRestore.js';
import { refusedWhileInUse } from '../update/update.js';

const router = express.Router();


const analyzeSleepLeft = () => executeAnalyzeSleep(
  'left',
  moment().subtract(24, 'hours').toISOString(),
  moment().add(1, 'hours').toISOString()
);

const analyzeSleepRight = () => executeAnalyzeSleep(
  'right',
  moment().subtract(24, 'hours').toISOString(),
  moment().add(1, 'hours').toISOString()
);

// POST /jobs is user-initiated (Status page buttons), so calibration runs
// with force=true: the user is asserting the bed is empty, and the live
// presence detector can latch a false "present" that would block the
// occupancy guard indefinitely. Scheduled calibration (primeScheduler)
// keeps the guard.
const biometricsCalibrationLeft = () => executeCalibrateSensors(
  'left',
  moment().subtract(2, 'hours').toISOString(),
  moment().add(1, 'hours').toISOString(),
  true
);

const biometricsCalibrationRight = () => executeCalibrateSensors(
  'right',
  moment().subtract(2, 'hours').toISOString(),
  moment().add(1, 'hours').toISOString(),
  true
);


const JOB_MAP: Record<Job, () => void | Promise<void>> = {
  analyzeSleepLeft,
  analyzeSleepRight,
  biometricsCalibrationLeft,
  biometricsCalibrationRight,
  coverHealth: () => restoreCover('button'),
  reboot,
  update,
};


const QUEUED_JOB_KEYS: Partial<Record<Job, string>> = {
  analyzeSleepLeft: analyzeSleepKey('left'),
  analyzeSleepRight: analyzeSleepKey('right'),
  biometricsCalibrationLeft: calibrateSensorsKey('left'),
  biometricsCalibrationRight: calibrateSensorsKey('right'),
};


router.post('/jobs', async (req: Request, res: Response) => {
  const { body } = req;
  const validationResult = JobKeyListSchema.safeParse(body);

  if (!validationResult.success) {
    logger.error('Invalid jobs:', validationResult.error);
    res.status(400).json({
      error: 'Invalid request data',
      details: validationResult?.error?.errors,
    });
    return;
  }

  const jobs = [...new Set(validationResult.data)];
  if (jobs.includes('reboot') && jobs.includes('update')) {
    res.status(400).json({ message: 'Restart and update cannot be requested together' });
    return;
  }

  // Older pages and upstream's page start updates here. They cannot confirm.
  if (jobs.includes('update') && await refusedWhileInUse(res, undefined)) return;

  const busy = jobs.filter(job => {
    const key = QUEUED_JOB_KEYS[job];
    return key !== undefined && isPythonJobPending(key);
  });
  if (busy.length > 0) {
    res.status(409).json({ message: `Already queued or running: ${busy.join(', ')}` });
    return;
  }

  try {
    for (const job of jobs) {
      await JOB_MAP[job]();
    }
  } catch (error) {
    logger.error('Failed to start job', error);
    res.status(privilegedErrorStatus(error)).json({ message: error instanceof PrivilegedCommandError ? error.message : 'Unable to start job' });
    return;
  }

  res.status(204).end();
});


export default router;
