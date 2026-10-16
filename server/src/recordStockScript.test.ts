import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-stock-'));
  const root = path.join(dir, 'root');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(root, 'etc/ssh'), { recursive: true });
  mkdirSync(path.join(root, 'etc/systemd'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(root, 'etc/ssh/sshd_config'), 'Port 22\n');
  writeFileSync(path.join(root, 'etc/systemd/timesyncd.conf'), '[Time]\n');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('iptables-save', 'echo "-A OUTPUT -j ACCEPT"');
  stub('ip6tables-save', 'echo "-A OUTPUT -j ACCEPT"');
  stub('systemctl', '[ "$1" = is-enabled ] && echo enabled; exit 0');
  const stock = path.join(dir, 'stock');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_STOCK_DIR: stock, NIGHTSTAND_ROOT: root };
  const run = (what: string) => spawnSync('bash', [path.join(repoRoot, 'scripts/record_stock.sh'), what], {
    env, encoding: 'utf8',
  });
  const runAsync = (what: string) => new Promise<number | null>(resolve => {
    spawn('bash', [path.join(repoRoot, 'scripts/record_stock.sh'), what], { env, stdio: 'ignore' }).on('close', resolve);
  });
  return { dir, root, bin, stock, run, runAsync };
}

describe('record_stock.sh', () => {
  it('saves the originals once and never overwrites them', () => {
    const t = setup();
    t.run('ssh');
    assert.equal(readFileSync(path.join(t.stock, 'sshd_config'), 'utf8'), 'Port 22\n');
    writeFileSync(path.join(t.root, 'etc/ssh/sshd_config'), 'Port 8822\nAllowUsers root rewt\n');
    t.run('ssh');
    assert.equal(readFileSync(path.join(t.stock, 'sshd_config'), 'utf8'), 'Port 22\n');
    assert.ok(existsSync(path.join(t.stock, 'authorized_keys.absent')));
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^sshd_config \S+ original$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('marks a copy taken after Nightstand had already changed it', () => {
    const t = setup();
    writeFileSync(path.join(t.root, 'etc/ssh/sshd_config'), 'Port 8822\nAllowUsers root rewt\n');
    t.run('ssh');
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^sshd_config \S+ after-nightstand$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('records firewall rules, time sync and unit states', () => {
    const t = setup();
    t.run('firewall');
    t.run('units');
    assert.match(readFileSync(path.join(t.stock, 'iptables.rules'), 'utf8'), /OUTPUT -j ACCEPT/);
    assert.equal(readFileSync(path.join(t.stock, 'timesyncd.conf'), 'utf8'), '[Time]\n');
    assert.match(readFileSync(path.join(t.stock, 'unit-states.txt'), 'utf8'), /^swupdate enabled$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('never fails the script that calls it', () => {
    const t = setup();
    chmodSync(t.dir, 0o500);
    assert.equal(t.run('ssh').status, 0);
    chmodSync(t.dir, 0o700);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('marks the firewall as changed when the saved rules file carries the block', () => {
    const t = setup();
    mkdirSync(path.join(t.root, 'etc/iptables'));
    writeFileSync(path.join(t.root, 'etc/iptables/iptables.rules'), '-A OUTPUT -p tcp -m tcp --dport 1337 -j REJECT\n-A OUTPUT -j DROP\n');
    t.run('firewall');
    const recorded = readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8');
    assert.match(recorded, /^iptables\.rules \S+ after-nightstand$/m);
    assert.match(recorded, /^iptables\.rules\.file \S+ after-nightstand$/m);
    assert.ok(existsSync(path.join(t.stock, 'ip6tables.rules.file.absent')));
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('does not call rules original while an update has its download window open', () => {
    const t = setup();
    const windowRule = '-A OUTPUT -p tcp -m tcp --dport 443 -j REJECT --reject-with tcp-reset';
    writeFileSync(path.join(t.dir, 'bin/ip6tables-save'), `#!/bin/sh\necho "${windowRule}"\n`);
    t.run('firewall');
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^iptables\.rules \S+ after-nightstand$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('keeps a unit list saved before step 11 and records it as the original', () => {
    const t = setup();
    mkdirSync(t.stock);
    writeFileSync(path.join(t.stock, 'unit-states.txt'), 'swupdate disabled\n');
    t.run('units');
    t.run('units');
    assert.equal(readFileSync(path.join(t.stock, 'unit-states.txt'), 'utf8'), 'swupdate disabled\n');
    assert.deepEqual(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8').trim().split('\n').map(line => line.replace(/ \S+ /, ' ')),
      ['unit-states.txt original']);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('writes one state per unit, unknown when systemctl says nothing', () => {
    const t = setup();
    writeFileSync(path.join(t.dir, 'bin/systemctl'), '#!/bin/sh\n[ "$2" = dac ] && { echo masked; exit 1; }\nexit 1\n');
    t.run('units');
    const lines = readFileSync(path.join(t.stock, 'unit-states.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 9);
    assert.ok(lines.includes('dac masked'));
    assert.ok(lines.includes('swupdate unknown'));
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('calls systemd\'s stock time sync file original, with its commented fallback servers', () => {
    const t = setup();
    writeFileSync(path.join(t.root, 'etc/systemd/timesyncd.conf'), [
      '#  This file is part of systemd.', '[Time]', '#NTP=',
      '#FallbackNTP=time1.google.com time2.google.com time3.google.com time4.google.com',
      '#RootDistanceMaxSec=5', '#PollIntervalMinSec=32', '#PollIntervalMaxSec=2048', '',
    ].join('\n'));
    t.run('firewall');
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^timesyncd\.conf \S+ original$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('calls the time sync file the block script writes after-nightstand', () => {
    const t = setup();
    const block = readFileSync(path.join(repoRoot, 'scripts/block_internet_access.sh'), 'utf8');
    const written = /cat > \/etc\/systemd\/timesyncd\.conf <<EOF\n([\s\S]*?)\nEOF\n/.exec(block);
    assert.ok(written, 'the block script no longer writes timesyncd.conf this way');
    writeFileSync(path.join(t.root, 'etc/systemd/timesyncd.conf'), `${written[1]}\n`);
    t.run('firewall');
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^timesyncd\.conf \S+ after-nightstand$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('saves a symlink as its target, or as the link when the target is gone', () => {
    const t = setup();
    writeFileSync(path.join(t.dir, 'real_ssh_config'), 'Host *\n');
    symlinkSync(path.join(t.dir, 'real_ssh_config'), path.join(t.root, 'etc/ssh/ssh_config'));
    symlinkSync('/nowhere/authorized_keys', path.join(t.root, 'etc/ssh/authorized_keys'));
    t.run('ssh');
    assert.equal(readFileSync(path.join(t.stock, 'ssh_config'), 'utf8'), 'Host *\n');
    assert.equal(readFileSync(path.join(t.stock, 'authorized_keys.link'), 'utf8'), '/nowhere/authorized_keys\n');
    assert.ok(!existsSync(path.join(t.stock, 'authorized_keys.absent')));
    assert.match(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8'), /^authorized_keys\.link \S+ original$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('writes one line per item and leaves no temporary files when runs overlap', async () => {
    const t = setup();
    writeFileSync(path.join(t.bin, 'iptables-save'), '#!/bin/sh\nsleep 0.2\necho "-A OUTPUT -j ACCEPT"\n');
    await Promise.all(Array.from({ length: 6 }, (_, i) => t.runAsync(i % 2 ? 'firewall' : 'units')));
    const items = readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8').trim().split('\n').map(line => line.split(' ')[0]);
    assert.deepEqual([...items].sort(), [
      'ip6tables.rules', 'ip6tables.rules.file.absent', 'iptables.rules', 'iptables.rules.file.absent', 'timesyncd.conf', 'unit-states.txt',
    ]);
    assert.equal(readFileSync(path.join(t.stock, 'iptables.rules'), 'utf8'), '-A OUTPUT -j ACCEPT\n');
    assert.deepEqual(readdirSync(t.stock).filter(name => name.startsWith('.run.')), []);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('still saves and records an item whose line was claimed by a run that never saved it', () => {
    const t = setup();
    mkdirSync(t.stock);
    writeFileSync(path.join(t.stock, '.noted.unit-states.txt'), '');
    writeFileSync(path.join(t.stock, '.noted.sshd_config'), '');
    t.run('units');
    t.run('ssh');
    assert.match(readFileSync(path.join(t.stock, 'unit-states.txt'), 'utf8'), /^swupdate enabled$/m);
    assert.equal(readFileSync(path.join(t.stock, 'sshd_config'), 'utf8'), 'Port 22\n');
    const recorded = readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8');
    assert.match(recorded, /^unit-states\.txt \S+ after-nightstand$/m);
    assert.match(recorded, /^sshd_config \S+ original$/m);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('finishes the line it claimed when stopped while writing it', async () => {
    const t = setup();
    mkdirSync(t.stock);
    writeFileSync(path.join(t.stock, 'unit-states.txt'), 'swupdate enabled\n');
    writeFileSync(path.join(t.bin, 'date'), '#!/bin/sh\nsleep 1\necho 2026-10-04T00:00:00Z\n');
    chmodSync(path.join(t.bin, 'date'), 0o755);
    const child = spawn('bash', [path.join(repoRoot, 'scripts/record_stock.sh'), 'units'], {
      env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, NIGHTSTAND_STOCK_DIR: t.stock, NIGHTSTAND_ROOT: t.root },
      stdio: 'ignore',
    });
    const closed = new Promise(resolve => child.on('close', resolve));
    for (let i = 0; i < 100 && !existsSync(path.join(t.stock, '.noted.unit-states.txt')); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    child.kill('SIGTERM');
    await closed;
    t.run('units');
    assert.deepEqual(readFileSync(path.join(t.stock, 'recorded.txt'), 'utf8').trim().split('\n'),
      ['unit-states.txt 2026-10-04T00:00:00Z original']);
    rmSync(t.dir, { recursive: true, force: true });
  });
  it('leaves the stock directory private', () => {
    const t = setup();
    t.run('ssh');
    assert.equal(statSync(t.stock).mode & 0o777, 0o700);
    rmSync(t.dir, { recursive: true, force: true });
  });
});

describe('the scripts that change system files record them first', () => {
  const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
  it('setup_ssh.sh records after the confirmation and before removing anything', () => {
    const src = read('scripts/setup_ssh.sh');
    const record = src.indexOf('bash "$(dirname "$0")/record_stock.sh" ssh 2>/dev/null || true');
    assert.ok(record !== -1, 'never records the originals');
    assert.ok(src.indexOf('read -r') < record, 'records before the owner confirms');
    for (const change of ['rm "$SSHD_CONFIG_FILE"', 'rm "$SSH_CONFIG_FILE"', 'rm /etc/ssh/authorized_keys', 'cat > "$SERVICE_FILE"']) {
      assert.ok(record < src.indexOf(change), `records after ${change}`);
    }
  });
  it('install.sh records the unit states once the tree is in place, without failing on it', () => {
    const src = read('scripts/install.sh');
    const record = src.indexOf('bash "$COPY/scripts/record_stock.sh" units || true');
    assert.ok(record > src.indexOf('chown -R "$USERNAME":"$USERNAME" "$REPO_DIR"'));
  });
  it('record_stock.sh parses and is executable', () => {
    const script = path.join(repoRoot, 'scripts/record_stock.sh');
    assert.equal(spawnSync('bash', ['-n', script]).status, 0);
    assert.ok(statSync(script).mode & 0o111);
  });
});
