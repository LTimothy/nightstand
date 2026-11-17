import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_FOLDER = `${mkdtempSync(path.join(tmpdir(), 'nightstand-config-'))}/`;
process.env.ENV = 'local';
let sockPathFromFrankScript: typeof import('./config.js')['sockPathFromFrankScript'];
let pickSockPath: typeof import('./config.js')['pickSockPath'];
let sockPathFromSources: typeof import('./config.js')['sockPathFromSources'];
before(async () => {
  ({ sockPathFromFrankScript, pickSockPath, sockPathFromSources } = await import('./config.js'));
});

describe('sockPathFromFrankScript', () => {
  it('reads the socket path the way the installer does', () => {
    const frank = '#!/bin/sh\nexport DAC_SOCKET=/persistent/deviceinfo/dac.sock\nexec /opt/eight/bin/frankenfirmware\n';
    assert.equal(sockPathFromFrankScript(frank), '/persistent/deviceinfo/dac.sock');
  });
  it('ignores a value that is not a dac.sock path', () => {
    assert.equal(sockPathFromFrankScript('DAC_SOCKET=/tmp/other\n'), undefined);
    assert.equal(sockPathFromFrankScript(''), undefined);
  });
});

describe('sockPathFromSources', () => {
  const unit = '[Service]\nEnvironment="DAC_SOCKET=/persistent/deviceinfo/dac.sock"\nExecStart=/opt/eight/bin/frankenfirmware\n';
  it('reads the frank unit when frank.sh is missing', () => {
    const files: Record<string, string> = { 'frank.service': unit };
    assert.equal(sockPathFromSources((file) => files[file], ['frank.sh', 'frank.service']), '/persistent/deviceinfo/dac.sock');
  });
  it('prefers frank.sh and skips a file without a path', () => {
    const files: Record<string, string> = { 'frank.sh': 'DAC_SOCKET=/a/dac.sock', 'frank.service': unit, 'empty': 'x' };
    assert.equal(sockPathFromSources((file) => files[file], ['empty', 'frank.sh', 'frank.service']), '/a/dac.sock');
    assert.equal(sockPathFromSources(() => undefined, ['frank.sh']), undefined);
  });
});

describe('pickSockPath', () => {
  const firmware = () => '/persistent/deviceinfo/dac.sock';
  it('prefers the installer copy', () => {
    assert.equal(pickSockPath('/custom/dac.sock', false, firmware), '/custom/dac.sock');
  });
  it('falls back to the firmware when the copy is missing or empty', () => {
    assert.equal(pickSockPath(undefined, false, firmware), '/persistent/deviceinfo/dac.sock');
    assert.equal(pickSockPath('', false, firmware), '/persistent/deviceinfo/dac.sock');
  });
  it('never reads the firmware in remote dev mode', () => {
    assert.equal(pickSockPath('', true, () => { throw new Error('read'); }), undefined);
  });
});
