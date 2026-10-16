import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// A stand-in nmcli that records its arguments.
const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-wifi-'));
const calls = path.join(dir, 'calls');
writeFileSync(path.join(dir, 'nmcli'), `#!/bin/sh\necho "$*" >> "${calls}"\nprintf 'no:Other:40\\nyes:Home\\\\:5G:73\\n'\n`);
chmodSync(path.join(dir, 'nmcli'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.ENV = 'local';
const wifi = await import('./wifiSignalStrength.js');
after(() => rmSync(dir, { recursive: true, force: true }));
const callCount = () => readFileSync(calls, 'utf8').trim().split('\n').length;
it('reads the last scan without asking for a new one', async () => {
    await wifi.refreshWifiSignalStrength(1_000_000);
    assert.equal(wifi.WIFI_SIGNAL_STRENGTH, 73);
    assert.match(readFileSync(calls, 'utf8'), /dev wifi list --rescan no/);
});
it('asks NetworkManager at most once a minute', async () => {
    await wifi.refreshWifiSignalStrength(2_000_000);
    const first = callCount();
    await wifi.refreshWifiSignalStrength(2_030_000);
    assert.equal(callCount(), first);
    await wifi.refreshWifiSignalStrength(2_060_000);
    assert.equal(callCount(), first + 1);
});
it('shares one read between callers in the same moment', async () => {
    const before = callCount();
    await Promise.all([3_000_000, 3_000_000, 3_000_000].map(now => wifi.refreshWifiSignalStrength(now)));
    assert.equal(callCount(), before + 1);
});
it('shows no strength rather than an old one when the read fails', async () => {
    writeFileSync(path.join(dir, 'nmcli'), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 8\n`);
    await wifi.refreshWifiSignalStrength(4_000_000);
    assert.equal(wifi.WIFI_SIGNAL_STRENGTH, 0);
});
//# sourceMappingURL=wifiSignalStrength.test.js.map