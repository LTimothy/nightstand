import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The updaters open a narrow internet window for the download. These tests run
// the real window functions and the real block script against a fake iptables
// that keeps its rules in files, so the firewall's state can be compared
// before, during and after the window.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `missing ${to} after ${from}`);
  return src.slice(start, end);
};

const FAKE_IPTABLES = `#!/bin/bash
tool=\${0##*/}
dir="$FAKE_FW/$tool"
mkdir -p "$dir"
args=()
table=filter
while [ $# -gt 0 ]; do
  case "$1" in
    -w)
      # iptables before 1.6.0 takes a bare -w, and before 1.4.20 has none.
      case "\${FAKE_IPT_W:-modern}" in
        none) echo "$tool: unknown option -w" >&2; exit 2 ;;
        bare) case "\${2:-}" in [0-9]*) echo "$tool: unknown arguments found on commandline" >&2; exit 2 ;; esac; shift ;;
        *) case "\${2:-}" in [0-9]*) shift 2 ;; *) shift ;; esac ;;
      esac ;;
    -t) table=$2; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[ "\${args[0]}" = -S ] || echo "$tool \${args[*]}" >> "$FAKE_FW/calls"
[ "$table" = filter ] || exit 0
op=\${args[0]}
chain=\${args[1]:-}
rest=("\${args[@]:2}")
case "$op" in
  -S)
    # Listed the way iptables prints rules, with the implicit -m tcp or -m udp.
    for c in \${chain:-INPUT OUTPUT}; do
      policy=$(cat "$dir/$c.policy" 2>/dev/null || echo ACCEPT)
      echo "-P $c $policy"
      [ -f "$dir/$c" ] && sed -E -e "s/^/-A $c /" -e 's/-p (tcp|udp) --(d|s)port/-p \\1 -m \\1 --\\2port/' "$dir/$c" |
        if [ "\${FAKE_SPACING:-no}" = yes ]; then sed -E -e 's/ /  /g' -e 's/$/ /'; else cat; fi
    done
    exit 0 ;;
  -P)
    case " $FAKE_FAIL_ACCEPT " in *" $tool "*) [ "\${rest[0]}" = ACCEPT ] && exit 1 ;; esac
    echo "\${rest[0]}" > "$dir/$chain.policy"
    exit 0 ;;
  -X) exit 0 ;;
  -F)
    if [ -n "$chain" ]; then : > "$dir/$chain"; else : > "$dir/INPUT"; : > "$dir/OUTPUT"; fi
    exit 0 ;;
esac
case " $FAKE_FAIL_TAIL " in
  *" $tool "*)
    if [ "$op" = -A ] && [ "$chain" = OUTPUT ] && [[ " \${rest[*]} " == *" -j REJECT "* || " \${rest[*]} " == " -j DROP " ]]; then exit 1; fi ;;
esac
case " $FAKE_FAIL_REJECT " in
  *" $tool "*) [ "$op" = -A ] && [[ " \${rest[*]} " == *" -j REJECT "* ]] && exit 1 ;;
esac
touch "$dir/$chain"
case "$op" in
  -A) echo "\${rest[*]}" >> "$dir/$chain" ;;
  -I)
    pos=1
    case "\${rest[0]}" in [0-9]*) pos=\${rest[0]}; rest=("\${rest[@]:1}") ;; esac
    awk -v pos="$pos" -v rule="\${rest[*]}" \\
      'NR == pos { print rule; done = 1 } { print } END { if (!done) print rule }' "$dir/$chain" > "$dir/tmp"
    mv "$dir/tmp" "$dir/$chain" ;;
  -C) grep -Fxq -- "\${rest[*]}" "$dir/$chain" ;;
  -D)
    case " $FAKE_FAIL_DELETE " in *" $tool "*) exit 1 ;; esac
    awk -v rule="\${rest[*]}" '!done && $0 == rule { done = 1; next } { print } END { exit done ? 0 : 1 }' "$dir/$chain" > "$dir/tmp"
    status=$?
    mv "$dir/tmp" "$dir/$chain"
    exit $status ;;
  *) echo "fake iptables: unsupported $op" >&2; exit 2 ;;
esac
`;

const FAKE_SAVE = `#!/bin/bash
tool=\${0##*/}
"\${tool%-save}" -S
`;

const FAKE_RESTORE = `#!/bin/bash
tool=\${0##*/}
tool=\${tool%-restore}
"$tool" -F
while read -r -a rule; do
  "$tool" "\${rule[@]}" || exit 1
done
`;

const FAKE_SYSTEMCTL = `#!/bin/bash
case "$*" in
  *is-active*tailscaled*) [ "$FAKE_TAILSCALE" = yes ] ;;
  *) exit 0 ;;
esac
`;

function rules(dir: string) {
  return ['iptables', 'ip6tables'].map(tool => {
    const result = spawnSync(path.join(dir, 'bin', tool), ['-S'], {
      env: { ...process.env, FAKE_FW: path.join(dir, 'fw') }, encoding: 'utf8',
    });
    return `# ${tool}\n${result.stdout}`;
  }).join('');
}

type Fixture = { dir: string; env: NodeJS.ProcessEnv; before: string };

const FAKE_SUDO = `#!/bin/bash
echo "sudo $*" >> "$F/sudo-calls"
if [ ! -f "$F/window" ]; then
  { iptables -S; echo; ip6tables -S; } > "$F/window"
  cp "$FAKE_FW/calls" "$F/window-calls" 2>/dev/null || : > "$F/window-calls"
fi
remote_shell() {
  echo "$FAKE_REMOTE_PID"
}
[ "\${FAKE_HANGUP:-no}" = no ] || kill -HUP "$(remote_shell)"
if [ "\${FAKE_KILL_REMOTE:-no}" = yes ]; then
  # SIGKILL the remote shell the way the out of memory killer would.
  kill -KILL "$(remote_shell)"
  sleep 5
fi
if [ "\${FAKE_DROP_WINDOW:-no}" = yes ] && [ ! -f "$F/dropped" ]; then
  touch "$F/dropped"
  iptables -D OUTPUT -p tcp --dport 443 -j ACCEPT
fi
case "$*" in
  *install*) [ "\${FAKE_INSTALL:-ok}" = ok ] ;;
  *) [ "\${FAKE_FETCH:-ok}" = ok ] ;;
esac
`;

function closeScript(dir: string) {
  return read('scripts/close_update_window.sh')
    .replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh', `${dir}/restore_helpers.sh`)
    .replaceAll('/etc/iptables/', `${dir}/`)
    .replaceAll('/home/dac/free-sleep-prev', `${dir}/prev`)
    .replaceAll('/home/dac/free-sleep', `${dir}/live`);
}

// The helpers sit in the root-owned scripts folder, so the block script root
// runs again is the one beside them ('root'), or there is none ('none').
function fixture(tailscale = false, blockScripts: 'root' | 'none' = 'root', unblocked = false): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-update-firewall-'));
  writeFileSync(path.join(dir, 'restore_helpers.sh'), read('scripts/restore_helpers.sh')
    .replaceAll('/etc/iptables/', `${dir}/`));
  writeFileSync(path.join(dir, 'system_scripts.py'), read('scripts/system_scripts.py'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const tools: Array<[string, string]> = [
    ['iptables', FAKE_IPTABLES], ['ip6tables', FAKE_IPTABLES],
    ['iptables-save', FAKE_SAVE], ['ip6tables-save', FAKE_SAVE], ['systemctl', FAKE_SYSTEMCTL],
    ['iptables-restore', FAKE_RESTORE], ['ip6tables-restore', FAKE_RESTORE],
    ['sudo', FAKE_SUDO],
  ];
  for (const [name, body] of tools) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(dir, 'resolv.conf'), 'nameserver 9.9.9.9\nnameserver 2606:4700:4700::1111\n');
  const block = read('scripts/block_internet_access.sh')
    .replaceAll('/etc/resolv.conf', `${dir}/resolv.conf`)
    .replaceAll('/run/systemd/resolve/resolv.conf', `${dir}/resolved.conf`)
    .replaceAll('/etc/systemd/timesyncd.conf', `${dir}/timesyncd.conf`)
    .replaceAll('/etc/iptables/', `${dir}/`);
  if (blockScripts === 'root') writeFileSync(path.join(dir, 'block_internet_access.sh'), block);
  for (const tree of ['live', 'prev', 'stage', 'copy']) mkdirSync(path.join(dir, tree, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'live/scripts/block_internet_access.sh'), block);
  writeFileSync(path.join(dir, 'stage/scripts/block_internet_access.sh'), block);
  // ops/deploy.sh's copy of the shipped stage.
  writeFileSync(path.join(dir, 'copy/scripts/block_internet_access.sh'), block);
  writeFileSync(path.join(dir, 'copy/scripts/close_update_window.sh'), closeScript(dir));
  copyFileSync(path.join(dir, 'restore_helpers.sh'), path.join(dir, 'copy/scripts/restore_helpers.sh'));
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_FW: path.join(dir, 'fw'),
    FAKE_TAILSCALE: tailscale ? 'yes' : 'no', F: dir, NIGHTSTAND_SYSTEM_DIR: path.join(dir, 'system'),
  };
  // The Pod's normal state before an update: the block script has run.
  writeFileSync(path.join(dir, 'block.sh'), block);
  const applied = spawnSync('sh', [path.join(dir, 'block.sh')], { env, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  if (unblocked) {
    const opened = spawnSync('sh', [path.join(repoRoot, 'scripts/unblock_internet_access.sh')], { env, encoding: 'utf8' });
    assert.equal(opened.status, 0, opened.stderr);
  }
  rmSync(path.join(dir, 'fw/calls'), { force: true });
  return { dir, env, before: rules(dir) };
}


function driver(file: string, body: string) {
  const src = read(file).replaceAll('/etc/iptables/', '$F/');
  const traps = between(src, 'trap cleanup EXIT', '\n\n').trim();
  const window = between(src, '# While downloading', '# Free-space helpers')
    .replace('$(dirname "${BASH_SOURCE[0]}")/restore_helpers.sh', '$F/restore_helpers.sh');
  return `set -uo pipefail
LIVE="$F/live"; PREV="$F/prev"; STAGE="$F/stage"; ZIP="$F/download.zip"; BK="$F/backup"
SWAP_MARKER="$F/swap-marker"; SYSTEM_DIR="$F/system"; NEW_COPY="$F/copy"
say() { echo "$*"; }
restore_switch_data() { :; }
snapshot() {
  { iptables -S; echo; ip6tables -S; } > "$F/window"
  cp "$F/fw/calls" "$F/window-calls" 2>/dev/null || : > "$F/window-calls"
}
${window}
${traps}
${body}`;
}

function windowRules(f: Fixture) {
  const [v4, v6] = readFileSync(path.join(f.dir, 'window'), 'utf8').split('\n\n');
  const lines = (text: string) => text.trim().split('\n');
  return { v4: lines(v4), v6: lines(v6), calls: readFileSync(path.join(f.dir, 'window-calls'), 'utf8') };
}

const OPENED = [
  '-A OUTPUT -p tcp -m tcp --dport 53 -j ACCEPT',
  '-A OUTPUT -p udp -m udp --dport 53 -j ACCEPT',
  '-A OUTPUT -p tcp -m tcp --dport 443 -j ACCEPT',
];
const IPV6_REFUSED = '-A OUTPUT -p tcp -m tcp --dport 443 -j REJECT --reject-with tcp-reset';

const chain = (lines: string[], name: string) => lines.filter(line => line.startsWith(`-A ${name} `));

function assertNarrowWindow(f: Fixture) {
  const [beforeV4, beforeV6] = f.before.split('# ip6tables\n')
    .map(text => text.replace('# iptables\n', '').trim().split('\n'));
  const window = windowRules(f);
  assert.deepEqual(chain(window.v4, 'INPUT'), chain(beforeV4, 'INPUT'), 'IPv4 INPUT must not change');
  assert.deepEqual(chain(window.v6, 'INPUT'), chain(beforeV6, 'INPUT'), 'IPv6 INPUT must not change');
  const output = chain(window.v4, 'OUTPUT');
  assert.deepEqual(output.slice(0, 3), OPENED);
  assert.deepEqual(output.slice(3), chain(beforeV4, 'OUTPUT'), 'the rest of IPv4 OUTPUT must stay as it was');
  assert.ok(output.includes('-A OUTPUT -p tcp -m tcp --dport 1337 -j REJECT --reject-with tcp-reset'));
  assert.equal(output.at(-1), '-A OUTPUT -j REJECT');
  assert.deepEqual(chain(window.v6, 'OUTPUT'), [IPV6_REFUSED, ...chain(beforeV6, 'OUTPUT')]);
  assert.doesNotMatch(window.calls, / -F| -X|INPUT|unblock/, window.calls);
}

function cleanup(f: Fixture) {
  rmSync(f.dir, { recursive: true, force: true });
}

for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
  describe(`${file} internet window`, () => {
    const src = read(file);

    it('never runs the full unblock anywhere in the script', () => {
      // Exclude only the legacy cron matcher, which reports existing jobs.
      const executable = src.split('\n').filter(line => !/^\s*#/.test(line)).join('\n')
        .replaceAll('/\\/home\\/dac\\/free-sleep\\/scripts\\/unblock_internet_access[.]sh/', '');
      assert.doesNotMatch(executable, /unblock_internet_access/);
    });

    it('puts a time limit on the dependency install', () => {
      assert.match(src, /run_limited 900 sudo -u dac bash -c "cd '\$STAGE\/server' && '\$NPM' install/);
    });

    for (const tailscale of [false, true]) {
      it(`opens only HTTPS and DNS and restores the block on success${tailscale ? ' with Tailscale' : ''}`, () => {
        const f = fixture(tailscale);
        try {
          const result = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
run_limited 900 true || fail "install failed"
close_wan
exit 0`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assertNarrowWindow(f);
          assert.equal(rules(f.dir), f.before);
        } finally {
          cleanup(f);
        }
      });
    }

    it('restores the block when the install fails', () => {
      const f = fixture();
      try {
        const result = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
run_limited 900 false || fail "install failed"`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /FATAL: install failed/);
        assertNarrowWindow(f);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });

    for (const [label, setup] of [
      ['without a usable timeout command', 'timeout() { return 127; }'],
      ...(spawnSync('timeout', ['1', 'true']).status === 0 ? [['with the system timeout command', '']] : []),
    ]) {
      it(`gives up on a stalled install and restores the block ${label}`, () => {
        const f = fixture();
        try {
          const started = Date.now();
          const result = spawnSync('bash', ['-c', driver(file, `${setup}
open_wan
snapshot
run_limited 2 sleep 30 || fail "install timed out"`)], { env: f.env, encoding: 'utf8', timeout: 20000 });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout, /FATAL: install timed out/);
          assert.ok(Date.now() - started < 15000, 'the limit did not stop the command');
          assertNarrowWindow(f);
          assert.equal(rules(f.dir), f.before);
        } finally {
          cleanup(f);
        }
      });
    }

    it('passes the limit to the system timeout command when it works', () => {
      const result = spawnSync('bash', ['-c', `${between(read('scripts/restore_helpers.sh'), 'run_limited() {', '\n}\n')}\n}
timeout() { echo "timeout $*"; [ "$1" = 1 ] || { shift; "$@"; }; }
run_limited 900 echo installed`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /timeout 900 echo installed\ninstalled/);
    });

    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
      it(`restores the block when stopped by ${signal}`, async () => {
        const f = fixture();
        try {
          const child = spawn('bash', ['-c', driver(file, `open_wan
snapshot
touch "$F/ready"
sleep 30`)], { env: f.env, detached: true, stdio: 'ignore' });
          const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
          const deadline = Date.now() + 10000;
          while (!existsSync(path.join(f.dir, 'ready')) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.ok(existsSync(path.join(f.dir, 'ready')), 'the window never opened');
          assert.ok(child.pid);
          process.kill(-child.pid, signal);
          const code = await exited;
          assert.notEqual(code, 0);
          assertNarrowWindow(f);
          assert.equal(rules(f.dir), f.before);
        } finally {
          cleanup(f);
        }
      });
    }

    it('leaves Tailscale\'s own rules alone when the window rule is already gone', () => {
      const f = fixture(true, 'none');
      try {
        const result = spawnSync('bash', ['-c', driver(file, `open_wan
iptables -D OUTPUT -p tcp --dport 443 -j ACCEPT
iptables -D OUTPUT -p tcp --dport 53 -j ACCEPT
close_wan`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });

    it('blocks again with the root-owned block script, never a tree\'s', () => {
      const f = fixture();
      try {
        for (const tree of ['live', 'prev']) {
          writeFileSync(path.join(f.dir, tree, 'scripts/block_internet_access.sh'), `touch "$F/ran-${tree}"\n`);
        }
        const result = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
fail "download failed"`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
        assert.match(readFileSync(path.join(f.dir, 'fw/calls'), 'utf8'), /iptables -F OUTPUT/);
        for (const tree of ['live', 'prev']) assert.ok(!existsSync(path.join(f.dir, `ran-${tree}`)), tree);
      } finally {
        cleanup(f);
      }
    });

    it('still removes the window when no block script can run', () => {
      const f = fixture(false, 'none');
      try {
        const result = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
fail "download failed"`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assertNarrowWindow(f);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });
  });
}

it('switch-to-upstream.sh puts a time limit on the biometrics package install', () => {
  assert.match(read('scripts/switch-to-upstream.sh'),
    /run_limited 600 sudo -H -u dac \/home\/dac\/venv\/bin\/python -I -m pip install/);
});

// An updater killed outright never runs its cleanup; the units' ExecStopPost
// runs this script instead.
function runCloseScript(f: Fixture, env: NodeJS.ProcessEnv = {}) {
  writeFileSync(path.join(f.dir, 'close.sh'), closeScript(f.dir));
  return spawnSync('bash', [path.join(f.dir, 'close.sh')], { env: { ...f.env, ...env }, encoding: 'utf8', timeout: 10000 });
}

function killInWindow(file: string, f: Fixture) {
  const killed = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
kill -KILL $$`)], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
  assert.notEqual(rules(f.dir), f.before, 'a killed updater should have left its window open');
  rmSync(path.join(f.dir, 'fw/calls'), { force: true });
}

const calls = (f: Fixture) => {
  try { return readFileSync(path.join(f.dir, 'fw/calls'), 'utf8'); } catch { return ''; }
};

function runBlockScript(f: Fixture, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('sh', [path.join(f.dir, 'block.sh')], {
    env: { ...f.env, ...env }, encoding: 'utf8', timeout: 10000,
  });
}

function assertPolicies(f: Fixture, failed = '') {
  for (const tool of ['iptables', 'ip6tables']) {
    const policy = failed.split(' ').includes(tool) ? 'DROP' : 'ACCEPT';
    assert.match(rules(f.dir).split(`# ${tool}\n`)[1].split('# ')[0], new RegExp(`^-P OUTPUT ${policy}$`, 'm'));
  }
}

function failBlocking(f: Fixture, failed: string) {
  for (const name of ['iptables.rules', 'ip6tables.rules']) rmSync(path.join(f.dir, name), { force: true });
  const result = runBlockScript(f, { FAKE_FAIL_TAIL: failed });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /successfully/);
  assertPolicies(f, failed);
  for (const name of ['iptables.rules', 'ip6tables.rules']) assert.equal(existsSync(path.join(f.dir, name)), false);
  assert.doesNotMatch(calls(f), /-P OUTPUT ACCEPT/);
}

const policyCases = [
  ['IPv4', 'iptables'], ['IPv6', 'ip6tables'], ['both families', 'iptables ip6tables'],
];

function legacyFirewall(f: Fixture, tree: 'live' | 'prev') {
  const block = read('scripts/tests/fixtures/block_internet_access_v3.6.1.sh')
    .replaceAll('/etc/resolv.conf', `${f.dir}/resolv.conf`)
    .replaceAll('/run/systemd/resolve/resolv.conf', `${f.dir}/resolved.conf`)
    .replaceAll('/etc/systemd/timesyncd.conf', `${f.dir}/timesyncd.conf`)
    .replaceAll('/etc/iptables/', `${f.dir}/`);
  writeFileSync(path.join(f.dir, tree, 'scripts/block_internet_access.sh'), block);
  writeFileSync(path.join(f.dir, tree, 'scripts/unblock_internet_access.sh'),
    read('scripts/tests/fixtures/unblock_internet_access_v3.6.1.sh'));
}

function assertLegacyUnblock(f: Fixture) {
  const opened = spawnSync('sh', [path.join(f.dir, 'live/scripts/unblock_internet_access.sh')], {
    env: f.env, encoding: 'utf8',
  });
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assertPolicies(f);
  assert.doesNotMatch(rules(f.dir), /^-A /m);
}

function assertSavedRecovery(f: Fixture) {
  for (const tool of ['iptables', 'ip6tables']) {
    const saved = readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8');
    assert.match(saved, /^-P OUTPUT ACCEPT$/m, `${tool} saved policy`);
    assert.match(saved, /^-A OUTPUT -j (DROP|REJECT)$/m, `${tool} saved terminal block`);
    for (const rule of [...OPENED, IPV6_REFUSED]) assert.ok(!saved.includes(rule), `${tool} saved download rule: ${rule}`);
  }
  const reloaded = spawnSync('bash', ['-c', 'iptables-restore < "$F/iptables.rules"\nip6tables-restore < "$F/ip6tables.rules"'], {
    env: f.env, encoding: 'utf8',
  });
  assert.equal(reloaded.status, 0, reloaded.stdout + reloaded.stderr);
  assertPolicies(f);
  assertLegacyUnblock(f);
}

describe('legacy rollback OUTPUT policy recovery', () => {
  for (const [label, failed] of policyCases) {
    for (const rollbackFailed of [false, true]) {
      const action = rollbackFailed ? 'preserves emergency DROP' : 'restores ACCEPT';
      it(`${action} for ${label} after failed new firewall retries and older rollback across saved-rule reload and older unblock`, () => {
        const f = fixture();
        try {
          legacyFirewall(f, 'prev');
          if (rollbackFailed) {
            const oldBlock = path.join(f.dir, 'prev/scripts/block_internet_access.sh');
            writeFileSync(oldBlock, `export FAKE_FAIL_TAIL='${failed}'\n${readFileSync(oldBlock, 'utf8')}`);
          }
          const liveBlock = path.join(f.dir, 'live/scripts/block_internet_access.sh');
          writeFileSync(liveBlock, `export FAKE_FAIL_TAIL='${failed}'\n${readFileSync(liveBlock, 'utf8')}`);
          writeFileSync(path.join(f.dir, 'recover.sh'), '#!/bin/sh\nexit 0\n');
          // Both versions have root-owned copies, and root runs the new one after the swap.
          const tool = (...args: string[]) => spawnSync('python3', ['-B', path.join(repoRoot, 'scripts/system_scripts.py'), ...args],
            { env: f.env, encoding: 'utf8' }).stdout.trim();
          const newCopy = tool('publish', path.join(f.dir, 'live'));
          tool('publish', path.join(f.dir, 'prev'));
          tool('point', newCopy);
          const src = read('scripts/update.sh');
          const result = spawnSync('bash', ['-c', driver('scripts/update.sh', `
FAILED="$F/failed"; RECOVERY_HELPER="$F/recover.sh"; NEW_COPY='${newCopy}'
CUR_VERSION=3.6.1; STAGED_VERSION=3.7.0; HEALTHY=yes
MOVED_MODULES=no; STREAM_WAS_ACTIVE=inactive
stop_writer() { return 0; }
record_result() { :; }
curl() { printf 200; }
sleep() { :; }
tail() { :; }
${src.slice(src.indexOf('# The first arming of the hardware watchdog')).replaceAll('/etc/iptables/', '$F/')}`)], {
            env: f.env, encoding: 'utf8', timeout: 20000,
          });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout, /Firewall rules missing after attempt 1/);
          assert.match(result.stdout, /Firewall rules missing after attempt 2/);
          assert.match(result.stdout, /update failed but rollback OK/);
          assert.equal(calls(f).split('iptables -F OUTPUT').length - 1, 3);
          assert.equal(calls(f).split('ip6tables -F OUTPUT').length - 1, 3);
          assertPolicies(f, rollbackFailed ? failed : '');
          if (!rollbackFailed) {
            const log = calls(f);
            const reset = log.indexOf('iptables -P OUTPUT ACCEPT');
            for (const tool of ['iptables', 'ip6tables']) {
              assert.match(rules(f.dir).split(`# ${tool}\n`)[1].split('# ')[0], /^-A OUTPUT -j DROP$/m);
              const verified = log.lastIndexOf(`${tool} -C OUTPUT -j DROP`);
              assert.ok(verified >= 0 && verified < reset);
            }
            assertSavedRecovery(f);
          }
          const stopped = runCloseScript(f);
          assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
          assertPolicies(f, rollbackFailed ? failed : '');
          if (rollbackFailed) assert.doesNotMatch(calls(f), /-P OUTPUT ACCEPT/);
          else assertPolicies(f);
        } finally { cleanup(f); }
      });
    }

    it(`never leaves ${label} open when the restored tree from before root-owned copies has none`, () => {
      const f = fixture();
      try {
        // A 3.6.x tree: its own legacy firewall, and no copy, so root keeps the new copy after the rollback.
        legacyFirewall(f, 'prev');
        const liveBlock = path.join(f.dir, 'live/scripts/block_internet_access.sh');
        writeFileSync(liveBlock, `export FAKE_FAIL_TAIL='${failed}'\n${readFileSync(liveBlock, 'utf8')}`);
        writeFileSync(path.join(f.dir, 'recover.sh'), '#!/bin/sh\nexit 0\n');
        const tool = (...args: string[]) => spawnSync('python3', ['-B', path.join(repoRoot, 'scripts/system_scripts.py'), ...args],
          { env: f.env, encoding: 'utf8' });
        const newCopy = tool('publish', path.join(f.dir, 'live')).stdout.trim();
        assert.equal(tool('point', newCopy).status, 0);
        assert.notEqual(tool('find', path.join(f.dir, 'prev')).status, 0);
        const src = read('scripts/update.sh');
        const result = spawnSync('bash', ['-c', driver('scripts/update.sh', `
FAILED="$F/failed"; RECOVERY_HELPER="$F/recover.sh"; NEW_COPY='${newCopy}'
CUR_VERSION=3.6.1; STAGED_VERSION=3.7.0; HEALTHY=yes
MOVED_MODULES=no; STREAM_WAS_ACTIVE=inactive
stop_writer() { return 0; }
record_result() { :; }
systemctl() { echo "$*" >> "$F/systemctl-calls"; }
curl() { printf 200; }
sleep() { :; }
tail() { :; }
${src.slice(src.indexOf('# The first arming of the hardware watchdog')).replaceAll('/etc/iptables/', '$F/')}`)], {
          env: f.env, encoding: 'utf8', timeout: 20000,
        });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /rolling back to v3\.6\.1/);
        assert.equal(readlinkSync(path.join(f.dir, 'system/live')), `copies/${path.basename(newCopy)}`);
        assert.match(readFileSync(path.join(f.dir, 'systemctl-calls'), 'utf8'), /^start free-sleep$/m);
        for (const family of ['iptables', 'ip6tables']) {
          const table = rules(f.dir).split(`# ${family}\n`)[1].split('# ')[0];
          const output = table.split('\n').filter(line => line.startsWith('-A OUTPUT '));
          const terminal = /^-A OUTPUT -j (?:REJECT|DROP)\b/.test(output[output.length - 1] ?? '');
          assert.ok(/^-P OUTPUT DROP$/m.test(table) || terminal, `${family} left open:\n${table}`);
          for (const rule of OPENED) assert.ok(!output.includes(rule), `${family} kept a download rule: ${rule}`);
        }
      } finally { cleanup(f); }
    });

    for (const mode of ['without download rules', 'with download rules', 'with live ACCEPT policies']) {
      it(`stop-post persists ${label} ACCEPT after older rollback ${mode} across saved-rule reload and older unblock`, () => {
        const f = fixture();
        try {
          failBlocking(f, failed);
          legacyFirewall(f, 'live');
          const restored = spawnSync('sh', [path.join(f.dir, 'live/scripts/block_internet_access.sh')], {
            env: f.env, encoding: 'utf8',
          });
          assert.equal(restored.status, 0, restored.stdout + restored.stderr);
          assertPolicies(f, failed);
          if (mode === 'with download rules') {
            killInWindow('scripts/update.sh', f);
            const reset = spawnSync('bash', ['-c', failed.split(' ').map(tool => `${tool} -P OUTPUT DROP`).join('\n')], {
              env: f.env, encoding: 'utf8',
            });
            assert.equal(reset.status, 0, reset.stderr);
          }
          if (mode === 'with live ACCEPT policies') {
            const reset = spawnSync('bash', ['-c', 'iptables -P OUTPUT ACCEPT\nip6tables -P OUTPUT ACCEPT'], {
              env: f.env, encoding: 'utf8',
            });
            assert.equal(reset.status, 0, reset.stderr);
          }
          rmSync(path.join(f.dir, 'fw/calls'));
          const stopped = runCloseScript(f);
          assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
          assertPolicies(f);
          const log = calls(f);
          if (mode !== 'with live ACCEPT policies') {
            // Removing download rules reapplies root's own block script, which ends OUTPUT with REJECT.
            const terminal = mode === 'with download rules' ? 'REJECT' : 'DROP';
            const reset = log.indexOf('iptables -P OUTPUT ACCEPT');
            for (const tool of ['iptables', 'ip6tables']) {
              const verified = log.indexOf(`${tool} -C OUTPUT -j ${terminal}`);
              assert.ok(verified >= 0 && verified < reset, `${tool} ${terminal}`);
            }
          }
          if (mode !== 'with download rules') assert.doesNotMatch(log, / -F | -A | -I | -D /);
          assertSavedRecovery(f);
        } finally { cleanup(f); }
      });
    }

    it(`stop-post preserves ${label} emergency DROP without verified terminal rules and no download rules`, () => {
      const f = fixture(false, 'none');
      try {
        failBlocking(f, failed);
        rmSync(path.join(f.dir, 'fw/calls'));
        const stopped = runCloseScript(f);
        assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
        assertPolicies(f, failed);
        assert.doesNotMatch(calls(f), /-P OUTPUT ACCEPT/);
        for (const name of ['iptables.rules', 'ip6tables.rules']) assert.equal(existsSync(path.join(f.dir, name)), false);
      } finally { cleanup(f); }
    });
  }
});

describe('recovered firewall persistence', () => {
  it('does not save the temporary download window when recovering live OUTPUT policies', () => {
    const f = fixture();
    try {
      failBlocking(f, 'iptables ip6tables');
      legacyFirewall(f, 'live');
      const restored = spawnSync('sh', [path.join(f.dir, 'live/scripts/block_internet_access.sh')], { env: f.env, encoding: 'utf8' });
      assert.equal(restored.status, 0, restored.stderr);
      const saved = ['iptables', 'ip6tables'].map(tool => readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'));
      killInWindow('scripts/update.sh', f);
      assertPolicies(f);
      for (const [index, tool] of ['iptables', 'ip6tables'].entries()) {
        assert.equal(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), saved[index]);
      }
    } finally { cleanup(f); }
  });

  for (const [label, failed] of policyCases) {
    it(`stop-post does not save rules when ${label} download rule removal fails`, () => {
      const f = fixture(false, 'none');
      try {
        const saved = ['iptables', 'ip6tables'].map(tool => readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'));
        killInWindow('scripts/update.sh', f);
        const stopped = runCloseScript(f, { FAKE_FAIL_DELETE: failed });
        assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
        for (const [index, tool] of ['iptables', 'ip6tables'].entries()) {
          assert.equal(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), saved[index]);
        }
      } finally { cleanup(f); }
    });

    it(`stop-post does not save partial recovery when ${label} ACCEPT restoration fails`, () => {
      const f = fixture();
      try {
        failBlocking(f, failed);
        legacyFirewall(f, 'live');
        const restored = spawnSync('sh', [path.join(f.dir, 'live/scripts/block_internet_access.sh')], { env: f.env, encoding: 'utf8' });
        assert.equal(restored.status, 0, restored.stderr);
        const saved = ['iptables', 'ip6tables'].map(tool => readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'));
        const stopped = runCloseScript(f, { FAKE_FAIL_ACCEPT: failed });
        assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
        assertPolicies(f, failed);
        for (const [index, tool] of ['iptables', 'ip6tables'].entries()) {
          assert.equal(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), saved[index]);
        }
      } finally { cleanup(f); }
    });
  }
});

describe('emergency OUTPUT policy recovery', () => {
  for (const [label, failed] of policyCases) {
    for (const target of ['REJECT', 'DROP']) {
      it(`restores ACCEPT after ${label} fallback then successful retry with ${target} tails`, () => {
        const f = fixture();
        try {
          failBlocking(f, failed);
          rmSync(path.join(f.dir, 'fw/calls'));
          const result = runBlockScript(f, target === 'DROP' ? { FAKE_FAIL_REJECT: 'iptables ip6tables' } : {});
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assertPolicies(f);
          const log = calls(f);
          const reset = log.indexOf('iptables -P OUTPUT ACCEPT');
          for (const tool of ['iptables', 'ip6tables']) {
            const verified = log.indexOf(`${tool} -C OUTPUT -j ${target}`);
            assert.ok(verified >= 0 && verified < reset);
            assert.match(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), /^-P OUTPUT ACCEPT$/m);
            assert.match(rules(f.dir).split(`# ${tool}\n`)[1].split('# ')[0], new RegExp(`^-A OUTPUT -j ${target}$`, 'm'));
          }
          // Older versions unblock by flushing alone.
          const opened = spawnSync('sh', ['-c', 'iptables -F\nip6tables -F'], { env: f.env, encoding: 'utf8' });
          assert.equal(opened.status, 0, opened.stderr);
          assertPolicies(f);
          assert.doesNotMatch(rules(f.dir), /^-A /m);
        } finally { cleanup(f); }
      });
    }

    it(`restores ACCEPT after ${label} fallback then full unblock`, () => {
      const f = fixture();
      try {
        failBlocking(f, failed);
        const result = spawnSync('sh', [path.join(repoRoot, 'scripts/unblock_internet_access.sh')], { env: f.env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assertPolicies(f);
        assert.doesNotMatch(rules(f.dir), /^-A /m);
      } finally { cleanup(f); }
    });

    for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
      for (const phase of ['open', 'close']) {
        it(`${file} restores ${label} ACCEPT on window ${phase} with verified terminal rules`, () => {
          const f = fixture(false, 'none');
          try {
            const setPolicy = failed.split(' ').map(tool => `${tool} -P OUTPUT DROP`).join('\n');
            const body = phase === 'open' ? `${setPolicy}\nopen_wan\nsnapshot\nkill -KILL $$` : `open_wan\n${setPolicy}\nclose_wan`;
            const result = spawnSync('bash', ['-c', driver(file, body)], { env: f.env, encoding: 'utf8', timeout: 10000 });
            if (phase === 'open') assert.equal(result.signal, 'SIGKILL');
            else assert.equal(result.status, 0, result.stdout + result.stderr);
            assertPolicies(f);
            if (phase === 'open') assertNarrowWindow(f);
            else assert.equal(rules(f.dir), f.before);
          } finally { cleanup(f); }
        });
      }
    }

    it(`the interrupted-window cleanup restores ${label} ACCEPT with verified terminal rules`, () => {
      const f = fixture(false, 'none');
      try {
        killInWindow('scripts/update.sh', f);
        const policyCommands = failed.split(' ').map(tool => `${tool} -P OUTPUT DROP`).join('\n');
        const set = spawnSync('sh', ['-c', policyCommands], { env: f.env, encoding: 'utf8' });
        assert.equal(set.status, 0, set.stderr);
        const result = runCloseScript(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
      } finally { cleanup(f); }
    });

    it(`download windows preserve ${label} emergency DROP without verified terminal rules`, () => {
      const f = fixture(false, 'none');
      try {
        failBlocking(f, failed);
        rmSync(path.join(f.dir, 'fw/calls'));
        const result = spawnSync('bash', ['-c', driver('scripts/update.sh', 'open_wan\nclose_wan')], { env: f.env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assertPolicies(f, failed);
        assert.doesNotMatch(calls(f), /-P OUTPUT ACCEPT/);
      } finally { cleanup(f); }
    });

    it(`refuses to save a successful retry when ${label} ACCEPT restoration fails`, () => {
      const f = fixture();
      try {
        failBlocking(f, failed);
        const result = runBlockScript(f, { FAKE_FAIL_ACCEPT: failed });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /successfully/);
        assertPolicies(f, failed);
        for (const name of ['iptables.rules', 'ip6tables.rules']) assert.equal(existsSync(path.join(f.dir, name)), false);
      } finally { cleanup(f); }
    });

    it(`does not report full unblock success when ${label} ACCEPT restoration fails`, () => {
      const f = fixture();
      try {
        failBlocking(f, failed);
        const result = spawnSync('sh', [path.join(repoRoot, 'scripts/unblock_internet_access.sh')], {
          env: { ...f.env, FAKE_FAIL_ACCEPT: failed }, encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /Unblocked internet access!/);
      } finally { cleanup(f); }
    });
  }
});


for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh', 'scripts/close_update_window.sh', 'ops/deploy.sh']) {
  it(`${file} never hard-codes the -w 5 form of iptables`, () => {
    assert.doesNotMatch(read(file), /ip6?tables -w 5/);
  });
}

// iptables before 1.6.0 rejects "-w 5", and before 1.4.20 rejects -w at all.
// The window must still open and close on those builds.
for (const mode of ['bare', 'none']) {
  for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
    it(`${file} opens and closes the window on iptables with ${mode === 'bare' ? 'a bare -w' : 'no -w'}`, () => {
      const f = fixture(true);
      try {
        const result = spawnSync('bash', ['-c', driver(file, `open_wan
snapshot
close_wan
exit 0`)], { env: { ...f.env, FAKE_IPT_W: mode }, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /WARNING|unknown/);
        assertNarrowWindow(f);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });
  }

  it(`the close script finds and removes a left window on iptables with ${mode === 'bare' ? 'a bare -w' : 'no -w'}`, () => {
    const f = fixture(true);
    try {
      killInWindow('scripts/update.sh', f);
      const result = runCloseScript(f, { FAKE_IPT_W: mode });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });
}

describe('after the update or revert unit stops', () => {
  const STOP_POST = 'ExecStopPost=-/bin/bash /usr/local/lib/nightstand/live/scripts/close_update_window.sh';

  it('reapplies the block when an older release ends OUTPUT with DROP', () => {
    const f = fixture();
    try {
      const legacy = spawnSync('bash', ['-c', 'iptables -D OUTPUT -j REJECT\niptables -A OUTPUT -j DROP'], {
        env: f.env, encoding: 'utf8',
      });
      assert.equal(legacy.status, 0, legacy.stderr);
      killInWindow('scripts/update.sh', f);
      const result = runCloseScript(f);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(calls(f), /iptables -F OUTPUT/);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });

  it('reapplies the block when only IPv6 has a terminal rule', () => {
    const f = fixture();
    try {
      const removed = spawnSync('iptables', ['-D', 'OUTPUT', '-j', 'REJECT'], { env: f.env, encoding: 'utf8' });
      assert.equal(removed.status, 0, removed.stderr);
      killInWindow('scripts/update.sh', f);
      const result = runCloseScript(f);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(calls(f), /iptables -F OUTPUT/);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });

  it('both units run the window check after any stop', () => {
    assert.ok(between(read('scripts/setup_services.sh'), 'free-sleep-update.service" <<EOF', '\nEOF').includes(STOP_POST));
    assert.ok(read('scripts/systemd/free-sleep-revert.service').includes(STOP_POST));
    assert.ok(statSync(path.join(repoRoot, 'scripts/close_update_window.sh')).mode & 0o111);
  });

  for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
    for (const tailscale of [false, true]) {
      it(`closes the window ${file} left when it was killed${tailscale ? ' with Tailscale' : ''}`, () => {
        const f = fixture(tailscale);
        try {
          killInWindow(file, f);
          assertNarrowWindow(f);
          const result = runCloseScript(f);
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.equal(rules(f.dir), f.before);
          assert.match(calls(f), /iptables -F OUTPUT/, 'the block script should run again');
        } finally {
          cleanup(f);
        }
      });
    }

    it(`only removes the window ${file} left when internet was unblocked on purpose`, () => {
      const f = fixture(false, 'root', true);
      try {
        killInWindow(file, f);
        const result = runCloseScript(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
        assert.doesNotMatch(calls(f), / -F | -A | -I /);
      } finally {
        cleanup(f);
      }
    });
  }

  it('matches rules printed with different spacing', () => {
    const f = fixture(true);
    try {
      killInWindow('scripts/update.sh', f);
      const result = runCloseScript(f, { FAKE_SPACING: 'yes' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Removed the download rules/);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });

  // Another firewall manager may insert its own rule above the window.
  const FOREIGN = '-o wg0 -j ACCEPT';
  const insertAbove = (f: Fixture) => {
    const inserted = spawnSync('iptables', ['-I', 'OUTPUT', '1', ...FOREIGN.split(' ')], { env: f.env, encoding: 'utf8' });
    assert.equal(inserted.status, 0, inserted.stderr);
    rmSync(path.join(f.dir, 'fw/calls'), { force: true });
  };
  const withForeign = (before: string) => before.replace(/^(-A OUTPUT )/m, `-A OUTPUT ${FOREIGN}\n$1`);

  for (const tailscale of [false, true]) {
    it(`closes a window left below another rule and blocks again${tailscale ? ' with Tailscale' : ''}`, () => {
      const f = fixture(tailscale);
      try {
        killInWindow('scripts/update.sh', f);
        insertAbove(f);
        const result = runCloseScript(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Removed the download rules/);
        assert.match(calls(f), /iptables -F OUTPUT/, 'the block script should run again');
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });

    it(`removes only the window's own rules, wherever they are${tailscale ? ', keeping Tailscale\'s' : ''}`, () => {
      // Without a block script to run again, what is left shows what was removed.
      const f = fixture(tailscale, 'none');
      try {
        killInWindow('scripts/update.sh', f);
        insertAbove(f);
        const result = runCloseScript(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), withForeign(f.before));
        assert.doesNotMatch(calls(f), new RegExp(`-D OUTPUT ${FOREIGN}`));
      } finally {
        cleanup(f);
      }
    });
  }

  it('removes a window left below another rule when internet was unblocked on purpose', () => {
    const f = fixture(false, 'root', true);
    try {
      killInWindow('scripts/update.sh', f);
      insertAbove(f);
      const result = runCloseScript(f);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      // The IPv4 OUTPUT chain was empty, apart from the window, before the rule was added.
      assert.equal(rules(f.dir), f.before.replace(/^-P OUTPUT ACCEPT$/m, `-P OUTPUT ACCEPT\n-A OUTPUT ${FOREIGN}`));
      assert.doesNotMatch(calls(f), / -F | -A | -I /);
    } finally {
      cleanup(f);
    }
  });

  for (const tailscale of [false, true]) {
    it(`preserves resolver allowances when cleanup cannot reapply the block${tailscale ? ' with Tailscale' : ''}`, () => {
      const f = fixture(tailscale, 'none');
      try {
        assert.match(f.before, /-d 9\.9\.9\.9 -p udp -m udp --dport 53 -j ACCEPT/);
        assert.match(f.before, /-d 2606:4700:4700::1111 -p tcp -m tcp --dport 53 -j ACCEPT/);
        killInWindow('scripts/update.sh', f);
        const result = runCloseScript(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });
  }

  it('preserves live and saved Tailscale rules when no download window remains', () => {
    const f = fixture(true);
    try {
      const saved = ['iptables', 'ip6tables'].map(tool => readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'));
      const result = runCloseScript(f);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.doesNotMatch(calls(f), / -F | -A | -I | -D /);
      assert.equal(rules(f.dir), f.before);
      for (const [index, tool] of ['iptables', 'ip6tables'].entries()) {
        assert.equal(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), saved[index]);
      }
    } finally {
      cleanup(f);
    }
  });
});

type NodeCase = { stagePin: string; livePin: string; cached?: boolean; lockSame?: boolean; fetchFails?: boolean };

function dependencies(file: string, c: NodeCase) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-node-fetch-'));
  for (const [tree, pin, lock] of [['live', c.livePin, 'a'], ['stage', c.stagePin, c.lockSame === false ? 'b' : 'a']]) {
    mkdirSync(path.join(dir, tree, 'server'), { recursive: true });
    writeFileSync(path.join(dir, tree, 'server/package.json'), JSON.stringify({ volta: { node: pin } }));
    writeFileSync(path.join(dir, tree, 'server/package-lock.json'), lock);
  }
  if (c.cached) mkdirSync(path.join(dir, `volta/tools/image/node/${c.stagePin}`), { recursive: true });
  const src = read(file).replaceAll('/home/dac/.volta', `${dir}/volta`);
  const section = file === 'scripts/update.sh'
    ? `${between(src, '# --- dependencies', '  # Only to a copy that carries the marker')}\nfi`
    : between(src, '# --- dependencies', '# --- backup');
  const result = spawnSync('bash', ['-c', `set -uo pipefail
LIVE="$F/live"; STAGE="$F/stage"; NPM=npm; HANDOFF=0; MODULES_MB=0; SPACE_MARGIN_MB=0; TRANSACTIONAL_SWITCH=no
say() { echo "$*"; }
fail() { echo "FATAL: $*"; exit 1; }
free_mb() { echo 999999; }
sudo() { echo "sudo $*" >> "$F/calls"; case "$*" in *--version*) [ "$FETCH_FAILS" = no ] ;; esac; }
run_limited() { echo "limited $1" >> "$F/calls"; shift; "$@"; }
close_wan() { echo close_wan >> "$F/calls"; }
${between(src, 'node_pin() {', '\n\n')}
${section}
echo finished`], { env: { ...process.env, F: dir, FETCH_FAILS: c.fetchFails ? 'yes' : 'no' }, encoding: 'utf8' });
  let log = '';
  try { log = readFileSync(path.join(dir, 'calls'), 'utf8'); } catch { /* nothing ran */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, log: log.replaceAll(dir, '$F') };
}

for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh']) {
  describe(`${file} fetches a newly pinned Node inside the window`, () => {
    const FETCH = "limited 600\nsudo -u dac bash -c cd '$F/stage/server' && 'npm' --version\n";

    it('when the pin changes and the lockfile does not', () => {
      const result = dependencies(file, { stagePin: '24.12.0', livePin: '24.11.0' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.log, `${FETCH}close_wan\n`);
    });

    it('after the install when both change', () => {
      const result = dependencies(file, { stagePin: '24.12.0', livePin: '24.11.0', lockSame: false });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.log, /^limited 900\nsudo .* install .*\nlimited 600\n.*--version\nclose_wan\n$/);
    });

    for (const [label, c] of [
      ['the pin is unchanged', { stagePin: '24.11.0', livePin: '24.11.0' }],
      ['Volta already has it', { stagePin: '24.12.0', livePin: '24.11.0', cached: true }],
    ] as Array<[string, NodeCase]>) {
      it(`not when ${label}`, () => {
        const result = dependencies(file, c);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.log, 'close_wan\n');
      });
    }

    it('and stops before the swap when the fetch fails', () => {
      const result = dependencies(file, { stagePin: '24.12.0', livePin: '24.11.0', fetchFails: true });
      assert.equal(result.status, 1);
      assert.match(result.stdout, /FATAL: could not fetch Node 24\.12\.0/);
      assert.doesNotMatch(result.stdout, /finished/);
      assert.equal(result.log, FETCH);
    });
  });
}

describe('ops/deploy.sh dependency window', () => {
  const src = read('ops/deploy.sh');

  it('never runs the full unblock', () => {
    assert.doesNotMatch(src, /unblock_internet_access/);
  });

  function deploy(f: Fixture, opts: { lockSame?: boolean; cached?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    for (const [tree, lock] of [['live', 'a'], ['stage', opts.lockSame ? 'a' : 'b']]) {
      mkdirSync(path.join(f.dir, tree, 'server'), { recursive: true });
      writeFileSync(path.join(f.dir, tree, 'server/package-lock.json'), lock);
    }
    if (opts.cached) mkdirSync(path.join(f.dir, 'volta/tools/image/node/24.12.0'), { recursive: true });
    const section = between(src, '# --- dependencies (while old server still runs)', '# --- atomic swap')
      .replaceAll('/home/dac/.volta', `${f.dir}/volta`);
    return spawnSync('bash', ['-c', `set -uo pipefail
LIVE="$F/live"; STAGE="$F/stage"; COPY="$F/copy"; NPM=npm; NODE_PIN=24.12.0
say() { echo "$*"; }
die() { echo "FATAL: $*"; exit 1; }
SSH() {
  case "$*" in
    'bash -s --'*) bash -c "export FAKE_REMOTE_PID=\\$\\$; exec $*" ;;
    *) bash -c "$*" ;;
  esac
}
${section}
echo finished`], { env: { ...f.env, ...opts.env }, encoding: 'utf8', timeout: 20000 });
  }
  const sudoCalls = (f: Fixture) => {
    try { return readFileSync(path.join(f.dir, 'sudo-calls'), 'utf8'); } catch { return ''; }
  };

  for (const [label, opts] of [
    ['a changed lockfile', { cached: true }],
    ['a Node Volta does not have yet', { lockSame: true }],
  ] as Array<[string, { lockSame?: boolean; cached?: boolean }]>) {
    it(`opens only HTTPS and DNS for ${label} and blocks again`, () => {
      const f = fixture();
      try {
        const result = deploy(f, opts);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assertNarrowWindow(f);
        assert.equal(rules(f.dir), f.before);
        assert.match(sudoCalls(f), /--version/);
        assert.equal(/ install /.test(sudoCalls(f)), !opts.lockSame);
      } finally {
        cleanup(f);
      }
    });
  }

  for (const [label, failed] of policyCases) {
    it(`restores ${label} ACCEPT while opening the dependency window`, () => {
      const f = fixture();
      try {
        const policyCommands = failed.split(' ').map(tool => `${tool} -P OUTPUT DROP`).join('\n');
        const set = spawnSync('sh', ['-c', policyCommands], { env: f.env, encoding: 'utf8' });
        assert.equal(set.status, 0, set.stderr);
        const result = deploy(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assertNarrowWindow(f);
        for (const family of ['v4', 'v6'] as const) assert.ok(windowRules(f)[family].includes('-P OUTPUT ACCEPT'));
        assert.equal(rules(f.dir), f.before);
      } finally { cleanup(f); }
    });

    it(`restores ${label} ACCEPT when closing the dependency window with an older block script`, () => {
      const f = fixture();
      try {
        const setPolicy = failed.split(' ').map(tool => `${tool} -P OUTPUT DROP`).join('\n');
        writeFileSync(path.join(f.dir, 'copy/scripts/block_internet_access.sh'), `#!/bin/sh\n${setPolicy}\n`);
        const result = deploy(f);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(rules(f.dir), f.before);
      } finally { cleanup(f); }
    });
  }

  it('leaves the firewall alone when nothing needs downloading', () => {
    const f = fixture();
    try {
      const result = deploy(f, { lockSame: true, cached: true });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(calls(f), '');
      assert.equal(sudoCalls(f), '');
    } finally {
      cleanup(f);
    }
  });

  it('puts a time limit on the remote installs', () => {
    assert.match(src, /run_limited 900 sudo -u dac bash -c "cd '\$STAGE\/server' && '\$NPM' install/);
    assert.match(src, /run_limited 600 sudo -u dac bash -c "cd '\$STAGE\/server' && '\$NPM' --version/);
  });

  it('opens and closes the window on iptables with a bare -w', () => {
    const f = fixture();
    try {
      const result = deploy(f, { env: { FAKE_IPT_W: 'bare' } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assertNarrowWindow(f);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });

  it('leaves Tailscale\'s own rules alone when the window rule is already gone', () => {
    const f = fixture(true);
    try {
      rmSync(path.join(f.dir, 'copy/scripts/block_internet_access.sh'));
      const result = deploy(f, { env: { FAKE_DROP_WINDOW: 'yes' } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(rules(f.dir), f.before);
    } finally {
      cleanup(f);
    }
  });

  it('closes the window and discards the stage when the remote shell is killed', () => {
    const f = fixture(true);
    try {
      const result = deploy(f, { env: { FAKE_KILL_REMOTE: 'yes' } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /FATAL: dependency download failed/);
      assertNarrowWindow(f);
      assert.equal(rules(f.dir), f.before);
      assert.equal(existsSync(path.join(f.dir, 'stage')), false, 'the stage should be removed after the window closes');
    } finally {
      cleanup(f);
    }
  });

  for (const [label, env] of [
    ['the install fails', { FAKE_INSTALL: 'fail' }],
    ['the SSH session hangs up', { FAKE_HANGUP: 'yes' }],
  ] as Array<[string, NodeJS.ProcessEnv]>) {
    it(`blocks again when ${label}`, () => {
      const f = fixture();
      try {
        const result = deploy(f, { env });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, /FATAL: /);
        assertNarrowWindow(f);
        assert.equal(rules(f.dir), f.before);
      } finally {
        cleanup(f);
      }
    });
  }
});

describe('firewall recovery persistence', () => {
  for (const family of ['iptables', 'ip6tables']) {
    for (const consumer of ['updater', 'stop-post']) {
      it(`${consumer} does not save rules without ${family} INPUT DROP`, () => {
        const f = fixture(false, 'none');
        try {
          const saved = ['iptables', 'ip6tables'].map(tool => readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'));
          const removed = spawnSync(family, ['-D', 'INPUT', '-j', 'DROP'], { env: f.env, encoding: 'utf8' });
          assert.equal(removed.status, 0, removed.stderr);
          for (const tool of ['iptables', 'ip6tables']) {
            const policy = spawnSync(tool, ['-P', 'OUTPUT', 'DROP'], { env: f.env, encoding: 'utf8' });
            assert.equal(policy.status, 0, policy.stderr);
          }
          const result = consumer === 'stop-post' ? runCloseScript(f)
            : spawnSync('bash', ['-c', driver('scripts/update.sh', 'restore_output_policy save')], {
              env: f.env, encoding: 'utf8', timeout: 10000,
            });
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assertPolicies(f);
          for (const [index, tool] of ['iptables', 'ip6tables'].entries()) {
            assert.equal(readFileSync(path.join(f.dir, `${tool}.rules`), 'utf8'), saved[index]);
          }
        } finally { cleanup(f); }
      });
    }
  }

  it('ships one firewall policy implementation used by updater and stop-post', () => {
    const updater = read('scripts/update.sh');
    const stopPost = read('scripts/close_update_window.sh');
    const switchScript = read('scripts/switch-to-upstream.sh');
    for (const source of [updater, stopPost, switchScript]) {
      assert.doesNotMatch(source, /restore_output_policy\(\)\s*\{|fw[46]\(\)\s*\{/);
      assert.match(source, /source .*restore_helpers[.]sh/);
    }
  });
});
