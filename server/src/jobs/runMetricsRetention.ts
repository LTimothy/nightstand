import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import config from '../config.js';
import settingsDB from '../db/settings.js';
import { prisma } from '../db/prisma.js';
import logger from '../logger.js';
import { parseDfOutput } from '../routes/storage/parseDiskUsage.js';
import { pruneMetrics, retentionCutoffs } from './metricsRetention.js';

const execFileAsync = promisify(execFile);
let running: Promise<void> | undefined;

async function run(now: Date): Promise<void> {
  try {
    await settingsDB.read();
    const features = settingsDB.data.features;
    if (!features.metricsRetention && !features.metricsLowDiskProtection) return;
    if (!existsSync(path.join(config.dbFolder, 'free-sleep.db'))) return;
    const readAvailableBytes = async () => {
      const { stdout } = await execFileAsync('df', ['-k', '-P', config.dbFolder], { timeout: 5000 });
      const disk = parseDfOutput(stdout);
      if (!disk || !Number.isFinite(disk.availableKb) || disk.availableKb < 0) {
        throw new Error('Could not read available storage for metrics retention');
      }
      return disk.availableKb * 1024;
    };
    const cutoffs = retentionCutoffs(now, await readAvailableBytes(), features, settingsDB.data.timeZone);
    const counts = await pruneMetrics(prisma, cutoffs, readAvailableBytes);
    logger.info(`Metrics retention: removed ${counts.vitals} detailed vitals rows and ${counts.movement} movement rows `
      + `in ${counts.batches} batches (${counts.stopped}). Freed SQLite pages are reusable; the database file is not smaller.`);
  } catch (error: unknown) {
    logger.error(`Metrics retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runMetricsRetention(now = new Date()): Promise<void> {
  if (!running) running = run(now).finally(() => { running = undefined; });
  return running;
}
