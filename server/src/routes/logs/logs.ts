import express from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../../logger.js';
import { isLogFilename, isSafeLogFilename, linesFromAppendedChunk, readTail, tailLines } from './logsHelpers.js';

const router = express.Router();

// Root's operation logs come first: releases before they moved left copies
// with the same names in the server's folder.
const LOGS_DIRS = ['/persistent/nightstand-logs', '/persistent/free-sleep-data/logs', '/var/log'];
const TAIL_LINES = 1000;
// Comfortably holds TAIL_LINES of the longest lines these logs carry.
const TAIL_BYTES = 512 * 1024;

const { promises: fsPromises } = fs;

type LogFile = {
  name: string;
  path: string;
  mtime: number;
};

// Endpoint to list all log files as clickable links
router.get('/', async (req, res) => {
  try {
    const logFilesPerDir = await Promise.all(
      LOGS_DIRS.map(async (dir) => {
        try {
          await fsPromises.access(dir, fs.constants.R_OK);
        } catch {
          return [] as LogFile[];
        }

        let files: string[];
        try {
          files = await fsPromises.readdir(dir);
        } catch (error) {
          logger.error(`Error reading logs from ${dir}:`, error);
          return [] as LogFile[];
        }

        const fileStats = await Promise.all(
          files.map(async (file): Promise<LogFile | null> => {
            // Was `endsWith('log')`, which also matched non-log files like
            // "catalog" or "backlog" if they ever showed up in these dirs.
            if (!isLogFilename(file)) {
              return null;
            }

            const fullPath = path.join(dir, file);

            try {
              const stat = await fsPromises.lstat(fullPath);
              if (!stat.isFile()) {
                return null;
              }

              return { name: file, path: fullPath, mtime: stat.mtime.getTime() };
            } catch (error) {
              logger.warn(`Skipping invalid file: ${fullPath}`);
              return null;
            }
          })
        );

        return fileStats.filter((fileStat): fileStat is LogFile => fileStat !== null);
      })
    );

    const allLogFiles = logFilesPerDir.flat().sort((a, b) => b.mtime - a.mtime);

    res.json({
      logs: [...new Set(allLogFiles.map(log => log.name))],
    });
  } catch (error) {
    logger.error('Unexpected error while listing log files', error);
    res.status(500).json({ message: 'Unable to list log files' });
  }
});


router.get('/:filename', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Registered before the first await: a client that hangs up while the file
  // is being found or read would otherwise miss the close event and leave
  // the watcher below open until the server restarts.
  let closed = false;
  let logStream: fs.FSWatcher | undefined;
  let chunkStream: fs.ReadStream | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  res.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    logStream?.close();
    chunkStream?.destroy();
  });
  const gone = () => closed || res.destroyed || res.writableEnded;

  const filename = req.params.filename;

  if (!isSafeLogFilename(filename)) {
    res.write(`data: ${JSON.stringify({ message: 'Log file not found' })}\n\n`);
    return res.end();
  }

  let logFilePath = null;
  for (const dir of LOGS_DIRS) {
    const fullPath = path.join(dir, filename);
    try {
      await fsPromises.access(fullPath, fs.constants.R_OK);
      logFilePath = fullPath;
      break;
    } catch {
      continue;
    }
  }
  if (gone()) return;

  if (!logFilePath) {
    res.write(`data: ${JSON.stringify({ message: 'Log file not found' })}\n\n`);
    return res.end();
  }

  let lastSize = 0;
  // Only the tail is shown, so only the tail is read. The whole of a 15MB
  // rotated log used to be read before anything was sent, and on a busy pod
  // that kept the browser waiting long enough to give up.
  let logBuffer: string[] = [];
  try {
    const tail = await readTail(logFilePath, TAIL_BYTES);
    logBuffer = tailLines(tail.text, TAIL_LINES, tail.startedMidFile);
    lastSize = tail.size;
  } catch {
    // File may have rotated out from under us after access(); fs.watch below
    // will still pick up the replacement.
  }
  if (gone()) return;

  res.write(`data: ${JSON.stringify({ message: logBuffer.join('\n') })}\n\n`);

  // fs.watch's `interval` option only applies to fs.watchFile, not fs.watch;
  // passing it here was silently ignored, so every raw write to a busy log
  // (several times a second for the streaming log) re-read the whole file
  // and re-sent up to 1000 lines over SSE. Two fixes: debounce watch events,
  // and read only the bytes appended since the last read instead of the
  // whole file.
  let reading = false;
  let pendingReread = false;

  const readNewBytes = async () => {
    if (gone()) return;
    if (reading) {
      pendingReread = true;
      return;
    }
    reading = true;
    try {
      const stat = await fsPromises.stat(logFilePath as string);
      if (stat.size < lastSize) {
        // Log rotated (truncated or swapped), so reset to the new file's start.
        lastSize = 0;
      }
      if (stat.size === lastSize || gone()) return;

      chunkStream = fs.createReadStream(logFilePath as string, {
        encoding: 'utf8',
        start: lastSize,
      });
      let appended = '';
      for await (const chunk of chunkStream) appended += chunk;
      chunkStream = undefined;
      lastSize = stat.size;

      const newLines = linesFromAppendedChunk(appended);
      if (newLines.length > 0 && !gone()) {
        res.write(`data: ${JSON.stringify({ message: newLines.join('\n') })}\n\n`);
      }
    } catch (error) {
      logger.debug(`Log tail read failed for ${logFilePath}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      chunkStream = undefined;
      reading = false;
      if (pendingReread) {
        pendingReread = false;
        void readNewBytes();
      }
    }
  };

  try {
    logStream = fs.watch(logFilePath, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void readNewBytes(), 300);
    });
  } catch (error) {
    logger.debug(`Log watch failed for ${logFilePath}: ${error instanceof Error ? error.message : String(error)}`);
    return res.end();
  }
  // A watcher's own error would otherwise be thrown as an uncaught exception.
  logStream.on('error', () => res.end());
});

export default router;
