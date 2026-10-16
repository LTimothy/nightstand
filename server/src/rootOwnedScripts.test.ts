import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root runs scripts only from root-owned copies under /usr/local/lib/nightstand.
// The install trees and the rest of /home/dac belong to the server user, who
// could otherwise change what root runs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');
const TOOL = path.join(repoRoot, 'scripts/system_scripts.py');
// Every shell script root may run on the Pod: all of them but the tools run on
// a developer's computer. ops/deploy.sh and friends run their pod side as root.
const DEVELOPER_TOOLS = ['ops/build-agent.sh', 'scripts/check-bundles.sh', 'scripts/deploy-dev.sh',
  'scripts/promote_release.sh', 'scripts/release_digest.sh'];
const listed = (dir: string, ext: string) =>
  readdirSync(path.join(repoRoot, dir)).filter(name => name.endsWith(ext)).map(name => `${dir}/${name}`);
const ROOT_RUN = [...listed('scripts', '.sh'), ...listed('scripts/migrate', '.sh'), ...listed('ops', '.sh')]
  .filter(file => !DEVELOPER_TOOLS.includes(file));
// Python root runs: everything in scripts/ but the environment builder, which
// runs its commands as the server user.
const ROOT_RUN_PY = listed('scripts', '.py').filter(file => file !== 'scripts/prepare_upstream_env.py');
// Names that hold an install tree. Any variable assigned one of these, or a
// path under /home, is treated the same way in that file.
const TREE_NAMES = ['LIVE', 'PREV', 'STAGE', 'FAILED', 'REPO_DIR', 'SRC_DIR', 'TMP', 'RECOVERY_SOURCE', 'STAGE_INNER',
  'PREV_DIR', 'FAILED_DIR', 'SERVER_DIR', 'UNZIP_DIR', 'TARGET_DIR'];
// install.sh checks the fresh download with that download's digest script before the copy exists, as it always has.
const FROM: Record<string, string> = { 'scripts/install.sh': 'system_scripts.py" publish "$SRC_DIR"' };
// The one step that makes the copy runs the fresh tree's own tool, from a folder only root can write.
const PUBLISH = /^COPY=\$\(python3 -B "\$(SRC_DIR|FRESH)\/scripts\/system_scripts\.py" publish "\$\1"\) \\$/;
// The copy a publish prints is root's, whatever tree it was taken from.
const MAKES_COPY = /^"?\$\((?:SSH ")?python3 -B "?\$\{?\w+\}?\/(?:scripts\/)?system_scripts\.py"? (?:publish|find)\b/;
const ASSIGN = /(?:^|[;&|)]\s*)(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(\S.*)?$/;
const variable = (names: Set<string>) => String.raw`\$\{?(?:${[...names].join('|')})\}?(?![\w])`;

function treeNames(text: string) {
  const names = new Set(TREE_NAMES);
  const lines = text.split('\n').filter(line => !/^\s*#/.test(line));
  for (let grew = true; grew;) {
    grew = false;
    for (const line of lines) {
      const match = ASSIGN.exec(line);
      if (!match || names.has(match[1]) || MAKES_COPY.test(match[2] ?? '')) continue;
      if (/\/home\//.test(match[2] ?? '') || new RegExp(variable(names)).test(match[2] ?? '')) {
        names.add(match[1]);
        grew = true;
      }
    }
  }
  return names;
}

// Shell lines where root runs, sources or copies into the system a file the
// server user could have written.
function shellOffenders(file: string, text: string) {
  const tree = variable(treeNames(text));
  const runs = new RegExp(String.raw`(?:^|[\s;&|(\x60])(?:/(?:usr/)?bin/)?(?:bash|sh|python3?|node|source|exec|\.)(?:\s+-[A-Za-z]+)*`
    + String.raw`\s+["']?(?:${tree}|/home/)`);
  const direct = new RegExp(String.raw`(?:^|[;&|]\s*|\b(?:then|do|else)\s+)["']?${tree}/[^\s"']+\.(?:sh|py)\b`);
  const intoSystem = new RegExp(String.raw`\b(?:cp|install|rsync|ln)\s.*(?:${tree}|/home/).*\s["']?(?:/etc|/usr|/lib|/bin|/sbin|`
    + String.raw`\$\{?(?:PYTHON_LIB_DIR|SYSTEMD_DIR|SUDOERS_FILE|TMPFILES_DIR)\b)`);
  const lines = text.split('\n');
  const start = FROM[file] ? lines.findIndex(line => line.includes(FROM[file])) : 0;
  assert.ok(start >= 0, `${file}: missing ${FROM[file]}`);
  return lines.map((line, index) => ({ line, at: `${file}:${index + 1}` })).slice(start)
    // Comments, commands run as the server user, quoted text such as sudoers lines, and the publish step.
    .filter(({ line }) => !/^\s*#/.test(line) && !/\b(?:sudo|runuser) -u /.test(line) && !/^\s*"[^"]*"\s*$/.test(line)
      && !PUBLISH.test(line.trim()))
    .filter(({ line }) => runs.test(line) || direct.test(line) || intoSystem.test(line))
    .map(({ at, line }) => `${at}: ${line.trim()}`);
}

// Python lines that start an interpreter on anything but the scripts beside
// the running file (HERE) or a root-owned copy found for it.
const TRUSTED_PY = ['HERE', 'scripts', 'script', 'limits', 'helper', 'nightstand_scripts'];
// Switching to upstream free-sleep gives it back its own firewall script.
const OTHER_FORK = ["execute(['sh', str(config.live / 'scripts/block_internet_access.sh')])"];
function pythonOffenders(file: string, text: string) {
  const interpreter = String.raw`\b(?:run|execute|Popen|call|check_call|check_output)\(\s*`
    + String.raw`(?:\[\s*'(?:/(?:usr/)?bin/)?(?:bash|sh|python3?|node)'|\[\s*sys\.executable)\s*,\s*`;
  const started = new RegExp(interpreter + String.raw`(?!'-)(?:str\(\s*)?([A-Za-z_][\w.]*)`);
  const inline = /'-c'.*str\(\s*([A-Za-z_][\w.]*)/;
  return text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}` }))
    .filter(({ line }) => {
      if (OTHER_FORK.includes(line.trim())) return false;
      const name = (started.exec(line) ?? (/\b(?:run|execute|Popen)\(/.test(line) ? inline.exec(line) : null))?.[1];
      return name !== undefined && !TRUSTED_PY.includes(name);
    })
    .map(({ at, line }) => `${at}: ${line.trim()}`);
}
// With -c, -m or a script on stdin Python puts the working directory on its
// path, and the working directory may be the server user's. -I leaves it off.
function unisolatedOffenders(file: string, text: string) {
  return text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}` }))
    .filter(({ line }) => !/^\s*#/.test(line) && /(?:^|[\s;&|(/'"])python3?((?:\s+-[A-Za-z]+)*)\s+-(?:c|m|)(?=\s|$)/.test(line)
      && [...line.matchAll(/(?:^|[\s;&|(/'"])python3?((?:\s+-[A-Za-z]+)*)\s+-(?:c|m|)(?=\s|$)/g)]
        .some(match => !/\s-[A-Za-z]*[IP]/.test(match[1])))
    .map(({ at, line }) => `${at}: ${line.trim()}`);
}
const env = (system: string) => ({ ...process.env, NIGHTSTAND_SYSTEM_DIR: system });

function tree(dir: string, version: string, note = '') {
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'server/src'), { recursive: true });
  writeFileSync(path.join(dir, 'server/src/serverInfo.json'), JSON.stringify({ version }));
  writeFileSync(path.join(dir, 'scripts/update.sh'), `# nightstand-update-handoff: 1\n# ${version}${note}\n`);
  return dir;
}
function publish(system: string, dir: string) {
  const result = spawnSync('python3', ['-B', TOOL, 'publish', dir], { env: env(system), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const pointAt = (system: string, copy: string) =>
  assert.equal(spawnSync('python3', ['-B', TOOL, 'point', copy], { env: env(system) }).status, 0);
const live = (system: string) => readlinkSync(path.join(system, 'live'));
const copies = (system: string) => readdirSync(path.join(system, 'copies')).filter(name => !name.startsWith('.'));
const scratch = () => mkdtempSync(path.join(tmpdir(), 'nightstand-root-scripts-'));

describe('root runs nothing from the server user\'s folders', () => {
  it('runs no script from an install tree or /home/dac', () => {
    assert.deepEqual(ROOT_RUN.flatMap(file => shellOffenders(file, read(file))), []);
    assert.deepEqual(ROOT_RUN_PY.flatMap(file => pythonOffenders(file, read(file))), []);
  });

  it('catches each way a root-run script could run or install the server user\'s files', () => {
    const rollback = read('scripts/rollback_pod.sh');
    for (const probe of [
      'bash "$RECOVERY_SOURCE/scripts/evil.sh"',
      'D=/home/dac/free-sleep; bash "$D/scripts/evil.sh"',
      'D=/home/dac/free-sleep\nE="$D/scripts"\nsource "$E/evil.sh"',
      'D="$LIVE"; "$D/scripts/evil.sh"',
      'cp /home/dac/x /etc/cron.d/x',
      'install -m 755 "$STAGE/scripts/x" /usr/local/bin/x',
      'rsync -a "$LIVE/scripts/python/" "$PYTHON_LIB_DIR/"',
      'python3 -B "$STAGE_INNER/scripts/system_scripts.py" publish "$STAGE_INNER"',
    ]) {
      assert.notDeepEqual(shellOffenders('scripts/rollback_pod.sh', `${rollback}\n${probe}\n`), [], probe);
    }
    const runner = read('scripts/switch_installation.py');
    for (const probe of [
      "        subprocess.run(['bash', str(source / 'scripts/setup_services.sh'), str(source), '--recovery-only'])",
      "        subprocess.run(['bash', str(stage / 'scripts/migrate/fork-artifacts.sh'), 'clean'])",
      "        subprocess.run([sys.executable, str(self.live / 'scripts/x.py')])",
      "        subprocess.run(['bash', '-c', 'source \"$1\"', 'x', str(live / 'scripts/restore_helpers.sh')])",
    ]) {
      assert.notDeepEqual(pythonOffenders('scripts/switch_installation.py', `${runner}\n${probe}\n`), [], probe);
    }
  });

  it('runs inline Python as root only in isolated mode', () => {
    assert.deepEqual(ROOT_RUN.flatMap(file => unisolatedOffenders(file, read(file))), []);
    for (const probe of ["python3 -c 'import json'", 'python3 - "$1" <<\'PY\'', 'x=$(printf x | python3 -c "', 'python3 -B -c pass',
      'python3 -m json.tool', '/home/dac/venv/bin/python -c pass', 'ok && python3 -I -c pass; python3 -c pass']) {
      assert.notDeepEqual(unisolatedOffenders('scripts/x.sh', probe), [], probe);
    }
    for (const fine of ['python3 -I -c pass', 'python3 -B -I - "$1" <<\'PY\'', 'python3 -B "$COPY/scripts/x.py"', 'python3 -IB -c pass']) {
      assert.deepEqual(unisolatedOffenders('scripts/x.sh', fine), [], fine);
    }
  });

  it('keeps the recovery, restore and migration helpers out of /home/dac', () => {
    for (const [file, name] of [['scripts/update.sh', 'RECOVERY_HELPER'], ['scripts/migrate/pod-installer.sh', 'RESTORE_SCRIPT_DEST'],
      ['scripts/migrate/agent-bootstrap-installer.sh', 'RESTORE_SCRIPT_DEST']] as const) {
      assert.match(read(file), new RegExp(`^${name}=(?:/usr/local/lib/nightstand|\\$SYSTEM_DIR)/`, 'm'), `${file} ${name}`);
    }
    for (const file of ['scripts/setup_services.sh', 'scripts/switch_services.py', 'scripts/switch_installation.py',
      'scripts/migrate/restore-original-fork.sh', 'scripts/migrate/switch-to-this-fork.sh', 'ops/bootstrap-agent.sh']) {
      const helpers = /home\/dac\/(?:free-sleep-recovery|free-sleep-switch-recovery|migrate\/|restore-original-fork|agent-bootstrap-installer)/;
      assert.doesNotMatch(read(file), helpers, file);
    }
  });

  it('points every unit at the root-owned folder', () => {
    const units = readdirSync(path.join(repoRoot, 'scripts/systemd')).map(name => `scripts/systemd/${name}`);
    for (const file of [...units, 'scripts/setup_services.sh']) {
      for (const line of read(file).split('\n').filter(text => /^Exec[A-Za-z]*=/.test(text))) {
        assert.doesNotMatch(line, /\/home\/dac/, `${file}: ${line}`);
        if (/\.sh/.test(line) && file.endsWith('.service')) assert.match(line, /\/usr\/local\/lib\/nightstand\//, `${file}: ${line}`);
      }
    }
  });

  it('grants sudo for no file in /home/dac, and the server asks for the root-owned one', () => {
    const src = read('scripts/setup_services.sh');
    const rules = src.slice(src.indexOf('RULES=('), src.indexOf(')\n', src.indexOf('RULES=(')));
    assert.doesNotMatch(rules, /\/home\/dac/);
    assert.match(rules, /NOPASSWD: \/bin\/sh \/usr\/local\/lib\/nightstand\/live\/scripts\/disable_biometrics\.sh/);
    assert.doesNotMatch(rules, /enable_biometrics/);
    assert.match(read('server/src/jobs/biometrics.ts'), /'\/usr\/local\/lib\/nightstand\/live\/scripts\/disable_biometrics\.sh'/);
    const serverFiles = spawnSync('grep', ['-rln', '/home/dac/free-sleep/scripts', path.join(repoRoot, 'server/src'), '--include=*.ts'],
      { encoding: 'utf8' }).stdout.split('\n').filter(file => file && !file.endsWith('.test.ts'));
    assert.deepEqual(serverFiles, []);
  });
});

describe('which copy root runs after a tree comes back', () => {
  // rollback_pod.sh, the updater's own rollback and boot recovery all call this.
  const follow = (system: string, liveTree: string) => spawnSync('bash', ['-c',
    'say() { echo "$*"; }; LIVE="$1"; source "$2"; follow_scripts', 'follow', liveTree, path.join(repoRoot, 'scripts/restore_helpers.sh')],
  { env: env(system), encoding: 'utf8' });

  it('runs the previous version\'s own copy once its tree is back', () => {
    const dir = scratch();
    try {
      const system = path.join(dir, 'system');
      const current = publish(system, tree(path.join(dir, 'current'), '3.7.1'));
      const previous = publish(system, tree(path.join(dir, 'previous'), '3.7.0'));
      pointAt(system, current);
      const result = follow(system, path.join(dir, 'previous'));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(live(system), `copies/${path.basename(previous)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the current copy for a tree from before root-owned copies, or one the server user edited', () => {
    const dir = scratch();
    try {
      const system = path.join(dir, 'system');
      const current = publish(system, tree(path.join(dir, 'current'), '3.7.0'));
      pointAt(system, current);
      tree(path.join(dir, 'older'), '3.6.1');
      tree(path.join(dir, 'edited'), '3.7.0', ' with a line the server user added');
      for (const target of ['older', 'edited']) {
        const result = follow(system, path.join(dir, target));
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /keeps running the current ones/);
        assert.equal(live(system), `copies/${path.basename(current)}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('update.sh', () => {
  const update = read('scripts/update.sh');
  const between = (from: string, to: string) => {
    const start = update.indexOf(from);
    assert.ok(start >= 0, `missing ${from}`);
    const end = update.indexOf(to, start);
    assert.ok(end > start, `missing ${to}`);
    return update.slice(start, end);
  };

  function download(isDowngrade: 'yes' | 'no') {
    const dir = scratch();
    const release = tree(path.join(dir, 'release', 'nightstand-3.7.0'), '3.7.0');
    writeFileSync(path.join(release, 'scripts/archive-raw.sh'), 'RETENTION_HOURS=100\nMIN_FREE_KB=1\n');
    mkdirSync(path.join(dir, 'persistent/free-sleep-data'), { recursive: true });
    writeFileSync(path.join(dir, 'persistent/free-sleep-data/raw-archive.conf'), 'RETENTION_HOURS=200\n');
    spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
      path.join(dir, 'release'), path.join(dir, 'release')]);
    const section = between('# --- download + stage', 'chown -R dac:dac "$STAGE"').replaceAll('/persistent/', `${dir}/persistent/`);
    const result = spawnSync('bash', ['-c', `set -uo pipefail
SYSTEM_DIR="$FIXTURE/system"; STAGE="$FIXTURE/home/free-sleep-staging"; NIGHTSTAND_SCRIPTS="${repoRoot}/scripts"
EXPECTED_VERSION=3.7.0; RESOLVED_ZIP_URL=https://example.invalid/v3.7.0.zip; IS_DOWNGRADE=${isDowngrade}
mkdir -p "$FIXTURE/home"
say() { :; }
fail() { echo "FAIL $*"; exit 1; }
curl() { while [ "$1" != -o ]; do shift; done; cp "$FIXTURE/release.zip" "$2"; }
verify_tree() { echo "verify $1" >> "$FIXTURE/calls"; }
chown() { echo "chown $* published=$(ls "$SYSTEM_DIR/copies" | grep -vc '^[.]')" >> "$FIXTURE/calls"; }
${section}chown -R dac:dac "$STAGE"
echo "NEW_COPY=$NEW_COPY"`], { env: { ...env(path.join(dir, 'system')), FIXTURE: dir }, encoding: 'utf8' });
    return { dir, result, system: path.join(dir, 'system'), stage: path.join(dir, 'home/free-sleep-staging'),
      calls: existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8') : '' };
  }

  it('downloads, checks and copies the release for root before the server user can reach it', () => {
    const box = download('no');
    try {
      assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
      const copy = /NEW_COPY=(.*)/.exec(box.result.stdout)?.[1] ?? '';
      assert.equal(path.dirname(copy), path.join(box.system, 'copies'));
      assert.equal(readFileSync(path.join(copy, 'scripts/update.sh'), 'utf8'), readFileSync(path.join(box.stage, 'scripts/update.sh'), 'utf8'));
      assert.match(box.calls, new RegExp(`^verify ${box.system}/\\.download\\.[^/]+/tree/nightstand-3\\.7\\.0$`, 'm'));
      assert.match(box.calls, /^chown -R dac:dac \S+ published=1$/m);
      assert.deepEqual(readdirSync(box.system).filter(name => name.startsWith('.download.')), []);
    } finally { rmSync(box.dir, { recursive: true, force: true }); }
  });

  it('keeps the configured archive retention in the copy root runs on a downgrade', () => {
    const box = download('yes');
    try {
      assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
      const copy = /NEW_COPY=(.*)/.exec(box.result.stdout)?.[1] ?? '';
      for (const file of [path.join(copy, 'scripts/archive-raw.sh'), path.join(box.stage, 'scripts/archive-raw.sh')]) {
        assert.match(readFileSync(file, 'utf8'), /^RETENTION_HOURS=200$/m, file);
      }
    } finally { rmSync(box.dir, { recursive: true, force: true }); }
  });

  function handoff(fromStage: boolean) {
    const dir = scratch();
    const system = path.join(dir, 'system');
    const stage = tree(path.join(dir, 'stage'), '3.7.0');
    copyFileSync(TOOL, path.join(stage, 'scripts/system_scripts.py'));
    const source = fromStage ? stage : publish(system, stage);
    // The old updater gave its stage to the server user before handing off.
    if (fromStage) chmodSync(path.join(stage, 'scripts'), 0o777);
    const result = spawnSync('bash', ['-c', `set -uo pipefail
SYSTEM_DIR="$1"; STAGE="$2"; RECOVERY_SOURCE="$3"; NIGHTSTAND_SCRIPTS="$3/scripts"
fail() { echo "FAIL $*"; exit 1; }
${between('  [ -d "$STAGE" ] || fail "handed off', '  say "Continuing with')}
echo "NEW_COPY=$NEW_COPY"; echo "SCRIPTS=$NIGHTSTAND_SCRIPTS"`, 'handoff', system, stage, source], { env: env(system), encoding: 'utf8' });
    return { dir, system, source, result };
  }

  it('continues from a 3.6 updater\'s stage by copying that stage for root first', () => {
    const box = handoff(true);
    try {
      assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
      const copy = /NEW_COPY=(.*)/.exec(box.result.stdout)?.[1] ?? '';
      assert.equal(path.dirname(copy), path.join(box.system, 'copies'));
      assert.match(box.result.stdout, new RegExp(`^SCRIPTS=${copy}/scripts$`, 'm'));
    } finally { rmSync(box.dir, { recursive: true, force: true }); }
  });

  it('continues from a copy without making another', () => {
    const box = handoff(false);
    try {
      assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
      assert.match(box.result.stdout, new RegExp(`^NEW_COPY=${box.source}$`, 'm'));
      assert.equal(copies(box.system).length, 1);
    } finally { rmSync(box.dir, { recursive: true, force: true }); }
  });

  it('hands off to the new version\'s copy, never to the stage', () => {
    assert.match(update, /grep -Fxq "\$HANDOFF_MARKER" "\$NEW_COPY\/scripts\/update\.sh"/);
    assert.match(update, /exec bash "\$NEW_COPY\/scripts\/update\.sh"/);
    assert.doesNotMatch(update, /\$STAGE\/scripts\//);
  });

  it('points root at the new copy right after the swap, before the new units', () => {
    const swap = update.indexOf('mv "$STAGE" "$LIVE" ||');
    const point = update.indexOf('system_scripts.py" point "$NEW_COPY"');
    const services = update.indexOf('bash "$NEW_COPY/scripts/setup_services.sh" "$NEW_COPY"');
    assert.ok(swap > 0 && swap < point && point < services, `${swap} ${point} ${services}`);
  });

  it('puts root back on the restored tree\'s copy when the update rolls back', () => {
    const rollback = update.slice(update.indexOf('# --- automatic rollback'));
    assert.ok(rollback.indexOf('follow_scripts') > rollback.indexOf('mv "$PREV" "$LIVE"'), 'follow after the restore');
    const interrupted = between('finish_interrupted_swap() {', '\n}\n');
    assert.match(interrupted, /follow_scripts/);
  });
});

describe('rollback_pod.sh', () => {
  const rollback = read('scripts/rollback_pod.sh');
  it('moves root to the restored tree\'s copy only once that tree is healthy', () => {
    const healthy = rollback.slice(rollback.indexOf('if [ "$HEALTHY" = yes ]; then'), rollback.indexOf('# --- swap back'));
    const follow = healthy.indexOf('follow_scripts');
    assert.ok(follow >= 0 && follow < healthy.indexOf('SUCCESS'));
    assert.equal(rollback.match(/follow_scripts/g)?.length, 1);
  });
  it('gives another fork back its own updater', () => {
    const otherFork = rollback.slice(rollback.indexOf('if [ "$TARGET_IS_NIGHTSTAND" != yes ]; then\n    systemctl disable'));
    const own = 'sed -i \'s#/usr/local/lib/nightstand/live/scripts/#/home/dac/free-sleep/scripts/#g\''
      + ' /etc/systemd/system/free-sleep-update.service';
    assert.ok(otherFork.includes(own), otherFork);
  });
});
