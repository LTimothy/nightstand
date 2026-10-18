import express, { Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import logger from '../../logger.js';
import config from '../../config.js';
import { parseDfOutput, parseDuOutput } from './parseDiskUsage.js';
import { parseFlashWear, FlashWear } from './parseFlashWear.js';
import { StorageInfo } from './storageSchema.js';

const router = express.Router();
const execFileAsync = promisify(execFile);

// The Node runtime on the pod (v16) predates fs.promises.statfs (added in
// v18.15/v19.6), so disk usage is read via `df`/`du` instead.
const DATA_DIR = config.dbFolder;
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RAW_ARCHIVE_DIR = path.join(DATA_DIR, 'raw-archive');
const DB_FILES = ['free-sleep.db', 'free-sleep.db-wal', 'free-sleep.db-shm'].map(
  (file) => path.join(DATA_DIR, file)
);

async function duKb(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir], { timeout: 5000 });
    return parseDuOutput(stdout);
  } catch {
    // Missing directory (e.g. biometrics never enabled) or a transient du
    // failure: either way, this is a "used 0 bytes" case, not an error.
    return 0;
  }
}

async function dbBytes(): Promise<number> {
  const sizes = await Promise.all(DB_FILES.map(async (file) => {
    try {
      const stat = await fs.promises.stat(file);
      return stat.size;
    } catch {
      return 0;
    }
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

const FLASH = '/sys/block/mmcblk0';

async function readFlash(): Promise<FlashWear | undefined> {
  try {
    const files = [`${FLASH}/device/life_time`, `${FLASH}/device/pre_eol_info`, `${FLASH}/stat`, '/proc/uptime'];
    const [lifeTime, preEol, stat, uptime] = await Promise.all(files.map(file => fs.promises.readFile(file, 'utf8')));
    return parseFlashWear(lifeTime, preEol, stat, uptime) ?? undefined;
  } catch {
    // No eMMC here, such as on a Mac in development.
    return undefined;
  }
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const { stdout: dfOutput } = await execFileAsync('df', ['-k', '-P', DATA_DIR], { timeout: 5000 });
    const df = parseDfOutput(dfOutput);
    if (!df) {
      throw new Error(`Unable to parse df output: ${dfOutput}`);
    }

    const [logsKb, archiveKb, databaseBytes, flash] = await Promise.all([
      duKb(LOGS_DIR),
      duKb(RAW_ARCHIVE_DIR),
      dbBytes(),
      readFlash(),
    ]);

    const info: StorageInfo = {
      mountPath: DATA_DIR,
      totalBytes: df.totalKb * 1024,
      usedBytes: df.usedKb * 1024,
      availableBytes: df.availableKb * 1024,
      usedPercent: Math.round((df.usedKb / df.totalKb) * 1000) / 10,
      breakdown: {
        logsBytes: logsKb * 1024,
        biometricsArchiveBytes: archiveKb * 1024,
        databaseBytes,
      },
      ...(flash ? { flash } : {}),
    };

    res.json(info);
  } catch (error) {
    logger.error('Failed to read storage usage', error);
    res.status(500).json({ message: 'Unable to read storage usage' });
  }
});

export default router;
