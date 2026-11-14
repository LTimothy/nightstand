import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootRescueStatus, readBootSettings } from './bootRescue.js';

it('bootdelay 2 with matching slots is healthy', () => {
  assert.deepEqual(bootRescueStatus({ bootdelay: '2', currentSlot: 'a', nextSlot: 'a' }),
    { status: 'healthy', message: 'Startup pauses for serial access (bootdelay 2).' });
});

it('bootdelay -1 is healthy', () => {
  assert.deepEqual(bootRescueStatus({ bootdelay: '-1', currentSlot: 'a', nextSlot: 'a' }),
    { status: 'healthy', message: 'Startup pauses for serial access (bootdelay -1).' });
});

it('bootdelay -2 is failed', () => {
  assert.deepEqual(bootRescueStatus({ bootdelay: '-2', currentSlot: 'a', nextSlot: 'a' }), {
    status: 'failed',
    message: 'Startup no longer pauses for serial access (bootdelay -2), so serial rescue will not work. '
      + 'Set it back with fw_setenv bootdelay 2 over SSH. This row updates after the next restart.',
  });
});

it('bootdelay -2 with a pending slot switch shows both, bootdelay first', () => {
  const { status, message } = bootRescueStatus({ bootdelay: '-2', currentSlot: 'a', nextSlot: 'b' });
  assert.equal(status, 'failed');
  assert.match(message, /^Startup no longer pauses .*This row updates after the next restart\. /);
  assert.match(message, /\. The next restart will start from the other system slot\./);
});

it('current a and next b is failed', () => {
  assert.deepEqual(bootRescueStatus({ bootdelay: '2', currentSlot: 'a', nextSlot: 'b' }), {
    status: 'failed',
    message: 'The next restart will start from the other system slot. A stock update may be waiting; check before restarting.',
  });
});

it('missing file is not_started', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-boot-'));
  const expected = { status: 'not_started', message: 'Boot settings not read yet.' };
  assert.deepEqual(bootRescueStatus(readBootSettings(path.join(dir, 'missing.json'))), expected);
  rmSync(dir, { recursive: true, force: true });
});

it('a file with null settings could not be read', () => {
  assert.deepEqual(bootRescueStatus({ bootdelay: null, currentSlot: null, nextSlot: null }),
    { status: 'not_started', message: 'Boot settings could not be read.' });
});
