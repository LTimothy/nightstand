import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Adapter } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import logger from '../logger.js';

type Sync = (path: string) => Promise<void>;

const fsyncPath: Sync = async path => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// A save that has returned should survive a power cut, whatever the journal commit interval.
export async function syncToFlash(file: string, sync: Sync = fsyncPath): Promise<void> {
  try {
    await sync(file);
    await sync(dirname(file));
  } catch (error) {
    logger.warn(`Could not sync ${file} to flash: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// JSONFile with a sync after each write; steno's write queue and temp file rename stay as they are.
export class DurableJSONFile<T> implements Adapter<T> {
  readonly #path: string;
  readonly #file: JSONFile<T>;
  readonly #sync: Sync;

  constructor(path: string, sync: Sync = fsyncPath) {
    this.#path = path;
    this.#file = new JSONFile<T>(path);
    this.#sync = sync;
  }

  read(): Promise<T | null> {
    return this.#file.read();
  }

  async write(data: T): Promise<void> {
    await this.#file.write(data);
    await syncToFlash(this.#path, this.#sync);
  }
}
