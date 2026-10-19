import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/setup_watchdog.sh turns on systemd's runtime watchdog after every
// successful install and update on a Pod 5, and turns it off again on a
// switch to upstream. The
// watchdog resets the whole Pod if PID 1 stops petting it, so these run the
// script for real against a fake /proc, sysfs and systemd and check that it
// only ever arms where the hardware can hold the timeout, never overrides
// someone else's setting, and undoes exactly its own file.
//
// History: the stock Wi-Fi driver once oopsed and froze PID 1 partway
// through the nightly reboot. systemd shipped with RuntimeWatchdogSec off and
// arms the reboot watchdog only at the final handoff, which that shutdown
// never reached, so the Pod sat with no server and no cooling for hours.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/setup_watchdog.sh');
const DROPIN = '10-nightstand-watchdog.conf';
// What the first, hand-run version of the script wrote.
const MANUAL_DROPIN = '# Managed by scripts/setup_watchdog.sh. See that script for why this exists.\n'
  + '[Manager]\nRuntimeWatchdogSec=30s\nRebootWatchdogSec=60s\n';

type Pod = {
  device?: boolean;
  systemdVersion?: string;
  runtime?: string | null;
  sysfs?: Partial<Record<'identity' | 'timeout' | 'max_timeout' | 'min_timeout' | 'nowayout', string>> | null;
  driver?: string;
  compatible?: string[];
  compatibleContents?: string;
  compatibleReadFails?: boolean;
  sysfsMode?: number;
  otherHolder?: boolean;
  pid1Holds?: boolean;
  // How the fake PID 1 reacts to daemon-reexec with the drop-in in place.
  arm?: 'yes' | 'no' | 'wrong-timeout';
  reexecFails?: boolean;
  dropin?: string;
  trialMark?: string;
  // Contents of the Pod's device label, or null for none.
  label?: string | null;
  // The data folder holding the trial file is missing.
  noDataFolder?: boolean;
};

function pod(opts: Pod = {}) {
  const {
    device = true, systemdVersion = '250', runtime = '0', otherHolder = false, pid1Holds = false,
    arm = 'yes', reexecFails = false,
  } = opts;
  const sysfsValues = opts.sysfs === undefined
    ? { identity: 'mtk-wdt', timeout: '31', max_timeout: '31', min_timeout: '1', nowayout: '0' }
    : opts.sysfs;
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-watchdog-'));
  const bin = path.join(dir, 'bin');
  const conf = path.join(dir, 'system.conf.d');
  const runConf = path.join(dir, 'run-system.conf.d');
  const mark = path.join(dir, ...(opts.noDataFolder ? ['missing'] : []), 'watchdog-trial');
  const sysfs = path.join(dir, 'sysfs');
  const sysfsDevice = path.join(sysfs, 'device');
  const proc = path.join(dir, 'proc');
  const devicePath = path.join(dir, 'watchdog');
  const calls = path.join(dir, 'calls');
  const runtimeFile = path.join(dir, 'runtime');
  const labelFile = path.join(dir, 'device-label');
  const label = opts.label === undefined ? '20500-0005-G53-00012345\n' : opts.label;
  if (label !== null) writeFileSync(labelFile, label);
  mkdirSync(bin);
  mkdirSync(path.join(proc, '1', 'fd'), { recursive: true });
  if (device) writeFileSync(devicePath, '');
  if (sysfsValues) {
    mkdirSync(sysfs);
    for (const [name, value] of Object.entries(sysfsValues)) writeFileSync(path.join(sysfs, name), `${value}\n`);
  }
  mkdirSync(path.join(sysfsDevice, 'of_node'), { recursive: true });
  if (opts.driver !== undefined) symlinkSync(`/drivers/${opts.driver}`, path.join(sysfsDevice, 'driver'));
  if (opts.compatible !== undefined) {
    writeFileSync(path.join(sysfsDevice, 'of_node', 'compatible'), `${opts.compatible.join('\0')}\0`);
  }
  if (opts.compatibleContents !== undefined) {
    writeFileSync(path.join(sysfsDevice, 'of_node', 'compatible'), opts.compatibleContents);
  }
  if (opts.compatibleReadFails) {
    writeFileSync(path.join(bin, 'cat'), `#!/bin/sh
if [ "$1" = "${sysfsDevice}/of_node/compatible" ]; then
  printf 'mediatek,mt8365-wdt\\000'
  exit 1
fi
command -p cat "$@"
`);
    chmodSync(path.join(bin, 'cat'), 0o755);
  }
  if (opts.sysfsMode !== undefined) {
    mkdirSync(sysfs, { recursive: true });
    chmodSync(sysfs, opts.sysfsMode);
  }
  if (runtime !== null) writeFileSync(runtimeFile, runtime);
  if (pid1Holds) symlinkSync('/dev/watchdog0', path.join(proc, '1', 'fd', '3'));
  if (otherHolder) {
    mkdirSync(path.join(proc, '321', 'fd'), { recursive: true });
    symlinkSync('/dev/watchdog', path.join(proc, '321', 'fd', '4'));
  }
  if (opts.dropin !== undefined) {
    mkdirSync(conf);
    writeFileSync(path.join(conf, DROPIN), opts.dropin);
  }
  if (opts.trialMark !== undefined) writeFileSync(mark, opts.trialMark);

  const armed = arm === 'no' ? ':' : [
    `echo 30s > "${runtimeFile}"`,
    `ln -sf /dev/watchdog0 "${proc}/1/fd/3"`,
    arm === 'yes' && sysfsValues ? `echo 30 > "${sysfs}/timeout"` : ':',
  ].join('; ');
  writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  --version) echo "systemd ${systemdVersion} (${systemdVersion}.1)"; echo "+PAM +AUDIT" ;;
  show) [ -f "${runtimeFile}" ] && echo "RuntimeWatchdogUSec=$(cat "${runtimeFile}")" ;;
  daemon-reexec)
    ${reexecFails ? 'exit 1' : ''}
    if [ -f "${conf}/${DROPIN}" ] || [ -f "${runConf}/${DROPIN}" ]; then ${armed}; else echo 0 > "${runtimeFile}"; rm -f "${proc}/1/fd/3"; fi ;;
esac
exit 0
`);
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  writeFileSync(path.join(bin, 'sync'), `#!/bin/sh\necho "sync" >> "${calls}"\n`);
  chmodSync(path.join(bin, 'sync'), 0o755);

  const run = (...args: string[]) => spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NIGHTSTAND_SYSTEM_CONF_DIR: conf,
      NIGHTSTAND_RUNTIME_CONF_DIR: runConf,
      NIGHTSTAND_WATCHDOG_TRIAL_MARK: mark,
      NIGHTSTAND_WATCHDOG_TRIAL: '0',
      NIGHTSTAND_WATCHDOG_DEVICE: devicePath,
      NIGHTSTAND_WATCHDOG_SYSFS: sysfs,
      NIGHTSTAND_PROC: proc,
      NIGHTSTAND_WATCHDOG_WAIT: '1',
      NIGHTSTAND_DEVICE_LABEL: labelFile,
    },
  });
  const dropinPath = path.join(conf, DROPIN);
  const trialPath = path.join(runConf, DROPIN);
  return {
    run,
    dropin: () => (existsSync(dropinPath) ? readFileSync(dropinPath, 'utf8') : null),
    trialDropin: () => existsSync(trialPath),
    writeTrialDropin: () => { mkdirSync(runConf, { recursive: true }); writeFileSync(trialPath, MANUAL_DROPIN); },
    mark: () => (existsSync(mark) ? readFileSync(mark, 'utf8') : null),
    markPath: mark,
    dir,
    reexecs: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((l) => l === 'daemon-reexec').length : 0),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n') : []),
    setLabel: (text: string) => writeFileSync(labelFile, text),
    cleanup: () => {
      if (opts.sysfsMode !== undefined) chmodSync(sysfs, 0o755);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('setup_watchdog.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
    assert.ok(statSync(SCRIPT).mode & 0o111, 'setup_watchdog.sh must carry the exec bit');
  });

  it('arms the runtime watchdog through its own drop-in and checks that it took', () => {
    const p = pod();
    const result = p.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dropin = p.dropin() ?? '';
    assert.match(dropin, /^# Managed by scripts\/setup_watchdog\.sh/);
    assert.match(dropin, /^\[Manager\]$/m);
    assert.match(dropin, /^RuntimeWatchdogSec=30s$/m);
    assert.doesNotMatch(dropin, /RebootWatchdogSec/, 'the stock reboot watchdog is left as it is');
    assert.equal(p.reexecs(), 1, 'daemon-reload does not re-read Manager settings');
    assert.match(result.stdout, /Hardware watchdog on/);
    assert.equal(p.trialDropin(), false, 'the trial copy in /run is gone once /etc holds it');
    assert.equal(p.mark(), null, 'a finished trial leaves no trial file');
    p.cleanup();
  });

  describe('without watchdog sysfs attributes', () => {
    const checked: Pod = {
      sysfs: null,
      driver: 'mtk-wdt',
      compatible: ['mediatek,mt8365-wdt', 'mediatek,mt6589-wdt'],
      label: '20500-0006-H08-00000000\n',
    };

    it('arms the checked Pod 5 through the trial', () => {
      const p = pod(checked);
      try {
        const result = p.run('--auto');
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /trying it for/);
        assert.match(result.stdout, /Hardware watchdog on/);
        assert.match(p.dropin() ?? '', /RuntimeWatchdogSec=30s/);
        assert.equal(p.reexecs(), 1);
        assert.equal(p.trialDropin(), false);
        assert.equal(p.mark(), null);
      } finally { p.cleanup(); }
    });

    const unsupported: Array<[string, Pod, RegExp]> = [
      ['another driver', { driver: 'omap_wdt' }, /driver omap_wdt/],
      ['another compatible', { compatible: ['mediatek,mt6589-wdt'] }, /compatible mediatek,mt6589-wdt/],
      ['a compatible with only a matching prefix', { compatible: ['mediatek,mt8365-wdt-other'] }, /compatible mediatek,mt8365-wdt-other/],
      ['an older revision', { label: '20500-0005-G52-00012345\n' }, /revision G52/],
    ];
    for (const [why, opts, found] of unsupported) {
      it(`skips ${why} and reports what it found`, () => {
        const p = pod({ ...checked, ...opts });
        try {
          const result = p.run();
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.match(result.stdout, /Hardware watchdog left off: .*Pod 5/);
          assert.match(result.stdout, found);
          assert.equal(p.dropin(), null);
          assert.equal(p.reexecs(), 0);
          assert.equal(p.mark(), null);
        } finally { p.cleanup(); }
      });
    }

    const malformed: Array<[string, string]> = [
      ['an embedded newline', 'other-vendor,device\nmediatek,mt8365-wdt\0'],
      ['an unterminated entry', 'mediatek,mt8365-wdt'],
      ['an unterminated entry after a matching record', 'mediatek,mt8365-wdt\0other-vendor,device'],
      ['a newline after a matching record', 'mediatek,mt8365-wdt\0other-vendor,device\n\0'],
    ];
    for (const [why, compatibleContents] of malformed) {
      it(`skips a compatible list with ${why}`, () => {
        const p = pod({ ...checked, compatibleContents });
        try {
          const result = p.run();
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.match(result.stdout, /Hardware watchdog left off/);
          assert.equal(p.dropin(), null);
          assert.equal(p.reexecs(), 0);
          assert.equal(p.mark(), null);
        } finally { p.cleanup(); }
      });
    }

    it('skips a failed compatible read even if it produces matching data', () => {
      const p = pod({ ...checked, compatibleReadFails: true });
      try {
        const result = p.run();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Hardware watchdog left off/);
        assert.equal(p.dropin(), null);
        assert.equal(p.reexecs(), 0);
        assert.equal(p.mark(), null);
      } finally { p.cleanup(); }
    });

    for (const sysfsMode of [0o300, 0o600]) {
      it(`skips a watchdog directory with mode ${sysfsMode.toString(8)}`, {
        skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false,
      }, () => {
        const p = pod({ ...checked, sysfsMode });
        try {
          const result = p.run();
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.match(result.stdout, /Hardware watchdog left off: cannot inspect watchdog directory/);
          assert.equal(p.dropin(), null);
          assert.equal(p.reexecs(), 0);
          assert.equal(p.mark(), null);
        } finally { p.cleanup(); }
      });
    }

    it('skips an existing runtime setting before identifying hardware', () => {
      const p = pod({ ...checked, runtime: '1min', driver: 'omap_wdt' });
      try {
        const result = p.run();
        assert.equal(result.status, 0);
        assert.match(result.stdout, /already set to 1min outside Nightstand/);
        assert.doesNotMatch(result.stdout, /driver omap_wdt/);
        assert.equal(p.reexecs(), 0);
        assert.equal(p.dropin(), null);
        assert.equal(p.mark(), null);
      } finally { p.cleanup(); }
    });

    it('does not use the fallback over present or partial sysfs attributes', () => {
      for (const sysfs of [
        { identity: 'omap_wdt', timeout: '31', max_timeout: '31', min_timeout: '1' },
        { identity: 'mtk-wdt', timeout: '16', max_timeout: '31', min_timeout: '1' },
        { timeout: '' },
        { identity: 'mtk-wdt' },
      ]) {
        const p = pod({ ...checked, sysfs });
        try {
          const result = p.run();
          assert.equal(result.status, 0);
          assert.match(result.stdout, /Hardware watchdog left off/);
          assert.equal(p.reexecs(), 0);
          assert.equal(p.dropin(), null);
        } finally { p.cleanup(); }
      }
    });

    it('abandons the trial when PID 1 does not take the device', () => {
      const p = pod({ ...checked, arm: 'no' });
      try {
        const result = p.run();
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(p.mark() ?? '', /PID 1 did not take the device/);
        assert.equal(p.dropin(), null);
        assert.equal(p.trialDropin(), false);
      } finally { p.cleanup(); }
    });
  });

  it('does not try again after a trial that never finished', () => {
    // An empty trial file means the run stopped partway, most likely because
    // the watchdog reset the Pod. /run was cleared by that reset.
    const p = pod({ trialMark: '' });
    p.writeTrialDropin();
    const result = p.run();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Hardware watchdog left off: an earlier trial did not finish/);
    assert.equal(p.reexecs(), 0);
    assert.equal(p.dropin(), null);
    assert.equal(p.trialDropin(), false);
    p.cleanup();
  });

  describe('a link the server user plants at the trial file', () => {
    const plant = (p: ReturnType<typeof pod>, victim: string) => symlinkSync(victim, p.markPath);
    it('--remove writes its note in place of the link, not through it', () => {
      const p = pod();
      try {
        const victim = path.join(p.dir, 'victim');
        plant(p, victim);
        assert.equal(p.run('--remove').status, 0);
        assert.equal(existsSync(victim), false);
        assert.equal(lstatSync(p.markPath).isFile(), true);
        assert.match(p.mark() ?? '', /turned off by the owner/);
      } finally { p.cleanup(); }
    });
    it('a failed trial records its reason in place of the link, not through it', () => {
      const p = pod({ arm: 'no' });
      try {
        const victim = path.join(p.dir, 'victim');
        plant(p, victim);
        assert.equal(p.run('--auto').status, 1);
        assert.equal(existsSync(victim), false);
        assert.equal(lstatSync(p.markPath).isFile(), true);
        assert.notEqual(p.mark(), '');
      } finally { p.cleanup(); }
    });
    it('is never read, so root prints nothing from the file it points to', () => {
      const p = pod();
      try {
        const secret = path.join(p.dir, 'secret');
        writeFileSync(secret, 'root-only line\n');
        plant(p, secret);
        const result = p.run('--auto');
        assert.doesNotMatch(result.stdout + result.stderr, /root-only line/);
        assert.equal(p.reexecs(), 0);
        assert.equal(readFileSync(secret, 'utf8'), 'root-only line\n');
      } finally { p.cleanup(); }
    });
  });

  it('writes the trial file to disk before the re-exec that could reset the Pod', () => {
    const p = pod();
    p.run();
    const calls = p.calls();
    assert.ok(calls.includes('sync'), 'the trial file must be flushed');
    assert.ok(calls.indexOf('sync') < calls.indexOf('daemon-reexec'));
    p.cleanup();
  });

  it('is turned on only on the Pod 5 it was checked on, and tries again at the next update', () => {
    // A Pod 4 with a G-revision label older than G53, or a driver other than
    // mtk-wdt with its 31 second maximum, has not been checked.
    const other: Array<[string, Pod]> = [
      ['an older hub revision', { label: '20500-0004-G00-00012345\n' }],
      ['no device label', { label: null }],
      // The server reads these as no revision at all, so not a Pod 5.
      ['a label without dashes', { label: 'garbage\n' }],
      ['a third field that is not a revision', { label: '20500-0005-zzz-00012345\n' }],
      ['a revision split from its field by a line break', { label: '20500-0005-\nG53-00012345\n' }],
      ['another driver', { sysfs: { identity: 'omap_wdt', timeout: '60', max_timeout: '60', nowayout: '0' } }],
      ['another maximum', { sysfs: { identity: 'mtk-wdt', timeout: '31', max_timeout: '0', nowayout: '0' } }],
    ];
    for (const [why, opts] of other) {
      const p = pod(opts);
      const result = p.run();
      assert.equal(result.status, 0, why);
      assert.match(result.stdout, /Hardware watchdog left off: .*Pod 5/, why);
      assert.equal(p.dropin(), null, why);
      assert.equal(p.reexecs(), 0, why);
      assert.equal(p.mark(), null, `${why}: a skipped Pod is not marked, so it tries again`);
      p.cleanup();
    }
    // The server splits the whole file, not only its first line.
    const multiline = pod({ label: '20500-0005\n-G53-00012345\n' });
    assert.equal(multiline.run().status, 0);
    assert.match(multiline.dropin() ?? '', /RuntimeWatchdogSec=30s/, 'G53 is the third field of the whole label');
    multiline.cleanup();

    const later = pod({ label: '20500-0004-G00-00012345\n' });
    later.run();
    later.setLabel('20500-0005-G60-00012345\n');
    assert.equal(later.run().status, 0);
    assert.match(later.dropin() ?? '', /RuntimeWatchdogSec=30s/);
    later.cleanup();
  });

  it('does nothing on a second run', () => {
    const p = pod();
    p.run();
    const first = p.dropin();
    const again = p.run();
    assert.equal(again.status, 0);
    assert.equal(p.dropin(), first);
    assert.equal(p.reexecs(), 1, 'an update must not re-exec PID 1 again');
    assert.match(again.stdout, /already on/);
    p.cleanup();
  });

  it('keeps the drop-in the hand-run version wrote, byte for byte', () => {
    const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true });
    const result = p.run();
    assert.equal(result.status, 0);
    assert.equal(p.dropin(), MANUAL_DROPIN);
    assert.equal(p.reexecs(), 0);
    p.cleanup();
  });

  const skips: Array<[string, Pod, RegExp]> = [
    ['there is no watchdog device', { device: false }, /no watchdog device/],
    ['systemd is older than 230', { systemdVersion: '229' }, /systemd 229/],
    ['the systemd version cannot be read', { systemdVersion: 'unknown' }, /systemd unknown/],
    ['systemd does not report the setting', { runtime: null }, /does not report/],
    ['the runtime watchdog is already set elsewhere', { runtime: '1min' }, /already set to 1min/],
    ['the driver does not report its timeout', { sysfs: null }, /timeout/],
    ['the hardware timeout is shorter than 30 seconds', { sysfs: { timeout: '16', max_timeout: '16', nowayout: '0' } }, /16/],
    ['the hardware maximum is below 30 seconds', { sysfs: { timeout: '60', max_timeout: '20', nowayout: '0' } }, /20/],
    ['the hardware minimum is above 30 seconds', { sysfs: { timeout: '60', min_timeout: '45', nowayout: '0' } }, /45/],
    ['another program holds the watchdog', { otherHolder: true }, /another program/],
  ];
  for (const [why, opts, reason] of skips) {
    it(`leaves the watchdog off when ${why}`, () => {
      const p = pod(opts);
      const result = p.run();
      assert.equal(result.status, 0, 'skipping is not a failure');
      assert.match(result.stdout, /Hardware watchdog left off/);
      assert.match(result.stdout, reason);
      assert.equal(p.dropin(), null);
      assert.equal(p.reexecs(), 0);
      p.cleanup();
    });
  }

  it('leaves a drop-in of the same name that is not its own alone', () => {
    const foreign = '[Manager]\nRuntimeWatchdogSec=2min\n';
    const p = pod({ dropin: foreign });
    const result = p.run();
    assert.equal(result.status, 0);
    assert.equal(p.dropin(), foreign);
    assert.equal(p.reexecs(), 0);
    p.cleanup();
  });

  it('takes its setting back out when PID 1 did not open the device, and does not try again', () => {
    const p = pod({ arm: 'no' });
    const result = p.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /is NOT active/);
    assert.equal(p.dropin(), null);
    assert.equal(p.trialDropin(), false);
    assert.equal(p.reexecs(), 2, 'nothing is armed, so re-exec again to drop the setting');
    assert.match(p.mark() ?? '', /PID 1 did not take the device/);
    const again = p.run();
    assert.equal(again.status, 0);
    assert.match(again.stdout, /left off: PID 1 did not take the device/);
    assert.equal(p.reexecs(), 2);
    p.cleanup();
  });

  it('never re-execs to undo an armed device it could not configure', () => {
    // PID 1 holds the device but the timeout did not take. It still pets more
    // often than the hardware's own timeout, while closing the device on a
    // kernel that cannot stop it would reset the Pod.
    const p = pod({ arm: 'wrong-timeout' });
    const result = p.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /is NOT active as set up/);
    assert.equal(p.dropin(), null);
    assert.equal(p.trialDropin(), false);
    assert.equal(p.reexecs(), 1);
    p.cleanup();
  });

  it('turns it on the same way when an install or update runs it', () => {
    const p = pod();
    const result = p.run('--auto');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(p.dropin() ?? '', /RuntimeWatchdogSec=30s/);
    p.cleanup();
  });

  it('does not clear a failed trial when run by hand', () => {
    const p = pod({ trialMark: 'PID 1 did not take the device\n' });
    const result = p.run();
    assert.equal(result.status, 0);
    assert.match(result.stdout, /left off: PID 1 did not take the device; delete .* to try again/);
    assert.equal(p.reexecs(), 0);
    assert.equal(p.mark(), 'PID 1 did not take the device\n');
    p.cleanup();
  });

  it('refuses an argument it does not know rather than arming', () => {
    const p = pod();
    const result = p.run('--remvoe');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage/);
    assert.equal(p.dropin(), null);
    assert.equal(p.reexecs(), 0);
    assert.equal(p.mark(), null);
    p.cleanup();
  });

  it('takes its setting back out when the re-exec fails', () => {
    const p = pod({ reexecFails: true });
    const result = p.run();
    assert.equal(result.status, 1);
    assert.equal(p.dropin(), null);
    assert.equal(p.trialDropin(), false);
    p.cleanup();
  });

  describe('--remove', () => {
    it('removes its drop-in and turns the watchdog off now on a kernel that can stop it', () => {
      const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true });
      const result = p.run('--remove');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(p.dropin(), null);
      assert.equal(p.reexecs(), 1);
      p.cleanup();
    });

    it('removes a trial copy and keeps the reason an earlier trial failed', () => {
      const p = pod({ runtime: '30s', pid1Holds: true, trialMark: 'PID 1 did not take the device\n' });
      p.writeTrialDropin();
      assert.equal(p.run('--remove').status, 0);
      assert.equal(p.trialDropin(), false);
      assert.equal(p.mark(), 'PID 1 did not take the device\n', 'a failed trial is not tried again');
      assert.match(p.run('--remove').stdout, /leave it off after the earlier trial; delete .*watchdog-trial to try again/);
      p.cleanup();
    });

    it('leaves a note that keeps installs and updates from turning it on again', () => {
      const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true });
      const removed = p.run('--remove');
      assert.equal(removed.status, 0, removed.stdout + removed.stderr);
      assert.match(p.mark() ?? '', /^turned off by the owner with --remove$/m);
      assert.match(removed.stdout, /installs and updates leave it off/);
      const reexecs = p.reexecs();
      const update = p.run('--auto');
      assert.equal(update.status, 0);
      assert.match(update.stdout, /Hardware watchdog left off: turned off by the owner/);
      assert.equal(p.dropin(), null);
      assert.equal(p.reexecs(), reexecs, 'an install or update must not re-exec PID 1');
      assert.match(p.mark() ?? '', /turned off by the owner/, 'the note stays for the next update');
      p.cleanup();
    });

    it('leaves the note even when there was nothing to remove', () => {
      const p = pod();
      assert.equal(p.run('--remove').status, 0);
      assert.match(p.mark() ?? '', /turned off by the owner/);
      assert.equal(p.run('--auto').status, 0);
      assert.equal(p.dropin(), null);
      assert.equal(p.reexecs(), 0);
      p.cleanup();
    });

    it('says so when the note cannot be written, and still removes the setting', () => {
      const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true, noDataFolder: true });
      const result = p.run('--remove');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /WARNING: could not write .*watchdog-trial, so the next install or update turns the watchdog on again/);
      assert.equal(p.dropin(), null);
      p.cleanup();
    });

    it('turns it on again, and clears the note, when run by hand', () => {
      const p = pod();
      p.run('--remove');
      const result = p.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(p.dropin() ?? '', /RuntimeWatchdogSec=30s/);
      assert.equal(p.mark(), null);
      assert.match(result.stdout, /Hardware watchdog on/);
      p.cleanup();
    });

    it('records no choice when Nightstand is leaving the Pod', () => {
      // Rolling back to another fork or switching to upstream takes the
      // setting out; a later install of Nightstand turns it on as usual.
      const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true });
      const result = p.run('--remove', '--switching');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(p.dropin(), null);
      assert.equal(p.mark(), null);
      p.cleanup();

      // An owner's note or a failed trial stays as it was.
      for (const trialMark of ['turned off by the owner with --remove\n', 'PID 1 did not take the device\n', '']) {
        const kept = pod({ trialMark });
        assert.equal(kept.run('--remove', '--switching').status, 0);
        assert.equal(kept.mark(), trialMark);
        kept.cleanup();
      }
    });

    it('leaves PID 1 petting until the next restart where the watchdog cannot be stopped', () => {
      for (const sysfs of [{ timeout: '30', nowayout: '1' }, { timeout: '30' }]) {
        const p = pod({ dropin: MANUAL_DROPIN, runtime: '30s', pid1Holds: true, sysfs });
        const result = p.run('--remove');
        assert.equal(result.status, 0);
        assert.equal(p.dropin(), null);
        assert.equal(p.reexecs(), 0);
        assert.match(result.stdout, /next restart/);
        p.cleanup();
      }
    });

    it('leaves anything that is not its own alone', () => {
      const foreign = '[Manager]\nRuntimeWatchdogSec=2min\n';
      const p = pod({ dropin: foreign, runtime: '2min', pid1Holds: true });
      assert.equal(p.run('--remove').status, 0);
      assert.equal(p.dropin(), foreign);
      assert.equal(p.reexecs(), 0);
      p.cleanup();

      const none = pod();
      assert.equal(none.run('--remove').status, 0);
      assert.equal(none.reexecs(), 0);
      none.cleanup();
    });
  });

  describe('source', () => {
    const src = readFileSync(SCRIPT, 'utf8');

    it('keeps the runtime timeout inside the 31 second mtk-wdt hardware maximum', () => {
      // Above the maximum the timeout either needs the kernel to extend it in
      // software or fails to set, and a failed set leaves the hardware on its
      // own timeout while PID 1 pets at half the longer one: a reset loop.
      const match = src.match(/^RUNTIME=(\d+)$/m);
      assert.ok(match, 'the runtime timeout must be a plain number of seconds');
      assert.ok(Number(match[1]) <= 31, `${match[1]}s exceeds the 31s mtk-wdt hardware maximum`);
    });

    it('never writes the stock system.conf', () => {
      assert.match(src, /system\.conf\.d/);
      assert.doesNotMatch(src, />+ *"?\/etc\/systemd\/system\.conf"?\s*$/m);
    });
  });
});
