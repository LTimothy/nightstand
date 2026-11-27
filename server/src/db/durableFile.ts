import { open, rename, rm, writeFile } from 'node:fs/promises';
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

// Whole-file replace through a temporary file, synced; null removes the file.
export async function writeTextDurably(path: string, text: string | null, sync: Sync = fsyncPath): Promise<void> {
  if (text === null) {
    await rm(path, { force: true });
  } else {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await sync(temporary);
    await rename(temporary, path);
  }
  try {
    await sync(dirname(path));
  } catch (error) {
    logger.warn(`Could not sync ${dirname(path)} to flash: ${error instanceof Error ? error.message : String(error)}`);
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
