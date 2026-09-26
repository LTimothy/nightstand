import express from 'express';
import path from 'path';
import fs from 'fs';
import logger from '../../logger.js';
import { isLogFilename, isSafeLogFilename, linesFromAppendedChunk, readTail, tailLines } from './logsHelpers.js';
const router = express.Router();
const LOGS_DIRS = ['/persistent/free-sleep-data/logs', '/var/log'];
const TAIL_LINES = 1000;
// Comfortably holds TAIL_LINES of the longest lines these logs carry.
const TAIL_BYTES = 512 * 1024;
const { promises: fsPromises } = fs;
// Endpoint to list all log files as clickable links
router.get('/', async (req, res) => {
    try {
        const logFilesPerDir = await Promise.all(LOGS_DIRS.map(async (dir) => {
            try {
                await fsPromises.access(dir, fs.constants.R_OK);
            }
            catch {
                return [];
            }
            let files;
            try {
                files = await fsPromises.readdir(dir);
            }
            catch (error) {
                logger.error(`Error reading logs from ${dir}:`, error);
                return [];
            }
            const fileStats = await Promise.all(files.map(async (file) => {
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
                }
                catch (error) {
                    logger.warn(`Skipping invalid file: ${fullPath}`);
                    return null;
                }
            }));
            return fileStats.filter((fileStat) => fileStat !== null);
        }));
        const allLogFiles = logFilesPerDir.flat().sort((a, b) => b.mtime - a.mtime);
        res.json({
            logs: allLogFiles.map(log => log.name),
        });
    }
    catch (error) {
        logger.error('Unexpected error while listing log files', error);
        res.status(500).json({ message: 'Unable to list log files' });
    }
});
router.get('/:filename', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
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
        }
        catch {
            continue;
        }
    }
    if (!logFilePath) {
        res.write(`data: ${JSON.stringify({ message: 'Log file not found' })}\n\n`);
        return res.end();
    }
    let lastSize = 0;
    // Only the tail is shown, so only the tail is read. The whole of a 15MB
    // rotated log used to be read before anything was sent, and on a busy pod
    // that kept the browser waiting long enough to give up.
    let logBuffer = [];
    try {
        const tail = await readTail(logFilePath, TAIL_BYTES);
        logBuffer = tailLines(tail.text, TAIL_LINES, tail.startedMidFile);
        lastSize = tail.size;
    }
    catch {
        // File may have rotated out from under us after access(); fs.watch below
        // will still pick up the replacement.
    }
    res.write(`data: ${JSON.stringify({ message: logBuffer.join('\n') })}\n\n`);
    // fs.watch's `interval` option only applies to fs.watchFile, not fs.watch;
    // passing it here was silently ignored, so every raw write to a busy log
    // (several times a second for the streaming log) re-read the whole file
    // and re-sent up to 1000 lines over SSE. Two fixes: debounce watch events,
    // and read only the bytes appended since the last read instead of the
    // whole file.
    let debounceTimer;
    let reading = false;
    let pendingReread = false;
    const readNewBytes = async () => {
        if (reading) {
            pendingReread = true;
            return;
        }
        reading = true;
        try {
            const stat = await fsPromises.stat(logFilePath);
            if (stat.size < lastSize) {
                // Log rotated (truncated or swapped), so reset to the new file's start.
                lastSize = 0;
            }
            if (stat.size === lastSize)
                return;
            const chunkStream = fs.createReadStream(logFilePath, {
                encoding: 'utf8',
                start: lastSize,
            });
            let appended = '';
            for await (const chunk of chunkStream)
                appended += chunk;
            lastSize = stat.size;
            const newLines = linesFromAppendedChunk(appended);
            if (newLines.length > 0) {
                res.write(`data: ${JSON.stringify({ message: newLines.join('\n') })}\n\n`);
            }
        }
        catch (error) {
            logger.debug(`Log tail read failed for ${logFilePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            reading = false;
            if (pendingReread) {
                pendingReread = false;
                void readNewBytes();
            }
        }
    };
    const logStream = fs.watch(logFilePath, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => void readNewBytes(), 300);
    });
    req.on('close', () => {
        clearTimeout(debounceTimer);
        logStream.close();
        res.end();
    });
});
export default router;
//# sourceMappingURL=logs.js.map