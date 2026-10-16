import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBleLine, notificationBytes } from './bleOutput.js';
describe('cleanBleLine', () => {
    it('removes bracketed tags', () => {
        assert.equal(cleanBleLine('[CHG] Attribute Value:'), ' Attribute Value:');
        assert.equal(cleanBleLine('[TriMix]# ff ff'), '# ff ff');
    });
    it('removes the colour codes bluetoothctl wraps its prompt in', () => {
        const prompt = '\u0001\x1b[0;94m\u0002[TriMix]\u0001\x1b[0m\u0002# ';
        assert.equal(cleanBleLine(`${prompt}ff 01\r`), '# ff 01');
    });
});
describe('notificationBytes', () => {
    it('reads a hex dump line', () => {
        assert.deepEqual(notificationBytes('  ff ff ff ff 01 02 0a 0b  ........'), [0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x0a, 0x0b]);
    });
    it('ignores the MAC address in device lines', () => {
        assert.deepEqual(notificationBytes('[NEW] Device AA:BB:CC:DD:EE:FF TriMix'), []);
        assert.deepEqual(notificationBytes('[CHG] Device aa:bb:cc:dd:ee:ff Connected: yes'), []);
    });
    it('ignores the device path in attribute lines', () => {
        assert.deepEqual(notificationBytes('[CHG] Attribute /org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF/service000c/char000d Value:'), []);
    });
});
//# sourceMappingURL=bleOutput.test.js.map