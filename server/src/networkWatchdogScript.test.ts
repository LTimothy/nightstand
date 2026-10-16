import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/network_watchdog.sh runs every minute from
// free-sleep-network-watchdog.timer and restarts the Pod when its Wi-Fi
// driver has died. The stock driver can crash and leave the Pod running but
// unreachable until it is unplugged. These run the script for real with
// journalctl, ping, arping, systemctl, sync and date stubbed, and with a fake
// route table, uptime, boot id, /proc and driver folder, so nothing on the
// host is touched and nothing restarts.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/network_watchdog.sh');

const NOW = 1_790_000_000;
const BOOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const GATEWAY_ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
  + 'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n'
  + 'wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n';
const NO_DEFAULT_ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
  + 'wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n';

// The driver crash and what followed, as a Pod 5's journal shows it in
// short-iso format. The script reads the journal with -o cat, which drops
// the prefix, and dmesg, which adds its own; both forms are tested.
const POD_LOG = [
  '2026-01-15T02:37:44+0000 pod5 kernel: Unable to handle kernel paging request at virtual address ffff000003000000',
  '2026-01-15T02:37:44+0000 pod5 kernel: Mem abort info:',
  '2026-01-15T02:37:44+0000 pod5 kernel:   ESR = 0x96000007',
  '2026-01-15T02:37:44+0000 pod5 kernel:   EC = 0x25: DABT (current EL), IL = 32 bits',
  '2026-01-15T02:37:44+0000 pod5 kernel:   SET = 0, FnV = 0',
  '2026-01-15T02:37:44+0000 pod5 kernel:   EA = 0, S1PTW = 0',
  '2026-01-15T02:37:44+0000 pod5 kernel:   FSC = 0x07: level 3 translation fault',
  '2026-01-15T02:37:44+0000 pod5 kernel: Data abort info:',
  '2026-01-15T02:37:44+0000 pod5 kernel:   ISV = 0, ISS = 0x00000007',
  '2026-01-15T02:37:44+0000 pod5 kernel:   CM = 0, WnR = 0',
  '2026-01-15T02:37:44+0000 pod5 kernel: swapper pgtable: 4k pages, 48-bit VAs, pgdp=000000006590f000',
  '2026-01-15T02:37:44+0000 pod5 kernel: [ffff000003000000] pgd=18000000bfff8003, p4d=18000000bfff8003, '
    + 'pud=18000000bfff7003, pmd=18000000bffde003, pte=0000000000000000',
  '2026-01-15T02:37:44+0000 pod5 kernel: Internal error: Oops: 96000007 [#1] PREEMPT SMP',
  '2026-01-15T02:37:44+0000 pod5 kernel: CPU: 2 PID: 225 Comm: main_thread Tainted: G           O      '
    + '5.15.42-mtk+ga46a21ed7edc #1',
  '2026-01-15T02:37:44+0000 pod5 kernel: Hardware name: MT8365 Pumpkin (DT)',
  '2026-01-15T02:37:44+0000 pod5 kernel: pstate: 00000005 (nzcv daif -PAN -UAO -TCO -DIT -SSBS BTYPE=--)',
  '2026-01-15T02:37:44+0000 pod5 kernel: pc : aisCollectNeighborAP.part.0+0xa8/0x3f0 [wlan_drv_gen4_MT7663]',
  '2026-01-15T02:37:44+0000 pod5 kernel: lr : aisCollectNeighborAP+0x34/0x44 [wlan_drv_gen4_MT7663]',
  '2026-01-15T02:37:44+0000 pod5 kernel: sp : ffff80000ad4bca0',
  '2026-01-15T02:40:34+0000 pod5 wpa_supplicant[416]: wlan0: CTRL-EVENT-SCAN-FAILED ret=-22',
  '2026-01-15T02:41:05+0000 pod5 wpa_supplicant[416]: wlan0: CTRL-EVENT-SCAN-FAILED ret=-22',
  '2026-01-15T02:41:44+0000 pod5 wpa_supplicant[416]: wlan0: CTRL-EVENT-SCAN-FAILED ret=-22',
  '2026-01-15T02:45:10+0000 pod5 NetworkManager[315]: <warn>  [1768445110.6010] ndisc[0xaaaaf655a450,"wlan0"]: '
    + 'solicit: failure sending router solicitation: Operation not permitted (1)',
];
const fromSource = (source: string) => POD_LOG.filter(line => line.includes(` ${source}`));
// What journalctl -o cat prints: the message alone.
const message = (line: string) => line.replace(/^\S+ \S+ [^:]+: /, '');
const POD_KERNEL = fromSource('kernel:');
const POD_SCANS = fromSource('wpa_supplicant[');
const POD_NDISC = fromSource('NetworkManager[');
const OOPS_HEAD = POD_KERNEL.slice(0, POD_KERNEL.findIndex(line => line.includes(' pc : '))).map(message);
const WLAN_OOPS = POD_KERNEL.map(message).join('\n');
const WLAN_OOPS_ENDED = [...POD_KERNEL.map(message), '---[ end trace 0000000000000000 ]---'].join('\n');
// The same lines in short-iso format, with the other services' lines after.
const WLAN_OOPS_SHORT_ISO = POD_LOG.join('\n');
// A crash elsewhere: the driver is only listed among the loaded modules.
const OTHER_OOPS = [
  'Internal error: Oops: 96000004 [#1] PREEMPT SMP',
  'Modules linked in: wlan_drv_gen4_MT7663(O) btmtk(O)',
  'pc : some_other_function+0x10/0x40 [btmtk]',
  '---[ end trace 0000000000000001 ]---',
].join('\n');
// A driver warning is not a crash.
const WLAN_WARNING = [
  '------------[ cut here ]------------',
  'WARNING: CPU: 0 PID: 812 at drivers/misc/wlan.c:100 nicTxMsduQueue+0x10/0x20 [wlan_drv_gen4_MT7663]',
  '---[ end trace 0000000000000002 ]---',
].join('\n');

type Pod = {
  driver?: boolean;
  uptime?: number;
  now?: number;
  routes?: string;
  ping?: boolean;
  arping?: boolean;
  kernel?: string;
  dmesg?: string;
  scanFailures?: number;
  // systemd's RuntimeWatchdogUSec, or null when systemd does not report it.
  watchdog?: string | null;
  units?: Record<string, string>;
  processes?: string[][];
  lockHeld?: boolean;
  state?: string;
  stateDirMissing?: boolean;
};

// The key /proc/locks prints for a file: hex major:minor, then the inode.
function lockKey(file: string) {
  return execFileSync('python3', ['-c',
    'import os, sys; s = os.stat(sys.argv[1]); print("%02x:%02x:%d" % (os.major(s.st_dev), os.minor(s.st_dev), s.st_ino))',
    file], { encoding: 'utf8' }).trim();
}

function pod(opts: Pod = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-netwatch-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const calls = path.join(dir, 'calls');
  const file = (name: string) => path.join(dir, name);
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  const module = file('module');
  if (opts.driver ?? true) mkdirSync(module);
  const set = {
    uptime: (seconds: number) => writeFileSync(file('uptime'), `${seconds}.42 1234.00\n`),
    now: (epoch: number) => writeFileSync(file('now'), `${epoch}\n`),
    routes: (table: string) => writeFileSync(file('routes'), table),
    ping: (answers: boolean) => writeFileSync(file('ping'), answers ? '0' : '1'),
    arping: (answers: boolean) => writeFileSync(file('arping'), answers ? '0' : '1'),
    kernel: (log: string) => writeFileSync(file('kernel.log'), log ? `${log}\n` : ''),
    // wpa_supplicant's lines while the driver is dead, about every 30 s.
    scanFailures: (count: number, code = '-22') => writeFileSync(file('journal.log'),
      `wlan0: CTRL-EVENT-SCAN-FAILED ret=${code}\n`.repeat(count) + 'some other line\n'),
    pingStatus: (status: number) => writeFileSync(file('ping'), String(status)),
    watchdog: (value: string | null) => (value === null ? rmSync(file('runtime-watchdog'), { force: true })
      : writeFileSync(file('runtime-watchdog'), value)),
    boot: (id: string) => writeFileSync(file('boot_id'), `${id}\n`),
  };
  set.uptime(opts.uptime ?? 3600);
  set.now(opts.now ?? NOW);
  set.routes(opts.routes ?? GATEWAY_ROUTE);
  set.ping(opts.ping ?? false);
  set.arping(opts.arping ?? false);
  set.kernel(opts.kernel ?? 'nothing to see');
  set.scanFailures(opts.scanFailures ?? 0);
  set.watchdog(opts.watchdog === undefined ? '30s' : opts.watchdog);
  set.boot(BOOT);
  if (opts.dmesg !== undefined) writeFileSync(file('dmesg.log'), `${opts.dmesg}\n`);

  stub('journalctl', `case "$*" in *-k*) cat "${file('kernel.log')}" ;; *) cat "${file('journal.log')}" ;; esac`);
  stub('dmesg', `cat "${file('dmesg.log')}" 2>/dev/null || exit 1`);
  stub('ping', `exit $(cat "${file('ping')}")`);
  stub('arping', `exit $(cat "${file('arping')}")`);
  stub('date', `cat "${file('now')}"`);
  stub('sync', 'exit 0');
  stub('reboot', 'exit 0');
  const units = path.join(dir, 'units');
  mkdirSync(units);
  const setUnits = (states: Record<string, string>) => {
    rmSync(units, { recursive: true, force: true });
    mkdirSync(units);
    for (const [unit, stateName] of Object.entries(states)) writeFileSync(path.join(units, unit), `${stateName}\n`);
  };
  setUnits(opts.units ?? {});
  const runtimeWatchdog = file('runtime-watchdog');
  stub('systemctl', 'if [ "$1" = is-active ]; then shift; '
    + `for u in "$@"; do cat "${units}/$u" 2>/dev/null || echo inactive; done; exit 3; fi\n`
    + `if [ "$1" = show ]; then [ -f "${runtimeWatchdog}" ] && echo "RuntimeWatchdogUSec=$(cat "${runtimeWatchdog}")"; exit 0; fi\n`
    + `case "$*" in *reboot*) [ ! -f "${file('reboot-fails')}" ] || exit 1 ;; esac\nexit 0`);
  stub('flock', 'exit 0');

  const proc = path.join(dir, 'proc');
  const setProcesses = (extra: string[][]) => {
    rmSync(proc, { recursive: true, force: true });
    mkdirSync(proc);
    [['/bin/bash', '/home/dac/free-sleep/scripts/network_watchdog.sh'], ['node', 'dist/server.js'], ...extra].forEach((argv, i) => {
      mkdirSync(path.join(proc, String(100 + i)));
      writeFileSync(path.join(proc, String(100 + i), 'cmdline'), `${argv.join('\0')}\0`);
    });
  };
  setProcesses(opts.processes ?? []);

  const lock = file('operation.lock');
  writeFileSync(lock, '');
  const locks = file('locks');
  const holder = opts.lockHeld ? `1: FLOCK  ADVISORY  WRITE 4242 ${lockKey(lock)} 0 EOF\n` : '';
  writeFileSync(locks, `2: FLOCK  ADVISORY  WRITE 99 08:01:1 0 EOF\n${holder}`);

  const state = opts.stateDirMissing ? path.join(dir, 'missing', 'network-watchdog') : file('network-watchdog');
  if (opts.state !== undefined) writeFileSync(state, opts.state);

  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NIGHTSTAND_NETWATCH_STATE: state,
    NIGHTSTAND_NETWATCH_MODULE: module,
    NIGHTSTAND_ROUTES: file('routes'),
    NIGHTSTAND_BOOT_ID: file('boot_id'),
    NIGHTSTAND_UPTIME: file('uptime'),
    NIGHTSTAND_PROC: proc,
    NIGHTSTAND_OPERATION_LOCK: lock,
    NIGHTSTAND_PROC_LOCKS: locks,
    ...extra,
  });
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT, ...args], { env: env(extra), encoding: 'utf8' });
  // Runs the check every `step` minutes from the current uptime up to
  // `count` minutes later, as the timer would. Returns the output of every run.
  const minutes = (count: number, step = 1) => {
    let out = '';
    const start = Number(readFileSync(file('uptime'), 'utf8').split('.')[0]);
    const startNow = Number(readFileSync(file('now'), 'utf8'));
    for (let i = 0; i <= count; i += step) {
      set.uptime(start + i * 60);
      set.now(startNow + i * 60);
      const r = run();
      out += r.stdout + r.stderr;
    }
    return out;
  };
  const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const readState = () => (existsSync(state) ? readFileSync(state, 'utf8') : '');
  const failReboot = () => writeFileSync(file('reboot-fails'), '');
  const writeState = (text: string) => writeFileSync(state, text);
  return {
    run, minutes, log, set, setUnits, setProcesses, failReboot, state, readState, writeState,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// The network has been down since boot, an hour before the default uptime.
const DOWN_AN_HOUR = `boot=${BOOT}\ndown_since=0\nscan_failing_since=\nrestarts=\nlast_restart=\n`;

const rebooted = (log: string) => /^systemctl .*reboot/m.test(log);
const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, 'g'))?.length ?? 0;

describe('network_watchdog.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
    assert.ok(statSync(SCRIPT).mode & 0o111, 'network_watchdog.sh must carry the exec bit');
  });

  it('exits at once where the Wi-Fi driver it watches is not loaded', () => {
    const t = pod({ driver: false, kernel: WLAN_OOPS, scanFailures: 6 });
    t.minutes(30, 5);
    assert.equal(t.log(), '', 'no journal, ping or systemctl call on other hardware');
    assert.equal(t.readState(), '');
    t.cleanup();
  });

  it('does nothing while the gateway answers, without reading the journal', () => {
    const t = pod({ ping: true, kernel: WLAN_OOPS, scanFailures: 6 });
    t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    assert.doesNotMatch(t.log(), /journalctl/);
    assert.equal(t.readState(), '', 'a healthy network writes nothing to flash');
    assert.match(t.log(), /^ping .*192\.168\.1\.1/m, 'pings the default gateway from the route table');
    t.cleanup();
  });

  it('counts an answer to arping as a working network', () => {
    const t = pod({ arping: true, kernel: WLAN_OOPS });
    t.minutes(10);
    assert.equal(rebooted(t.log()), false);
    assert.match(t.log(), /^arping .*-I wlan0 .*192\.168\.1\.1/m);
    t.cleanup();
  });

  it('restarts after a driver crash once the network has been down for 5 minutes', () => {
    const t = pod({ kernel: WLAN_OOPS });
    t.minutes(4);
    assert.equal(rebooted(t.log()), false, 'not before 5 minutes');
    const out = t.minutes(1);
    assert.equal(rebooted(t.log()), true);
    assert.match(t.log(), /^journalctl --sync$/m);
    assert.match(t.log(), /^sync/m);
    assert.match(t.log(), /^systemctl --no-block reboot$/m);
    assert.doesNotMatch(t.log(), /^reboot/m);
    assert.match(out, /Network watchdog: restarting the Pod: the Wi-Fi driver crashed this boot and the network has been down for 5 minutes/);
    const state = t.readState();
    assert.match(state, new RegExp(`^restarts=${NOW + 300},${BOOT}$`, 'm'));
    assert.match(state, new RegExp(`^last_restart=${NOW + 300} the Wi-Fi driver crashed`, 'm'));
    const calls = t.log();
    assert.ok(calls.indexOf('journalctl --sync') < calls.indexOf('\nsync'), 'the journal is flushed, then the disks');
    assert.ok(calls.indexOf('\nsync') < calls.indexOf('--no-block reboot'), 'sync before the reboot');
    t.cleanup();
  });

  it('counts a missing default route as no network', () => {
    const t = pod({ kernel: WLAN_OOPS, routes: NO_DEFAULT_ROUTE });
    t.minutes(5);
    assert.equal(rebooted(t.log()), true);
    assert.doesNotMatch(t.log(), /^ping/m);
    t.cleanup();
  });

  it('only counts a crash whose trace runs through the Wi-Fi driver', () => {
    for (const kernel of [OTHER_OOPS, WLAN_WARNING]) {
      const t = pod({ kernel });
      t.minutes(19, 3);
      assert.equal(rebooted(t.log()), false, kernel.split('\n')[0]);
      t.cleanup();
    }
  });

  it('matches the crash as the Pod logged it, with or without its end line or journal prefix', () => {
    for (const kernel of [WLAN_OOPS, WLAN_OOPS_ENDED, WLAN_OOPS_SHORT_ISO]) {
      const t = pod({ kernel, state: DOWN_AN_HOUR });
      t.run();
      assert.equal(rebooted(t.log()), true, kernel.split('\n').length.toString());
      t.cleanup();
    }
    const header = pod({ kernel: OOPS_HEAD.join('\n'), state: DOWN_AN_HOUR });
    header.run();
    assert.equal(rebooted(header.log()), false, 'the header and the module list alone do not count');
    header.cleanup();
  });

  it('a crash elsewhere that lost its end line does not make a later driver warning count', () => {
    const kernel = OTHER_OOPS.replace(/\n---\[ end trace[^\n]*/, '') + '\n' + WLAN_WARNING;
    const t = pod({ kernel, state: DOWN_AN_HOUR });
    t.run();
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('reads dmesg when the journal holds no kernel lines', () => {
    const dmesg = WLAN_OOPS.split('\n').map((line, i) => `[ 7012.${String(100000 + i).slice(1)}] ${line}`).join('\n');
    const t = pod({ kernel: '', dmesg, state: DOWN_AN_HOUR });
    t.run();
    assert.equal(rebooted(t.log()), true);
    assert.match(t.log(), /^dmesg/m);
    t.cleanup();
  });

  it('restarts after 20 minutes down with scans failing the whole time', () => {
    const t = pod({ scanFailures: 6 });
    t.minutes(19);
    assert.equal(rebooted(t.log()), false, 'not before 20 minutes');
    const out = t.minutes(1);
    assert.equal(rebooted(t.log()), true);
    assert.match(out, /restarting the Pod: Wi-Fi scans have failed and the network has been down for 20 minutes/);
    t.cleanup();
  });

  it('starts the 20 minutes over when scans work again', () => {
    const t = pod({ scanFailures: 6 });
    t.minutes(15);
    t.set.scanFailures(0);
    t.minutes(1);
    t.set.scanFailures(6);
    t.minutes(10);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('counts the Pod\'s own scan failure lines, with or without the journal prefix', () => {
    for (const lines of [POD_SCANS, POD_SCANS.map(message)]) {
      const t = pod({ state: `boot=${BOOT}\ndown_since=0\nscan_failing_since=0\n` });
      writeFileSync(path.join(path.dirname(t.state), 'journal.log'), `${lines.join('\n')}\n`);
      const r = t.run(['--dry-run']);
      assert.match(r.stdout, /^scan failures in the last 3 minutes: 3$/m);
      t.run();
      assert.equal(rebooted(t.log()), true, lines[0]);
      t.cleanup();
    }
  });

  it('never counts the routine router solicitation warning', () => {
    for (const lines of [POD_NDISC, POD_NDISC.map(message)]) {
      const t = pod();
      writeFileSync(path.join(path.dirname(t.state), 'journal.log'), `${lines.join('\n')}\n`.repeat(6));
      t.set.kernel(lines.join('\n'));
      t.minutes(40, 5);
      assert.equal(rebooted(t.log()), false);
      assert.match(t.run(['--dry-run']).stdout, /^driver crash this boot: no$/m);
      t.cleanup();
    }
  });

  it('only counts the failure code the dead driver gives', () => {
    // EBUSY (-16) is an ordinary busy driver turning down a scan.
    const t = pod();
    t.set.scanFailures(6, '-16');
    t.minutes(40, 5);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('occasional scan failures do not count', () => {
    // A busy driver can turn down a scan now and then.
    const t = pod({ scanFailures: 2 });
    t.minutes(40, 5);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('never restarts for a router that is away while scans work', () => {
    const t = pod();
    const out = t.minutes(90, 10);
    assert.equal(rebooted(t.log()), false);
    assert.match(out, /Network watchdog: the network is down \(gateway 192\.168\.1\.1 did not answer\)/);
    assert.equal(out.match(/the network is down/g)?.length, 1, 'logs the outage once, not every minute');
    t.set.ping(true);
    const back = t.minutes(0);
    assert.match(back, /the network is back after 90 minutes/);
    assert.doesNotMatch(t.readState(), /^down_since=\d/m);
    t.cleanup();
  });

  it('forgets an outage seen in an earlier boot', () => {
    const t = pod({ kernel: WLAN_OOPS, uptime: 700,
      state: 'boot=bbbbbbbb-0000-4000-8000-000000000002\ndown_since=100\nscan_failing_since=100\nrestarts=\nlast_restart=\n' });
    t.minutes(4);
    assert.equal(rebooted(t.log()), false);
    t.minutes(1);
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('does nothing in the first 10 minutes after boot', () => {
    const t = pod({ kernel: WLAN_OOPS, scanFailures: 6, uptime: 0 });
    t.minutes(9);
    assert.equal(t.log(), '', 'no checks at all during boot');
    assert.equal(t.readState(), '');
    t.cleanup();

    const settled = pod({ kernel: WLAN_OOPS, uptime: 600 });
    settled.minutes(5);
    assert.equal(rebooted(settled.log()), true);
    settled.cleanup();
  });

  it('waits while an update, rollback or switch holds the lock', () => {
    const t = pod({ kernel: WLAN_OOPS, lockHeld: true });
    const out = t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    assert.match(out, /would restart the Pod \(the Wi-Fi driver crashed.*\), but an update, rollback or switch is running; waiting/);
    t.cleanup();
  });

  it('waits while an operation unit is running', () => {
    const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR });
    for (const unit of ['free-sleep-update.service', 'free-sleep-rollback.service', 'free-sleep-revert.service',
      'free-sleep-migrate.service']) {
      for (const stateName of ['active', 'activating']) {
        t.setUnits({ [unit]: stateName });
        t.writeState(DOWN_AN_HOUR);
        const out = t.run().stdout;
        assert.equal(rebooted(t.log()), false, `${unit} ${stateName}`);
        assert.match(out, new RegExp(`${unit.replace(/\./g, '\\.')} is running; waiting`));
      }
    }
    t.setUnits({ 'free-sleep-update.service': 'failed' });
    t.run();
    assert.equal(rebooted(t.log()), true, 'a failed operation does not block');
    t.cleanup();
  });

  it('waits while an install, reset or biometrics install is running', () => {
    const running = [
      ['bash', 'install.sh'],
      ['/bin/bash', '-c', '#!/bin/bash\nset -euo pipefail\nMIN_INSTALL_VERSION="3.6.0"\n'],
      ['/bin/bash', '/home/dac/free-sleep/scripts/reset.sh'],
      ['bash', '/home/dac/free-sleep/scripts/reset_db.sh'],
      ['/bin/sh', '/home/dac/free-sleep/scripts/enable_biometrics.sh'],
      ['sh', '/home/dac/free-sleep/scripts/install_python_packages.sh'],
      ['sh', '/home/dac/free-sleep/scripts/setup_python.sh'],
      ['/bin/bash', '/home/dac/free-sleep/scripts/update_service.sh'],
      ['bash', '/home/dac/free-sleep/scripts/switch-to-upstream.sh'],
      ['bash', '/home/dac/free-sleep/scripts/revert-to-stock.sh'],
      ['bash', '/usr/local/lib/nightstand/migrate/pod-installer.sh'],
      ['bash', '/usr/local/lib/nightstand/migrate/agent-bootstrap-installer.sh'],
      ['/bin/bash', '/usr/local/lib/nightstand/restore-original-fork.sh', '--sentinel'],
      ['/bin/bash', '/usr/local/lib/nightstand/live/scripts/update_service.sh'],
    ];
    const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR });
    for (const argv of running) {
      t.setProcesses([argv]);
      t.writeState(DOWN_AN_HOUR);
      const out = t.run().stdout;
      assert.equal(rebooted(t.log()), false, argv.join(' '));
      assert.match(out, /an install, reset or biometrics install is running; waiting/, argv.join(' '));
    }
    // Names that only look similar do not block.
    t.setProcesses([['vi', '/home/dac/notes-reset.sh.txt'], ['tail', '-f', 'free-sleep-update.log']]);
    t.run();
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('waits unless the hardware watchdog is on', () => {
    // A restart after this crash can hang. Only the hardware watchdog
    // resets a Pod whose shutdown hangs.
    for (const value of ['0', '0s', 'infinity', '', null]) {
      const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR, watchdog: value });
      const out = t.run().stdout;
      assert.equal(rebooted(t.log()), false, String(value));
      assert.match(out, /but the hardware watchdog is off; waiting/, String(value));
      const dry = t.run(['--dry-run']).stdout;
      assert.match(dry, /^hardware watchdog: off/m);
      assert.match(dry, /^decision: would wait: .*, but the hardware watchdog is off/m);
      t.cleanup();
    }
    const on = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR, watchdog: '30s' });
    assert.match(on.run(['--dry-run']).stdout, /^hardware watchdog: on \(30s\)/m);
    on.run();
    assert.equal(rebooted(on.log()), true);
    on.cleanup();
  });

  it('logs a wait when it starts, when its reason changes and every 30 minutes', () => {
    const t = pod({ kernel: WLAN_OOPS, lockHeld: true, state: DOWN_AN_HOUR });
    const out = t.minutes(60, 10);
    assert.equal(count(out, /; waiting/), 3, out);
    t.set.watchdog('0');
    const changed = t.minutes(0);
    assert.equal(count(changed, /; waiting/), 0, 'the lock still comes first');
    t.cleanup();

    const u = pod({ kernel: WLAN_OOPS, lockHeld: false, state: DOWN_AN_HOUR, units: { 'free-sleep-update.service': 'active' } });
    u.minutes(5);
    u.setUnits({ 'free-sleep-revert.service': 'active' });
    const next = u.minutes(0);
    assert.match(next, /free-sleep-revert\.service is running; waiting/);
    u.cleanup();
  });

  it('reads a ping error as no answer it can judge', () => {
    // ping exits 2 when it could not send at all, for example when a
    // firewall refuses the gateway's address. That says nothing about Wi-Fi.
    const t = pod({ scanFailures: 6, state: `boot=${BOOT}\ndown_since=0\nscan_failing_since=0\n` });
    t.set.pingStatus(2);
    // arping missing, as on a Pod without it.
    writeFileSync(path.join(path.dirname(t.state), 'arping'), '127');
    t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    assert.match(t.run(['--dry-run']).stdout, /^network: unknown \(neither ping nor arping could run: 2, 127\)/m);
    // arping still answers the question: no reply from the gateway is down.
    writeFileSync(path.join(path.dirname(t.state), 'arping'), '1');
    assert.match(t.run(['--dry-run']).stdout, /^network: down/m);
    t.cleanup();
  });

  it('counts a network it cannot check as down after a driver crash', () => {
    // A dead driver can make the probes fail outright rather than go
    // unanswered; the crash already says Wi-Fi is gone.
    const t = pod({ kernel: WLAN_OOPS });
    t.set.pingStatus(2);
    writeFileSync(path.join(path.dirname(t.state), 'arping'), '127');
    assert.match(t.run(['--dry-run']).stdout,
      /^network: down \(neither ping nor arping could run: 2, 127, after a Wi-Fi driver crash this boot\)/m);
    t.minutes(4);
    assert.equal(rebooted(t.log()), false);
    t.minutes(1);
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('logs a wait again when the rule behind it changes', () => {
    const t = pod({ lockHeld: true, scanFailures: 6, state: `boot=${BOOT}\ndown_since=0\nscan_failing_since=0\n` });
    const first = t.minutes(5);
    assert.equal(count(first, /; waiting/), 1);
    assert.match(first, /Wi-Fi scans have failed/);
    t.set.kernel(WLAN_OOPS);
    const second = t.minutes(0);
    assert.match(second, /the Wi-Fi driver crashed this boot.*; waiting/);
    t.cleanup();
  });

  it('gives up on a probe that hangs', () => {
    const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR });
    writeFileSync(path.join(path.dirname(t.state), 'bin', 'ping'), '#!/bin/sh\nsleep 30\n');
    const started = Date.now();
    const r = t.run(['--dry-run'], { NIGHTSTAND_NETWATCH_PROBE_SECONDS: '1' });
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.match(r.stdout, /^network: down/m);
    t.cleanup();
  });

  it('logs a restart request that failed', () => {
    const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR });
    t.failReboot();
    const out = t.run().stdout;
    assert.match(out, /restarting the Pod/);
    assert.match(out, /the restart request failed/);
    assert.doesNotMatch(t.log(), /^reboot/m);
    t.cleanup();
  });

  it('never follows a link planted where it writes', () => {
    const t = pod({ kernel: WLAN_OOPS, state: DOWN_AN_HOUR });
    const target = path.join(path.dirname(t.state), 'elsewhere');
    writeFileSync(target, 'keep\n');
    symlinkSync(target, `${t.state}.tmp`);
    t.run();
    assert.equal(readFileSync(target, 'utf8'), 'keep\n');
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('restarts at most once in 6 hours', () => {
    const recent = `restarts=${NOW - 5 * 3600},bbbbbbbb-0000-4000-8000-000000000002\n`;
    const t = pod({ kernel: WLAN_OOPS, state: recent });
    const out = t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    assert.match(out, /but the Pod was restarted for this 305 minutes ago; waiting/);
    t.cleanup();

    const older = `restarts=${NOW - 6 * 3600},bbbbbbbb-0000-4000-8000-000000000002\n`;
    const later = pod({ kernel: WLAN_OOPS, state: older });
    later.minutes(5);
    assert.equal(rebooted(later.log()), true);
    assert.match(later.readState(), new RegExp(`^restarts=${NOW - 6 * 3600},bbbbbbbb\\S* ${NOW + 300},${BOOT}$`, 'm'));
    later.cleanup();
  });

  it('restarts at most 3 times in 24 hours, and forgets older ones', () => {
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    const three = `restarts=${NOW - 20 * 3600},${other} ${NOW - 13 * 3600},${other} ${NOW - 7 * 3600},${other}\n`;
    const t = pod({ kernel: WLAN_OOPS, state: three });
    const out = t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    assert.match(out, /but the Pod was already restarted for this 3 times in 24 hours; waiting/);
    t.cleanup();

    const aged = `restarts=${NOW - 25 * 3600},${other} ${NOW - 13 * 3600},${other} ${NOW - 7 * 3600},${other}\n`;
    const later = pod({ kernel: WLAN_OOPS, state: aged });
    later.minutes(5);
    assert.equal(rebooted(later.log()), true);
    assert.doesNotMatch(later.readState(), new RegExp(String(NOW - 25 * 3600)), 'restarts older than a day are dropped');
    later.cleanup();
  });

  it('still keeps the 6 hours when the clock is wrong after a restart', () => {
    // Before the clock is set from the network it can read years behind.
    // The last restart was before this boot, so at least the uptime passed.
    const last = `restarts=${NOW},bbbbbbbb-0000-4000-8000-000000000002\n`;
    const early = pod({ kernel: WLAN_OOPS, now: 1_300_000_000, uptime: 3600, state: last });
    early.minutes(10, 5);
    assert.equal(rebooted(early.log()), false);
    early.cleanup();

    const late = pod({ kernel: WLAN_OOPS, now: 1_300_000_000, uptime: 6 * 3600, state: last });
    late.minutes(5);
    assert.equal(rebooted(late.log()), true);
    late.cleanup();
  });

  it('does not restart when it cannot record the restart', () => {
    const t = pod({ kernel: WLAN_OOPS, stateDirMissing: true });
    t.minutes(30, 5);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('ignores unreadable state', () => {
    const t = pod({ kernel: WLAN_OOPS, state: 'restarts=garbage soup\ndown_since=x\n\0\0' });
    t.minutes(5);
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('ignores numbers with a leading zero instead of failing on them', () => {
    // Shell arithmetic reads 0900 as a bad octal number and stops.
    const t = pod({ kernel: WLAN_OOPS, state: `boot=${BOOT}\ndown_since=0900\nscan_failing_since=0900\nrestarts=0900,${BOOT}\n` });
    const first = t.run();
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr, /value too great|syntax error/);
    assert.equal(rebooted(t.log()), false, 'a fresh outage starts at this check');
    t.minutes(5);
    assert.equal(rebooted(t.log()), true);
    t.cleanup();
  });

  it('--dry-run prints the decision and its inputs, and changes nothing', () => {
    const healthy = pod({ ping: true });
    const ok = healthy.run(['--dry-run']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^network: up/m);
    assert.match(ok.stdout, /^driver crash this boot: no/m);
    assert.match(ok.stdout, /^hardware watchdog: on \(30s\)/m);
    assert.match(ok.stdout, /^decision: no action/m);
    assert.equal(healthy.readState(), '');
    healthy.cleanup();

    const t = pod({ kernel: WLAN_OOPS, scanFailures: 6, state: `boot=${BOOT}\ndown_since=0\nscan_failing_since=0\nrestarts=\nlast_restart=\n` });
    const before = t.readState();
    const r = t.run(['--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^network: down \(gateway 192\.168\.1\.1 did not answer\)/m);
    assert.match(r.stdout, /^driver crash this boot: yes/m);
    assert.match(r.stdout, /^scan failures in the last 3 minutes: 6/m);
    assert.match(r.stdout, /^down for: 3600 s/m);
    assert.match(r.stdout, /^decision: would restart the Pod: the Wi-Fi driver crashed/m);
    assert.equal(rebooted(t.log()), false);
    assert.doesNotMatch(t.log(), /^sync/m);
    assert.equal(t.readState(), before, 'a dry run writes nothing');
    t.cleanup();
  });

  it('--dry-run reports what would block a restart', () => {
    const t = pod({ kernel: WLAN_OOPS, lockHeld: true, state: `boot=${BOOT}\ndown_since=0\n` });
    const r = t.run(['--dry-run']);
    assert.match(r.stdout, /^decision: would wait: the Wi-Fi driver crashed.*, but an update, rollback or switch is running/m);
    t.cleanup();
  });

  it('--dry-run takes injected inputs, so the owner can try it on a healthy Pod', () => {
    const t = pod({ ping: true });
    const inject = { NIGHTSTAND_NETWATCH_NETWORK: 'down', NIGHTSTAND_NETWATCH_OOPS: 'yes', NIGHTSTAND_NETWATCH_DOWN_FOR: '600' };
    const r = t.run(['--dry-run'], inject);
    assert.match(r.stdout, /^network: down \(injected\)/m);
    assert.match(r.stdout, /^decision: would restart the Pod: the Wi-Fi driver crashed this boot and the network has been down for 10 minutes/m);
    assert.equal(rebooted(t.log()), false);
    assert.equal(t.readState(), '');

    const scans = t.run(['--dry-run'], {
      NIGHTSTAND_NETWATCH_NETWORK: 'down', NIGHTSTAND_NETWATCH_SCAN_FAILING_FOR: '1200', NIGHTSTAND_NETWATCH_DOWN_FOR: '1200',
    });
    assert.match(scans.stdout, /^decision: would restart the Pod: Wi-Fi scans have failed/m);

    // Outside a dry run the injected inputs are ignored.
    t.minutes(10, 5);
    for (let i = 0; i < 3; i++) t.run([], inject);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('rejects unknown arguments', () => {
    const t = pod({ kernel: WLAN_OOPS });
    const r = t.run(['--now']);
    assert.equal(r.status, 2);
    assert.equal(rebooted(t.log()), false);
    t.cleanup();
  });

  it('touches nothing but its own state, the journal and the gateway', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(src, /iptables|sshd|dropbear|\/opt\/eight|frank|capybara/i);
    assert.match(src, /^if \[ -z "\$\{BASH_VERSION:-\}" \]; then exec bash "\$0" "\$@"; fi$/m, 'bash re-exec guard');
    // The restart line is logged and flushed before the disks are synced.
    const say = src.indexOf('say "restarting the Pod');
    assert.ok(say > 0 && say < src.indexOf('journalctl --sync') && src.indexOf('journalctl --sync') < src.lastIndexOf('\nsync'));
    assert.doesNotMatch(src, /find [^\n]*-printf/);
  });
});

describe('free-sleep-network-watchdog units', () => {
  const read = (name: string) => readFileSync(path.join(repoRoot, 'scripts/systemd', name), 'utf8');

  it('the service is a no-op on a tree without the script', () => {
    // A rollback to an older release keeps the units but not the script.
    const src = read('free-sleep-network-watchdog.service');
    assert.match(src, /Type=oneshot/);
    assert.match(src, /\[ -f \/usr\/local\/lib\/nightstand\/live\/scripts\/network_watchdog\.sh \] \|\| exit 0/);
    assert.match(src, /exec \/bin\/bash \/usr\/local\/lib\/nightstand\/live\/scripts\/network_watchdog\.sh/);
    assert.match(src, /User=root/);
  });

  it('the timer runs every minute and starts after the boot grace', () => {
    const src = read('free-sleep-network-watchdog.timer');
    assert.match(src, /OnBootSec=10min/);
    assert.match(src, /OnUnitActiveSec=1min/);
    assert.match(src, /WantedBy=timers\.target/);
  });

  it('install.sh still carries the line the check recognizes it by when run from curl', () => {
    assert.match(readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8'), /^MIN_INSTALL_VERSION=/m);
  });
});
