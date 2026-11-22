import { z } from 'zod';

export const JobSchema = z.enum([
  'analyzeSleepLeft',
  'analyzeSleepRight',
  'biometricsCalibrationLeft',
  'biometricsCalibrationRight',
  'coverHealth',
  'reboot',
  'update',
]);
export type Job = z.infer<typeof JobSchema>;


// Schema for a list (array) of valid job keys
export const JobKeyListSchema = z.array(JobSchema);

export type Jobs = z.infer<typeof JobKeyListSchema>
