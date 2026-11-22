import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';
import moment from 'moment-timezone';
const dataFolder = mkdtempSync(path.join(tmpdir(), 'nightstand-cover-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let cover;
before(async () => {
    moment.tz.setDefault('UTC');
    cover = await import('./coverHealth.js');
});
// Synthetic RAW records only.
const T0 = Date.parse('2026-01-01T01:00:00Z');
const MIN = 60_000;
const REAL = [11.4, 11.3, 9.6, 9.7, 16.4, 16.6, 1.18, 1.19];
const NONE = Array(8).fill(-1);
let seq = 0;
const frame = (data) => cbor.encode({ seq: seq++, data });
const capRecord = (atMs, left, right) => frame(cbor.encode({
    type: 'capSense2', ts: atMs / 1000, version: 1, left: { values: left, status: 'good' }, right: { values: right, status: 'good' },
}));
const filler = () => frame(cbor.encode({ type: 'piezo-dual', ts: 0, left1: Buffer.alloc(4096, 7) }));
// Two records a second from `from` to `to`; `right` and `left` pick the values per record time.
function timeline(from, to, pick) {
    const parts = [];
    for (let at = from, i = 0; at <= to; at += 500, i++) {
        parts.push(capRecord(at, ...pick(at)));
        if (i % 20 === 0)
            parts.push(filler());
    }
    return Buffer.concat(parts);
}
function rawFile(bytes) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-cover-raw-'));
    const file = path.join(dir, '0001.RAW');
    writeFileSync(file, bytes);
    return file;
}
async function verdictOf(bytes, now, startedAt = T0) {
    const { format, samples } = await cover.readCapSamples(rawFile(bytes), bytes.length);
    const state = { ...cover.absorb(cover.newCoverState(startedAt), samples, now), format };
    return cover.judge(state, now);
}
const bothReal = () => [REAL, REAL];
describe('cover health', () => {
    it('is ok when both sides report for 20 minutes', async () => {
        const end = T0 + 20 * MIN;
        assert.deepEqual(await verdictOf(timeline(T0, end, bothReal), end), { kind: 'ok' });
    });
    it('finds a side silent for 10 minutes while the other reports, and not one second sooner', async () => {
        const lastReal = T0 + 5 * MIN;
        const pick = (at) => [REAL, at <= lastReal ? REAL : NONE];
        const end = lastReal + 10 * MIN;
        assert.deepEqual(await verdictOf(timeline(T0, end, pick), end), { kind: 'silent', side: 'right', since: lastReal });
        const early = lastReal + 10 * MIN - 1000;
        assert.deepEqual(await verdictOf(timeline(T0, early, pick), early), { kind: 'ok', stale: true });
    });
    it('stays ok through short placeholder runs and a minute with 11 percent of them', async () => {
        const end = T0 + 60 * MIN;
        const pick = (at) => {
            const offset = (at - T0) % (2 * MIN);
            const busyMinute = at >= T0 + 30 * MIN && at < T0 + 31 * MIN && (at / 500) % 9 === 0;
            return [busyMinute ? NONE : REAL, offset < 5000 ? NONE : REAL];
        };
        assert.deepEqual(await verdictOf(timeline(T0, end, pick), end), { kind: 'ok' });
    });
    it('counts a side with only some placeholder values as reporting', async () => {
        const end = T0 + 15 * MIN;
        const partial = [-1, -1, -1, -1, -1, -1, -1, 1.2];
        assert.deepEqual(await verdictOf(timeline(T0, end, () => [REAL, partial]), end), { kind: 'ok' });
    });
    it('finds both sides silent', async () => {
        const lastReal = T0 + MIN;
        const end = lastReal + 10 * MIN;
        const pick = (at) => (at <= lastReal ? [REAL, REAL] : [NONE, NONE]);
        assert.deepEqual(await verdictOf(timeline(T0, end, pick), end), { kind: 'bothSilent', since: lastReal });
    });
    it('waits the full 10 minutes from start when the side was never seen reporting', async () => {
        const startedAt = T0 + 30 * MIN;
        const pick = () => [REAL, NONE];
        const at9 = startedAt + 9 * MIN;
        assert.deepEqual(await verdictOf(timeline(startedAt - MIN, at9, pick), at9, startedAt), { kind: 'ok', stale: true });
        const at10 = startedAt + 10 * MIN;
        assert.deepEqual(await verdictOf(timeline(startedAt - MIN, at10, pick), at10, startedAt), { kind: 'silent', side: 'right', since: startedAt });
    });
    it('calls a 2 to 5 minute gap in the records ok but stale', async () => {
        const end = T0 + 10 * MIN;
        assert.deepEqual(await verdictOf(timeline(T0, end, bothReal), end + 3 * MIN), { kind: 'ok', stale: true });
    });
    it('waits for data when records stop for 5 minutes', async () => {
        const end = T0 + 10 * MIN;
        assert.deepEqual(await verdictOf(timeline(T0, end, bothReal), end + 5 * MIN), { kind: 'noRecords' });
    });
    it('does not apply to legacy capSense records, and shows no row for them', async () => {
        const channel = { out: 300, cen: 310, in: 320, status: 'good' };
        const legacy = Buffer.concat([0, 1, 2].map(i => frame(cbor.encode({
            type: 'capSense', ts: (T0 + i * 1000) / 1000, left: channel, right: channel,
        }))));
        const verdict = await verdictOf(legacy, T0 + 3000);
        assert.deepEqual(verdict, { kind: 'notApplicable' });
        assert.equal(cover.statusFor(verdict, null, T0), null);
    });
    it('recovers on the next judge once real readings return', async () => {
        const lastReal = T0 + MIN;
        const silentEnd = lastReal + 12 * MIN;
        const silent = timeline(T0, silentEnd, at => [REAL, at <= lastReal ? REAL : NONE]);
        const { samples: first } = await cover.readCapSamples(rawFile(silent), silent.length);
        let state = { ...cover.absorb(cover.newCoverState(T0), first, silentEnd), format: 'capSense2' };
        assert.equal(cover.judge(state, silentEnd).kind, 'silent');
        const back = timeline(silentEnd + 500, silentEnd + 30_000, bothReal);
        const { samples: second } = await cover.readCapSamples(rawFile(back), back.length);
        state = { ...cover.absorb(state, second, silentEnd + 30_000), format: 'capSense2' };
        assert.deepEqual(cover.judge(state, silentEnd + 30_000), { kind: 'ok' });
    });
    it('ignores samples stamped well in the future', () => {
        const state = cover.absorb(cover.newCoverState(T0), [{ at: T0 + 60_000, left: 'real', right: 'real' }], T0);
        assert.equal(state.left.lastSampleAt, null);
    });
    it('skips a record cut by the start of the tail and a corrupt byte run', async () => {
        const good = timeline(T0, T0 + 4500, bothReal);
        const bytes = Buffer.concat([Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 0xff, 0xff]), good]);
        const file = rawFile(bytes);
        const whole = await cover.readCapSamples(file, bytes.length);
        assert.equal(whole.samples.length, 10);
        // A tail that starts inside the first record loses that one only.
        const cut = await cover.readCapSamples(file, good.length - 10);
        assert.equal(cut.samples.length, 9);
        assert.equal(cut.format, 'capSense2');
    });
    it('words each state', () => {
        const since = Date.parse('2026-01-01T01:05:00Z');
        const silent = cover.statusFor({ kind: 'silent', side: 'right', since }, { available: true, note: '' }, since);
        assert.equal(silent?.status, 'failed');
        assert.equal(silent?.name, 'Cover sensors');
        assert.equal(silent?.message, 'The right side of the cover has sent no readings since 1:05 AM. '
            + 'Its buttons and bed sensors may not respond. Heating and cooling are not affected.');
        assert.deepEqual(silent?.coverRestore, { available: true, note: '' });
        const both = cover.statusFor({ kind: 'bothSilent', since }, null, since);
        assert.equal(both?.message, 'Neither side of the cover has sent readings since 1:05 AM. '
            + 'Check that the cover cable is plugged in at the hub, then restart the Pod.');
        assert.deepEqual(both?.coverRestore, { available: false, note: '' });
        const ok = cover.statusFor({ kind: 'ok' }, null, since);
        assert.equal(ok?.status, 'healthy');
        assert.equal(ok?.message, 'Both sides of the cover are reporting.');
        assert.equal(ok?.coverRestore, undefined);
        const waiting = cover.statusFor({ kind: 'noRecords' }, null, since);
        assert.equal(waiting?.status, 'waiting_for_data');
        assert.equal(waiting?.message, 'No cover readings in the last few minutes.');
    });
});
//# sourceMappingURL=coverHealth.test.js.map