import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlashWear } from './parseFlashWear.js';
// Values from our Pod: life_time 0x01 0x01, pre_eol 0x01, and the
// whole-chip stat line 23689 s after boot (1906248 sectors written).
const STAT = '   15243     2788  1138212    13753   148097    45686  1906248   841874        0   136880   899670\n';
describe('parseFlashWear', () => {
    it('reads the wear levels and averages writes since boot over a day', () => {
        assert.deepEqual(parseFlashWear('0x01 0x01\n', '0x01\n', STAT, '23689.00 90000.00\n'), {
            lifeTimeA: 1, lifeTimeB: 1, preEolInfo: 1, writtenBytesPerDay: Math.round(1906248 * 512 / 23689 * 86400),
        });
    });
    it('treats 0x00 as not given and skips the daily rate in the first hour', () => {
        assert.deepEqual(parseFlashWear('0x00 0x02', '0x00', STAT, '1800.5 1.0'), {
            lifeTimeA: null, lifeTimeB: 2, preEolInfo: null, writtenBytesPerDay: null,
        });
    });
    it('treats values outside the defined ranges as not given', () => {
        assert.equal(parseFlashWear('0x0C 0xFF', '0x04', STAT, '1800.5 1.0'), null);
        assert.deepEqual(parseFlashWear('0x0B 0x01', '0x03', STAT, '1800.5 1.0'), {
            lifeTimeA: 11, lifeTimeB: 1, preEolInfo: 3, writtenBytesPerDay: null,
        });
    });
    it('returns null when nothing could be read', () => {
        assert.equal(parseFlashWear('', '', '', ''), null);
    });
});
//# sourceMappingURL=parseFlashWear.test.js.map