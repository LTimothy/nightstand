// Applies cover temperature clicks only when the firmware logged them as ignored.
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import cbor from 'cbor';
import moment from 'moment-timezone';
import { DeepPartial } from 'ts-essentials';

import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import serverStatus from '../serverStatus.js';
import eventBus from '../events/eventBus.js';
import { Side } from '../db/schedulesSchema.js';
import { DeviceStatus, MIN_TEMPERATURE_F, MAX_TEMPERATURE_F } from '../routes/deviceStatus/deviceStatusSchema.js';
import { connectFrankenWithin } from './frankenServer.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { markManualTempChange } from '../jobs/scheduleOverride.js';
import { ButtonEventMachine, ButtonEvent, ButtonName } from './buttonEvents.js';

// Where the firmware writes its rolling RAW captures. Tests point it elsewhere.
const RAW_DIR = process.env.POD_RAW_DIR || '/persistent';
const POLL_MS = 1_000;
// Avoid decoding large sensor chunks that happen to contain a matching tag.
const MAX_TAGGED_CHUNK_BYTES = 16 * 1024;
// Bound reads and incomplete records independently.
const MAX_READ_CHUNK = 1 << 20;
const MAX_CARRY_BYTES = 64 * 1024;
const RECORD_START = Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71]);
// Firmware batching can delay log records by 15 to 25 s.
const MAX_PRESS_AGE_MS = 30_000;
// A RAW file older than this is not being written: the firmware has stopped,
// or writes to a stream instead.
const STALE_RAW_MS = 15_000;

interface TailState {
  file: string;
  offset: number;
  // Bytes of a record cut off at the end of the last read, read again first.
  carry: Buffer;
}

// Include result lines even when they arrive in a separate chunk from the press.
const TAG_KEYPAD = Buffer.from('[tca8418');
const TAG_TTC = Buffer.from('[TTC]');
const TAG_THERMOSTAT = Buffer.from('[thermostat]');
function hasButtonTag(data: Buffer): boolean {
  return data.includes(TAG_KEYPAD) || data.includes(TAG_TTC) || data.includes(TAG_THERMOSTAT);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ButtonMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private tail: TailState | null = null;
  private firstPoll = true;
  private startedAt = Date.now();
  private machine = new ButtonEventMachine();
  // A press this poll could not apply, reported instead of a healthy status.
  private pollError: string | null = null;

  public start(): void {
    if (this.timer) {
      logger.warn('[buttonMonitor] already running');
      return;
    }
    logger.info(`[buttonMonitor] starting (poll every ${POLL_MS} ms)`);
    this.markStatus('started');
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private markStatus(status: 'healthy' | 'failed' | 'started', message = ''): void {
    const entry = serverStatus.status.buttonMonitor;
    const changed = entry.status !== status || entry.message !== message;
    entry.status = status;
    entry.message = message;
    entry.timestamp = moment.tz().format();
    if (changed) eventBus.emit('service-health', { buttonMonitor: entry });
  }

  // One poll. It never throws or rejects into the interval.
  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.pollError = null;
    try {
      await settingsDB.read();
      if (!settingsDB.data.features.coverButtons) {
        this.tail = null;
        this.machine = new ButtonEventMachine();
        this.firstPoll = true;
        this.markStatus('healthy', 'Off in Settings > Features');
        return;
      }

      const newest = await this.findNewestRawFile();
      const firstPoll = this.firstPoll;
      if (firstPoll) this.startedAt = Date.now();
      this.firstPoll = false;
      if (!newest) {
        this.markStatus('failed', `No RAW files in ${RAW_DIR}`);
        return;
      }

      // Skip existing history at startup, but drain the old file on rotation.
      if (!this.tail || this.tail.file !== newest) {
        if (this.tail) {
          const end = await fsp.stat(this.tail.file).then(stats => stats.size, () => 0);
          let bytesRead: number;
          do {
            bytesRead = await this.readAppended(end);
          } while (bytesRead > 0 && this.tail && this.tail.offset < end);
        }
        logger.debug(`[buttonMonitor] tailing ${newest}`);
        const offset = firstPoll ? (await fsp.stat(newest)).size : 0;
        this.tail = { file: newest, offset, carry: Buffer.alloc(0) };
      }

      await this.readAppended();
      const age = Date.now() - (await fsp.stat(newest)).mtimeMs;
      if (age < 0 || age > STALE_RAW_MS) {
        this.markStatus('failed', 'The RAW file is not being written');
      } else if (this.pollError) {
        this.markStatus('failed', this.pollError);
      } else {
        this.markStatus('healthy');
      }
    } catch (error) {
      this.markStatus('failed', errorMessage(error));
      logger.warn(`[buttonMonitor] poll failed: ${errorMessage(error)}`);
    } finally {
      this.inFlight = false;
    }
  }

  // The newest *.RAW by modification time. SEQNO.RAW is the firmware's
  // sequence counter, not a capture.
  private async findNewestRawFile(): Promise<string | null> {
    let entries: string[];
    try {
      entries = await fsp.readdir(RAW_DIR);
    } catch {
      return null;
    }
    let newest: string | null = null;
    let newestMtime = -Infinity;
    for (const name of entries) {
      if (!name.endsWith('.RAW') || name === 'SEQNO.RAW') continue;
      const full = path.join(RAW_DIR, name);
      try {
        const stats = await fsp.stat(full);
        if (!stats.isFile()) continue;
        if (stats.mtimeMs > newestMtime) {
          newestMtime = stats.mtimeMs;
          newest = full;
        }
      } catch {
        // Rolled away between readdir and stat.
      }
    }
    return newest;
  }

  // Reads the bytes appended since the last poll, parses the log records out
  // of them and acts on the button events.
  private async readAppended(end?: number): Promise<number> {
    const tail = this.tail;
    if (!tail) return 0;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(tail.file);
    } catch {
      this.tail = null;
      return 0;
    }

    // Shorter than before: replaced under the same name, so read it from the start.
    if (stats.size < tail.offset) {
      tail.offset = 0;
      tail.carry = Buffer.alloc(0);
    }

    const available = Math.min(stats.size, end ?? stats.size) - tail.offset;
    if (available <= 0) return 0;

    const toRead = Math.min(available, MAX_READ_CHUNK);
    const buffer = Buffer.alloc(toRead);
    let bytesRead = 0;
    const handle = await fsp.open(tail.file, 'r');
    try {
      ({ bytesRead } = await handle.read(buffer, 0, toRead, tail.offset));
    } finally {
      await handle.close();
    }
    if (bytesRead <= 0) return 0;

    const chunk = tail.carry.length
      ? Buffer.concat([tail.carry, buffer.subarray(0, bytesRead)])
      : buffer.subarray(0, bytesRead);
    tail.carry = Buffer.alloc(0);

    const events: ButtonEvent[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      const start = chunk.indexOf(RECORD_START, cursor);
      if (start < 0) {
        tail.carry = Buffer.from(chunk.subarray(Math.max(cursor, chunk.length - 4)));
        break;
      }
      cursor = start;
      try {
        const { value, length } = cbor.decodeFirstSync(chunk.subarray(cursor), { extendedResults: true });
        cursor += length;
        const data: unknown = value?.data;
        if (Buffer.isBuffer(data)) events.push(...this.eventsIn(data));
      } catch (error) {
        if (errorMessage(error) === 'Insufficient data' && chunk.length - cursor <= MAX_CARRY_BYTES) {
          tail.carry = Buffer.from(chunk.subarray(cursor));
          break;
        }
        // Oversized incomplete records cannot hold the reader at a corrupt length.
        cursor += 1;
      }
    }

    // The file offset moves past everything read; what was not consumed is
    // in the carry and is read again from there, never from the file.
    tail.offset += bytesRead;

    for (const event of events) {
      await this.dispatch(event);
    }
    return bytesRead;
  }

  // The button events in one inner chunk, which holds several concatenated
  // CBOR maps, most of them unrelated log lines.
  private eventsIn(data: Buffer): ButtonEvent[] {
    if (data.length === 0 || data.length > MAX_TAGGED_CHUNK_BYTES) return [];
    if (!hasButtonTag(data)) return [];
    let items: unknown[];
    try {
      items = cbor.decodeAllSync(data);
    } catch {
      // decodeAllSync gives up on the first bad item; keep what the first
      // item holds rather than lose a press to a corrupt neighbour.
      try {
        items = [cbor.decodeFirstSync(data)];
      } catch {
        return [];
      }
    }
    const events: ButtonEvent[] = [];
    const now = Date.now();
    for (const decoded of items) {
      if (!decoded || typeof decoded !== 'object') continue;
      const record = decoded as { type?: unknown; msg?: unknown; ts?: unknown };
      if (record.type !== 'log' || typeof record.msg !== 'string') continue;
      if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) continue;
      const at = record.ts * 1000;
      if (at < this.startedAt || at > now + 1000 || now - at > MAX_PRESS_AGE_MS) continue;
      events.push(...this.machine.push(record.msg, at));
    }
    return events;
  }

  private async dispatch(event: ButtonEvent): Promise<void> {
    try {
      await settingsDB.read();
      if (!settingsDB.data.features.coverButtons || Date.now() - event.at > MAX_PRESS_AGE_MS) return;
      const side: Side = event.side;
      await this.step(side, event.button === 'top' ? 1 : -1, event.button, event.at);
    } catch (error) {
      logger.warn(`[buttonMonitor] ${event.side} ${event.button} ${event.kind} failed: ${errorMessage(error)}`);
      this.pollError = errorMessage(error);
    }
  }

  private async step(side: Side, deltaF: number, button: ButtonName, at: number): Promise<void> {
    const status = await (await connectFrankenWithin()).getDeviceStatus();
    const readTarget = status[side]?.targetTemperatureF;
    if (typeof readTarget !== 'number' || !Number.isFinite(readTarget)) {
      throw new Error(`no target for the ${side} side`);
    }
    if (Date.now() - at > MAX_PRESS_AGE_MS) return;

    const targetF = Math.max(MIN_TEMPERATURE_F, Math.min(MAX_TEMPERATURE_F, readTarget + deltaF));
    logger.info(`[buttonMonitor] ${side} ${button} button: ${readTarget} -> ${targetF} F`);
    await updateDeviceStatus({ [side]: { targetTemperatureF: targetF } } as DeepPartial<DeviceStatus>, { notAfter: at + MAX_PRESS_AGE_MS });
    // A press counts as a manual change for the schedule override, as a tap does.
    await markManualTempChange(side);
  }
}

let monitor: ButtonMonitor | null = null;

export function startButtonMonitor(): void {
  if (!monitor) monitor = new ButtonMonitor();
  monitor.start();
}

export function stopButtonMonitor(): void {
  monitor?.stop();
}
