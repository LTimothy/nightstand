import fsp from 'fs/promises';
import path from 'path';
// Where the firmware writes its rolling RAW captures. Tests point it elsewhere.
export const RAW_DIR = process.env.POD_RAW_DIR || '/persistent';
export const RECORD_START = Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71]);
// The newest *.RAW by modification time. SEQNO.RAW is the firmware's
// sequence counter, not a capture.
export async function findNewestRawFile(dir = RAW_DIR) {
    let entries;
    try {
        entries = await fsp.readdir(dir);
    }
    catch {
        return null;
    }
    let newest = null;
    let newestMtime = -Infinity;
    for (const name of entries) {
        if (!name.endsWith('.RAW') || name === 'SEQNO.RAW')
            continue;
        const full = path.join(dir, name);
        try {
            const stats = await fsp.stat(full);
            if (!stats.isFile())
                continue;
            if (stats.mtimeMs > newestMtime) {
                newestMtime = stats.mtimeMs;
                newest = full;
            }
        }
        catch {
            // Rolled away between readdir and stat.
        }
    }
    return newest;
}
//# sourceMappingURL=rawFiles.js.map