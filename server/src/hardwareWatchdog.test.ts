import assert from 'node:assert/strict';
import { it } from 'node:test';
import { hardwareWatchdogStatus } from './hardwareWatchdog.js';

const DROPIN = '# Managed by scripts/setup_watchdog.sh. See that script for why this exists.\n'
  + '[Manager]\nRuntimeWatchdogSec=30s\n';

it('the drop-in means the watchdog is on', () => {
  assert.deepEqual(hardwareWatchdogStatus(DROPIN, undefined), { status: 'healthy', message: 'Hardware watchdog on (30 s).' });
});

it('no drop-in and no trial file means it is off on this Pod', () => {
  assert.deepEqual(hardwareWatchdogStatus(undefined, undefined),
    { status: 'healthy', message: 'Hardware watchdog off on this Pod.' });
});

it('an unfinished or abandoned trial is not tried again', () => {
  for (const mark of ['', 'PID 1 let go of the device during the trial']) {
    assert.deepEqual(hardwareWatchdogStatus(undefined, mark), {
      status: 'healthy',
      message: 'Hardware watchdog off: its first try did not finish.',
    }, mark);
  }
});

it('the owner note means it was turned off by hand', () => {
  assert.deepEqual(hardwareWatchdogStatus(undefined, 'turned off by the owner with --remove'),
    { status: 'healthy', message: 'Hardware watchdog turned off by hand.' });
});
