import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/boot_slot.sh');

// A fake U-Boot environment in a file, read by fake fw_printenv -n and written by fake fw_setenv.
function box(cmdline: string, env: Record<string, string>, setFails = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-slot-'));
  const store = path.join(dir, 'env');
  const writes = path.join(dir, 'writes');
  writeFileSync(store, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  writeFileSync(path.join(dir, 'cmdline'), cmdline);
  const printenv = path.join(dir, 'fw_printenv');
  writeFileSync(printenv, `#!/bin/sh\n[ "$1" = -n ] && sed -n "s/^$2=//p" "${store}"\n`);
  const setenv = path.join(dir, 'fw_setenv');
  writeFileSync(setenv, setFails ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\necho "$@" >> "${writes}"\n`
      + `grep -v "^$1=" "${store}" > "${store}.new"; echo "$1=$2" >> "${store}.new"; mv "${store}.new" "${store}"\n`);
  chmodSync(printenv, 0o755);
  chmodSync(setenv, 0o755);
  const run = (arg: string) => spawnSync('bash', [SCRIPT, arg], {
    env: { ...process.env, NIGHTSTAND_PROC_CMDLINE: path.join(dir, 'cmdline'), NIGHTSTAND_FW_PRINTENV: printenv, NIGHTSTAND_FW_SETENV: setenv },
    encoding: 'utf8',
  });
  return { run, writes: () => (existsSync(writes) ? readFileSync(writes, 'utf8') : '') };
}

const SLOT_B = 'console=ttyS0 root=PARTLABEL=rootfs_b rootwait ro\n';

describe('boot_slot.sh', () => {
  it('parses and carries the exec bit', () => {
    assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0);
    assert.ok(statSync(SCRIPT).mode & 0o111);
  });

  it('marks only the running slot when it is not marked', () => {
    const t = box(SLOT_B, { boot_a_success: '1', boot_b_success: '0', retry_boot_b: '3' });
    assert.match(t.run('status').stdout, /slot b, not marked good .*3 boots left/);
    const result = t.run('confirm');
    assert.equal(result.status, 0);
    assert.equal(t.writes(), 'boot_b_success 1\n');
    assert.match(result.stdout, /slot b is now marked good/);
  });

  it('writes nothing when the running slot is already marked', () => {
    const t = box(SLOT_B, { boot_b_success: '1' });
    assert.equal(t.run('confirm').status, 0);
    assert.equal(t.writes(), '');
  });

  it('writes nothing when the running slot cannot be told', () => {
    const t = box('console=ttyS0 root=/dev/mmcblk0p5 rootwait\n', { boot_a_success: '0', boot_b_success: '0' });
    assert.equal(t.run('confirm').status, 2);
    assert.equal(t.writes(), '');
  });

  it('reports a failed write', () => {
    const t = box(SLOT_B, { boot_b_success: '0' }, true);
    const result = t.run('confirm');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /could not mark slot b/);
  });
});

describe('boot_slot.sh other slot access', () => {
  const STOCK_SHADOW = 'root:*:1:0:99999:7:::\nrewt:$6$stock$abc:1:0:99999:7:::\ndac:!:1:0:99999:7:::\n';
  function slots(keys = 'ssh-ed25519 AAAAtest me\n') {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-other-'));
    const thisRoot = path.join(dir, 'a');
    const otherRoot = path.join(dir, 'b');
    for (const d of ['etc/ssh', 'home/root/ssh']) mkdirSync(path.join(thisRoot, d), { recursive: true });
    for (const d of ['etc/ssh', 'etc/systemd/system', 'etc/iptables', 'lib/systemd/system', 'etc/sudoers.d']) {
      mkdirSync(path.join(otherRoot, d), { recursive: true });
    }
    // The stock pieces other-access checks for before it changes anything.
    writeFileSync(path.join(otherRoot, 'lib/systemd/system/iptables.service'),
      'ExecStart=/usr/sbin/iptables-restore -w -- /etc/iptables/iptables.rules\n');
    writeFileSync(path.join(otherRoot, 'lib/systemd/system/ip6tables.service'),
      'ExecStart=/usr/sbin/ip6tables-restore -w -- /etc/iptables/ip6tables.rules\n');
    writeFileSync(path.join(otherRoot, 'lib/systemd/system/swupdate.service'), '[Service]\n');
    writeFileSync(path.join(otherRoot, 'etc/ssh/sshd_config'),
      'Port 8822\nAuthorizedKeysFile\t/etc/ssh/authorized_keys .ssh/authorized_keys\nAllowUsers rewt\n');
    writeFileSync(path.join(otherRoot, 'etc/sudoers.d/50-rewt'), 'rewt ALL=(ALL) ALL\n');
    writeFileSync(path.join(otherRoot, 'etc/iptables/iptables.rules'), '');
    writeFileSync(path.join(otherRoot, 'etc/iptables/ip6tables.rules'), '');
    writeFileSync(path.join(thisRoot, 'etc/ssh/sshd_config'), 'Port 8822\nAuthorizedKeysFile /home/root/ssh/authorized_keys\n');
    writeFileSync(path.join(thisRoot, 'home/root/ssh/authorized_keys'), keys);
    writeFileSync(path.join(thisRoot, 'etc/shadow'), 'root:$6$mine$root:1:0:99999:7:::\nrewt:$6$mine$rewt:1:0:99999:7:::\n');
    writeFileSync(path.join(otherRoot, 'etc/shadow'), STOCK_SHADOW);
    const saved = path.join(dir, 'saved');
    const run = (arg: string, extra: Record<string, string> = {}) => spawnSync('bash', [SCRIPT, arg], {
      env: { ...process.env, NIGHTSTAND_THIS_ROOT: thisRoot, NIGHTSTAND_OTHER_ROOT: otherRoot, NIGHTSTAND_OTHER_SLOT_SAVED: saved, ...extra },
      encoding: 'utf8',
    });
    return { run, otherRoot, saved };
  }
  const read = (file: string) => readFileSync(file, 'utf8');
  const masks = ['swupdate.service', 'swupdate.socket', 'swupdate-progress.service'];

  it('copies the keys and rewt password, switches the updater off, and undo puts back the stock files', () => {
    const t = slots();
    assert.equal(t.run('other-status').status, 1);
    const prepared = t.run('other-access');
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.equal(read(path.join(t.otherRoot, 'etc/ssh/authorized_keys')), 'ssh-ed25519 AAAAtest me\n');
    assert.equal(statSync(path.join(t.otherRoot, 'etc/ssh/authorized_keys')).mode & 0o777, 0o644);
    assert.match(read(path.join(t.otherRoot, 'etc/shadow')), /^rewt:\$6\$mine\$rewt:1:0/m);
    assert.match(read(path.join(t.otherRoot, 'etc/shadow')), /^root:\*:1:0/m, 'root is left alone');
    for (const unit of masks) assert.equal(readlinkSync(path.join(t.otherRoot, 'etc/systemd/system', unit)), '/dev/null');
    const v4 = read(path.join(t.otherRoot, 'etc/iptables/iptables.rules'));
    assert.match(v4, /^:OUTPUT DROP/m);
    assert.match(v4, /^-A OUTPUT -d 192\.168\.0\.0\/16 -j ACCEPT$/m);
    assert.match(v4, /^-A OUTPUT -j REJECT\nCOMMIT$/m);
    assert.match(read(path.join(t.otherRoot, 'etc/iptables/ip6tables.rules')), /^-A OUTPUT -d fe80::\/10 -j ACCEPT$/m);
    const status = t.run('other-status');
    assert.equal(status.status, 0);
    assert.match(status.stdout, /internet blocked/);
    // A second run keeps the stock originals saved the first time.
    assert.equal(t.run('other-access').status, 0);
    assert.equal(read(path.join(t.saved, 'shadow')), STOCK_SHADOW);

    assert.equal(t.run('other-undo').status, 0);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
    assert.equal(existsSync(path.join(t.otherRoot, 'etc/ssh/authorized_keys')), false);
    for (const unit of masks) assert.equal(existsSync(path.join(t.otherRoot, 'etc/systemd/system', unit)), false);
    assert.equal(read(path.join(t.otherRoot, 'etc/iptables/iptables.rules')), '');
    assert.equal(read(path.join(t.otherRoot, 'etc/iptables/ip6tables.rules')), '');
    assert.equal(existsSync(t.saved), false);
  });

  it('refuses a locked rewt password on this slot, since sudo would not work there', () => {
    const t = slots();
    writeFileSync(path.join(path.dirname(t.otherRoot), 'a/etc/shadow'), 'rewt:!:1:0:99999:7:::\n');
    assert.equal(t.run('other-access').status, 2);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
  });

  it('refuses when the other slot already overrides an updater unit it would not restore', () => {
    const t = slots();
    writeFileSync(path.join(t.otherRoot, 'etc/systemd/system/swupdate.service'), '[Service]\n');
    assert.equal(t.run('other-access').status, 2);
    assert.equal(existsSync(t.saved), false);
  });

  it('saves again after an incomplete save, and undo refuses an incomplete save', () => {
    const t = slots();
    mkdirSync(t.saved);
    assert.equal(t.run('other-undo').status, 1);
    assert.equal(t.run('other-access').status, 0);
    assert.equal(read(path.join(t.saved, 'shadow')), STOCK_SHADOW);
    assert.equal(t.run('other-undo').status, 0);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
  });

  it('saves the stock firewall rules on a re-run for a slot prepared before the firewall step', () => {
    const t = slots();
    writeFileSync(path.join(t.otherRoot, 'etc/iptables/iptables.rules'), '# stock\n');
    assert.equal(t.run('other-access').status, 0);
    rmSync(path.join(t.saved, 'iptables.rules'));
    writeFileSync(path.join(t.otherRoot, 'etc/iptables/iptables.rules'), '# stock\n');
    assert.equal(t.run('other-access').status, 0);
    assert.equal(read(path.join(t.saved, 'iptables.rules')), '# stock\n');
    assert.equal(t.run('other-undo').status, 0);
    assert.equal(read(path.join(t.otherRoot, 'etc/iptables/iptables.rules')), '# stock\n');
  });

  it('ignores the test folders under sudo', () => {
    const t = slots();
    assert.notEqual(t.run('other-access', { SUDO_USER: 'dac' }).status, 0);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
    assert.equal(existsSync(path.join(t.otherRoot, 'etc/ssh/authorized_keys')), false);
    assert.equal(existsSync(t.saved), false);
    assert.equal(t.run('other-access').status, 0);
    t.run('other-undo', { SUDO_USER: 'dac' });
    assert.equal(existsSync(t.saved), true);
    assert.equal(readlinkSync(path.join(t.otherRoot, 'etc/systemd/system/swupdate.service')), '/dev/null');
  });

  it('saves afresh when the other slot has been rewritten stock since the last save', () => {
    const t = slots();
    assert.equal(t.run('other-access').status, 0);
    const NEW_SHADOW = STOCK_SHADOW.replace('$6$stock$abc', '$6$newimage$def');
    writeFileSync(path.join(t.otherRoot, 'etc/shadow'), NEW_SHADOW);
    rmSync(path.join(t.otherRoot, 'etc/ssh/authorized_keys'));
    for (const unit of masks) rmSync(path.join(t.otherRoot, 'etc/systemd/system', unit));
    writeFileSync(path.join(t.otherRoot, 'etc/iptables/iptables.rules'), '# new image\n');
    writeFileSync(path.join(t.otherRoot, 'etc/iptables/ip6tables.rules'), '# new image 6\n');
    assert.equal(t.run('other-access').status, 0);
    assert.equal(read(path.join(t.saved, 'shadow')), NEW_SHADOW);
    assert.equal(t.run('other-undo').status, 0);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), NEW_SHADOW);
    assert.equal(read(path.join(t.otherRoot, 'etc/iptables/iptables.rules')), '# new image\n');
    assert.equal(read(path.join(t.otherRoot, 'etc/iptables/ip6tables.rules')), '# new image 6\n');
  });

  it('refuses a stock slot that lacks what it relies on, naming each piece and changing nothing', () => {
    const t = slots();
    writeFileSync(path.join(t.otherRoot, 'etc/ssh/sshd_config'), 'Port 22\n');
    rmSync(path.join(t.otherRoot, 'lib/systemd/system/iptables.service'));
    const result = t.run('other-access');
    assert.equal(result.status, 2);
    assert.match(result.stdout, /lacks an iptables\.service that loads \/etc\/iptables\/iptables\.rules, SSH on port 8822, SSH keys read from/);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
    assert.equal(existsSync(t.saved), false);
    assert.equal(t.run('other-status').status, 2);
  });

  it('refuses without SSH keys to copy, changing nothing', () => {
    const t = slots('');
    assert.equal(t.run('other-access').status, 2);
    assert.equal(read(path.join(t.otherRoot, 'etc/shadow')), STOCK_SHADOW);
    assert.equal(existsSync(t.saved), false);
  });
});
