import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { JSONFile } from 'lowdb/node';
import logger from '../logger.js';
const fsyncPath = async (path) => {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
};
// A save that has returned should survive a power cut, whatever the journal commit interval.
export async function syncToFlash(file, sync = fsyncPath) {
    try {
        await sync(file);
        await sync(dirname(file));
    }
    catch (error) {
        logger.warn(`Could not sync ${file} to flash: ${error instanceof Error ? error.message : String(error)}`);
    }
}
// JSONFile with a sync after each write; steno's write queue and temp file rename stay as they are.
export class DurableJSONFile {
    #path;
    #file;
    #sync;
    constructor(path, sync = fsyncPath) {
        this.#path = path;
        this.#file = new JSONFile(path);
        this.#sync = sync;
    }
    read() {
        return this.#file.read();
    }
    async write(data) {
        await this.#file.write(data);
        await syncToFlash(this.#path, this.#sync);
    }
}
//# sourceMappingURL=durableFile.js.map