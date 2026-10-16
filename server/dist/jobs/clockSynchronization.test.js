import assert from 'node:assert/strict';
import { beforeEach, it, mock } from 'node:test';
let markerPresent = false;
let output = 'NTPSynchronized=no\n';
let commandError = null;
const commands = [];
mock.module('node:fs/promises', { namedExports: {
        access: async (file) => {
            assert.equal(file, '/run/systemd/timesync/synchronized');
            if (!markerPresent)
                throw new Error('No marker');
        },
    } });
mock.module('node:child_process', { namedExports: {
        execFile: (command, args, options, callback) => {
            commands.push([command, args, options]);
            callback(commandError, output);
        },
    } });
const { readNtpSynchronization } = await import('./clockSynchronization.js');
beforeEach(() => {
    markerPresent = false;
    output = 'NTPSynchronized=no\n';
    commandError = null;
    commands.length = 0;
});
it('accepts the timesyncd marker without running a command', async () => {
    markerPresent = true;
    assert.equal(await readNtpSynchronization(), true);
    assert.deepEqual(commands, []);
});
for (const [response, synchronized] of [['NTPSynchronized=yes\n', true], ['NTPSynchronized=no\n', false]]) {
    it(`reads ${response.trim()} with a bounded timedatectl command`, async () => {
        output = response;
        assert.equal(await readNtpSynchronization(), synchronized);
        assert.deepEqual(commands, [['timedatectl', ['show', '-p', 'NTPSynchronized'], { timeout: 2000, encoding: 'utf8' }]]);
    });
}
it('falls back when timedatectl is unavailable or times out', async () => {
    commandError = new Error('Command unavailable');
    assert.equal(await readNtpSynchronization(), undefined);
});
it('does not mistake an unknown property for an unsynchronized clock', async () => {
    output = 'LocalRTC=no\n';
    assert.equal(await readNtpSynchronization(), undefined);
});
//# sourceMappingURL=clockSynchronization.test.js.map