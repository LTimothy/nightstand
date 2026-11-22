// Watches the RAW capSense2 records for a cover side that stopped reporting.
import fsp from 'fs/promises';
import cbor from 'cbor';
import moment from 'moment-timezone';
import logger from '../logger.js';
import serverStatus from '../serverStatus.js';
import eventBus from '../events/eventBus.js';
import { RECORD_START, findNewestRawFile } from './rawFiles.js';
import { evaluateRestore } from '../jobs/coverRestore.js';
export const POLL_MS = 60_000;
// About 110 s of RAW at the Pod 5 record rate, so a minute's poll misses nothing.
export const TAIL_BYTES = 512 * 1024;
export const SILENT_MS = 10 * 60_000;
export const REPORTING_MS = 2 * 60_000;
export const NO_RECORDS_MS = 5 * 60_000;
export const NO_READING = -1;
const FUTURE_SLACK_MS = 5_000;
const CAP_TAG = Buffer.from('capSense');
const SIDES = ['left', 'right'];
const other = (side) => (side === 'left' ? 'right' : 'left');
// A side reads 'none' only when all eight values are the placeholder.
function sideReading(channel) {
    const values = channel?.values;
    if (!Array.isArray(values) || values.length === 0)
        return null;
    return values.every(value => value === NO_READING) ? 'none' : 'real';
}
// The capacitance records in the last `bytes` of a RAW file. A record cut by
// the start of the tail fails to decode and is skipped like a corrupt one.
export async function readCapSamples(file, bytes = TAIL_BYTES) {
    const handle = await fsp.open(file, 'r');
    let chunk;
    try {
        const { size } = await handle.stat();
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        chunk = buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
    let format = null;
    const samples = [];
    let cursor = 0;
    while (cursor < chunk.length) {
        const start = chunk.indexOf(RECORD_START, cursor);
        if (start < 0)
            break;
        cursor = start;
        let data;
        try {
            const { value, length } = cbor.decodeFirstSync(chunk.subarray(cursor), { extendedResults: true });
            cursor += length;
            data = value?.data;
        }
        catch {
            cursor += 1;
            continue;
        }
        if (!Buffer.isBuffer(data) || !data.includes(CAP_TAG))
            continue;
        let record;
        try {
            record = cbor.decodeFirstSync(data);
        }
        catch {
            continue;
        }
        if (record?.type === 'capSense') {
            format = 'capSense';
            continue;
        }
        if (record?.type !== 'capSense2' || typeof record.ts !== 'number' || !Number.isFinite(record.ts))
            continue;
        const left = sideReading(record.left);
        const right = sideReading(record.right);
        if (!left || !right)
            continue;
        format = 'capSense2';
        samples.push({ at: record.ts * 1000, left, right });
    }
    return { format, samples };
}
export function newCoverState(startedAt = Date.now()) {
    return { startedAt, left: { lastRealAt: null, lastSampleAt: null }, right: { lastRealAt: null, lastSampleAt: null }, format: null };
}
const later = (a, b) => (a === null || b > a ? b : a);
export function absorb(state, samples, now = Date.now()) {
    const next = { ...state, left: { ...state.left }, right: { ...state.right } };
    for (const sample of samples) {
        if (sample.at > now + FUTURE_SLACK_MS)
            continue;
        for (const side of SIDES) {
            next[side].lastSampleAt = later(next[side].lastSampleAt, sample.at);
            if (sample[side] === 'real')
                next[side].lastRealAt = later(next[side].lastRealAt, sample.at);
        }
    }
    return next;
}
export function judge(state, now) {
    if (state.format !== 'capSense2')
        return { kind: 'notApplicable' };
    const newest = Math.max(state.left.lastSampleAt ?? -Infinity, state.right.lastSampleAt ?? -Infinity);
    if (now - newest >= NO_RECORDS_MS)
        return { kind: 'noRecords' };
    if (now - newest > REPORTING_MS)
        return { kind: 'ok', stale: true };
    const since = (side) => state[side].lastRealAt ?? state.startedAt;
    const silent = (side) => now - since(side) >= SILENT_MS;
    const reporting = (side) => now - (state[side].lastRealAt ?? -Infinity) <= REPORTING_MS;
    if (silent('left') && silent('right'))
        return { kind: 'bothSilent', since: Math.max(since('left'), since('right')) };
    for (const side of SIDES) {
        if (silent(side) && reporting(other(side)))
            return { kind: 'silent', side, since: since(side) };
    }
    return reporting('left') && reporting('right') ? { kind: 'ok' } : { kind: 'ok', stale: true };
}
const NAME = 'Cover sensors';
const DESCRIPTION = 'Checks that both sides of the cover are sending readings';
const clock = (at) => moment(at).format('h:mm A');
export function statusFor(verdict, restore, now) {
    const base = { name: NAME, description: DESCRIPTION, timestamp: moment(now).format() };
    switch (verdict.kind) {
        case 'ok':
            return { ...base, status: 'healthy', message: 'Both sides of the cover are reporting.' };
        case 'silent':
            return {
                ...base, status: 'failed',
                message: `The ${verdict.side} side of the cover has sent no readings since ${clock(verdict.since)}. `
                    + 'Its buttons and bed sensors may not respond. Heating and cooling are not affected.',
                ...(restore ? { coverRestore: restore } : {}),
            };
        case 'bothSilent':
            return {
                ...base, status: 'failed',
                message: `Neither side of the cover has sent readings since ${clock(verdict.since)}. `
                    + 'Check that the cover cable is plugged in at the hub, then restart the Pod.',
                coverRestore: { available: false, note: '' },
            };
        case 'noRecords':
            return { ...base, status: 'waiting_for_data', message: 'No cover readings in the last few minutes.' };
        default:
            return null;
    }
}
let state = newCoverState();
let verdict = { kind: 'notApplicable' };
let timer = null;
let inFlight = false;
export const coverVerdict = () => verdict;
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
const describe = (v) => (v.kind === 'silent' ? `${v.side} side silent since ${clock(v.since)}` : v.kind);
async function poll() {
    if (inFlight)
        return;
    inFlight = true;
    try {
        const now = Date.now();
        const file = await findNewestRawFile();
        if (!file) {
            state = { ...state, format: null };
        }
        else {
            const read = await readCapSamples(file);
            state = absorb(state, read.samples, now);
            if (read.format)
                state.format = read.format;
        }
        const next = judge(state, now);
        if (describe(next) !== describe(verdict))
            logger.info(`[coverHealth] ${describe(verdict)} -> ${describe(next)}`);
        verdict = next;
        let restore = null;
        try {
            restore = await evaluateRestore(next);
        }
        catch (error) {
            logger.warn(`[coverHealth] restore check failed: ${errorMessage(error)}`);
        }
        const entry = statusFor(next, restore, now);
        const before = serverStatus.status.coverHealth;
        const changed = before?.status !== entry?.status || before?.message !== entry?.message
            || JSON.stringify(before?.coverRestore) !== JSON.stringify(entry?.coverRestore);
        if (entry)
            serverStatus.status.coverHealth = entry;
        else
            delete serverStatus.status.coverHealth;
        if (changed)
            eventBus.emit('service-health', entry ? { coverHealth: entry } : {});
    }
    catch (error) {
        logger.debug(`[coverHealth] poll failed: ${errorMessage(error)}`);
    }
    finally {
        inFlight = false;
    }
}
export function startCoverHealthMonitor() {
    if (timer)
        return;
    state = newCoverState();
    logger.info(`[coverHealth] starting (poll every ${POLL_MS} ms)`);
    void poll();
    timer = setInterval(() => { void poll(); }, POLL_MS);
    timer.unref?.();
}
export function stopCoverHealthMonitor() {
    if (timer)
        clearInterval(timer);
    timer = null;
}
//# sourceMappingURL=coverHealth.js.map