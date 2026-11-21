import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addWriteSample, parseFlashWear, parseWriteSample, recentWriteRate } from './parseFlashWear.js';
// Values from our Pod: life_time 0x01 0x01, pre_eol 0x01, and the
// whole-chip stat line 23689 s after boot (1906248 sectors written).
const STAT = '   15243     2788  1138212    13753   148097    45686  1906248   841874        0   136880   899670\n';
describe('parseFlashWear', () => {
    it('reads the wear levels and passes the recent rate through', () => {
        assert.deepEqual(parseFlashWear('0x01 0x01\n', '0x01\n', { bytesPerDay: 1_430_000_000, overSeconds: 3600 }), {
            lifeTimeA: 1, lifeTimeB: 1, preEolInfo: 1, writtenBytesPerDay: 1_430_000_000, writtenOverSeconds: 3600,
        });
    });
    it('treats 0x00 as not given and leaves the rate out while measuring', () => {
        assert.deepEqual(parseFlashWear('0x00 0x02', '0x00', null), {
            lifeTimeA: null, lifeTimeB: 2, preEolInfo: null, writtenBytesPerDay: null, writtenOverSeconds: null,
        });
    });
    it('treats values outside the defined ranges as not given', () => {
        assert.equal(parseFlashWear('0x0C 0xFF', '0x04', null), null);
        assert.deepEqual(parseFlashWear('0x0B 0x01', '0x03', null), {
            lifeTimeA: 11, lifeTimeB: 1, preEolInfo: 3, writtenBytesPerDay: null, writtenOverSeconds: null,
        });
    });
    it('returns null when nothing could be read', () => {
        assert.equal(parseFlashWear('', '', null), null);
    });
});
describe('write rate', () => {
    it('reads the written sectors and uptime', () => {
        assert.deepEqual(parseWriteSample(STAT, '23689.00 90000.00\n'), { seconds: 23689, sectors: 1906248 });
        assert.equal(parseWriteSample('', ''), null);
    });
    it('ignores a large write before the window, unlike a since-boot average', () => {
        // A deploy wrote 1 GB right after boot; since then 1.43 GB a day.
        const perSecond = 1.43e9 / 512 / 86400;
        let samples = [];
        for (let s = 3600; s <= 3600 * 8; s += 300)
            samples = addWriteSample(samples, { seconds: s, sectors: Math.round(2e6 + perSecond * s) });
        const now = samples[samples.length - 1];
        const rate = recentWriteRate(samples, now);
        assert.ok(rate && Math.abs(rate.bytesPerDay - 1.43e9) < 1e6);
        assert.equal(rate?.overSeconds, 3600);
    });
    it('waits for half an hour of samples', () => {
        const samples = [{ seconds: 100, sectors: 0 }];
        assert.equal(recentWriteRate(samples, { seconds: 1899, sectors: 10 }), null);
        assert.equal(recentWriteRate(samples, { seconds: 1900, sectors: 10 })?.overSeconds, 1800);
    });
    it('starts over when the counter or clock goes back', () => {
        const before = addWriteSample([{ seconds: 5000, sectors: 900 }], { seconds: 5300, sectors: 950 });
        assert.deepEqual(addWriteSample(before, { seconds: 60, sectors: 10 }), [{ seconds: 60, sectors: 10 }]);
        assert.equal(recentWriteRate(before, { seconds: 7000, sectors: 5 }), null);
    });
});
//# sourceMappingURL=parseFlashWear.test.js.map