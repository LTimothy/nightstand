// Pure helpers for the log-listing/tailing route, split out so they're
// testable without spinning up Express/fs.watch.
import fs from 'fs';
import path from 'path';
export const isLogFilename = (name) => name.endsWith('.log');
// The tailing route joins this filename onto a fixed logs directory with no
// further sanitization, so a path-traversal or absolute-path value here
// (e.g. "../../etc/passwd") would read arbitrary files off the pod. Reject
// anything whose basename doesn't match itself, on top of the existing
// .log-suffix check.
export const isSafeLogFilename = (name) => isLogFilename(name) && name === path.basename(name);
// Splits a chunk of bytes freshly appended to a log file into whole lines.
// A trailing empty string from a chunk that ends exactly on a newline isn't
// a real line, so drop it. A trailing non-empty fragment (the writer hasn't
// finished the line yet) is kept; the next poll's chunk will complete it as
// a separate SSE message rather than being merged in, since these are tail
// reads on an actively-written file, not a buffered stream.
export const linesFromAppendedChunk = (chunk) => chunk.split('\n').filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
// The last maxLines whole lines of a read. A read that began partway through
// the file almost always starts mid-line, so that first fragment is dropped.
export const tailLines = (text, maxLines, startedMidFile) => {
    const lines = linesFromAppendedChunk(text);
    if (startedMidFile)
        lines.shift();
    return lines.slice(-maxLines);
};
// Reads at most the last maxBytes of a file by position, so the cost is the
// same for a 15MB rotated log as for a small one.
export async function readTail(filePath, maxBytes) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - maxBytes);
        const buffer = Buffer.alloc(size - start);
        await handle.read(buffer, 0, buffer.length, start);
        return { text: buffer.toString('utf8'), startedMidFile: start > 0, size };
    }
    finally {
        await handle.close();
    }
}
//# sourceMappingURL=logsHelpers.js.map