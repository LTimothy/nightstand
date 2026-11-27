// Before this file is read, so a side swap a power cut interrupted is finished first.
import './sideSwapReplay.js';
// Stores Rhythms in /persistent/free-sleep-data/lowdb/rhythmsDB.json. The file
// exists only once Rhythms has been turned on, and nothing here deletes it.
import { Low } from 'lowdb';
import { TextFile } from 'lowdb/node';
import config from '../config.js';
import { createSerializedUpdate } from './serializedUpdate.js';
import { syncToFlash } from './durableFile.js';
import { responseSchema } from './responseSchema.js';
import { RHYTHMS_FILE_VERSION, RhythmsDBSchema } from './rhythmsSchema.js';
export class RhythmsStateError extends Error {
    state;
    constructor(state, message = `Rhythms data is ${state}`) {
        super(message);
        this.name = 'RhythmsStateError';
        this.state = state;
    }
}
// Stored data is read with unknown keys stripped; only writes are strict.
const RhythmsReadSchema = responseSchema(RhythmsDBSchema);
export function parseRhythms(text) {
    if (text === null)
        return { state: 'absent' };
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        return { state: 'invalid', error: error instanceof Error ? error.message : String(error) };
    }
    const version = raw !== null && typeof raw === 'object' ? raw.version : undefined;
    if (typeof version === 'number' && version > RHYTHMS_FILE_VERSION)
        return { state: 'unsupported', version };
    const parsed = RhythmsReadSchema.safeParse(raw);
    if (!parsed.success) {
        return { state: 'invalid', error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    }
    return { state: 'ok', db: parsed.data };
}
const RHYTHMS_PATH = `${config.lowDbFolder}rhythmsDB.json`;
class RhythmsFile {
    #file = new TextFile(RHYTHMS_PATH);
    async read() {
        return { text: await this.#file.read() };
    }
    async write(data) {
        if (data.text === null)
            throw new Error('Refusing to remove rhythmsDB.json');
        await this.#file.write(data.text);
        await syncToFlash(RHYTHMS_PATH);
    }
}
const rhythmsFile = new Low(new RhythmsFile(), { text: null });
const serializedUpdate = createSerializedUpdate(rhythmsFile);
const serialize = (db) => JSON.stringify(db, null, 2);
export async function loadRhythms() {
    await rhythmsFile.read();
    return parseRhythms(rhythmsFile.data.text);
}
// The draft is the stored JSON, so keys this version does not know survive.
export async function updateRhythms(mutate) {
    const saved = await serializedUpdate(file => {
        const load = parseRhythms(file.text);
        if (load.state !== 'ok')
            throw new RhythmsStateError(load.state);
        const draft = JSON.parse(file.text);
        const result = mutate(draft);
        // An async change could land after the save, so it is refused outright.
        if (typeof result?.then === 'function') {
            Promise.resolve(result).catch(() => { });
            throw new Error('Rhythms changes must be synchronous');
        }
        if (result === false)
            return false;
        const checked = RhythmsReadSchema.safeParse(draft);
        if (!checked.success)
            throw new Error(`Refusing to save invalid rhythms: ${checked.error.message}`);
        file.text = serialize(draft);
    });
    const load = parseRhythms(saved.text);
    if (load.state !== 'ok')
        throw new RhythmsStateError(load.state);
    return load.db;
}
export async function createRhythms(db) {
    const valid = RhythmsDBSchema.parse(db);
    await serializedUpdate(file => {
        if (file.text !== null)
            throw new RhythmsStateError(parseRhythms(file.text).state, 'rhythmsDB.json already exists');
        file.text = serialize(valid);
    });
}
//# sourceMappingURL=rhythms.js.map