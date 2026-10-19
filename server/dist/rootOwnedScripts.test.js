import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Root runs scripts only from root-owned copies under /usr/local/lib/nightstand.
// The install trees and the rest of /home/dac belong to the server user, who
// could otherwise change what root runs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');
const TOOL = path.join(repoRoot, 'scripts/system_scripts.py');
// Every shell script root may run on the Pod: all of them but the tools run on
// a developer's computer. ops/deploy.sh and friends run their pod side as root.
const DEVELOPER_TOOLS = ['ops/build-agent.sh', 'scripts/check-bundles.sh', 'scripts/deploy-dev.sh',
    'scripts/promote_release.sh', 'scripts/release_digest.sh'];
const listed = (dir, ext) => readdirSync(path.join(repoRoot, dir)).filter(name => name.endsWith(ext)).map(name => `${dir}/${name}`);
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
const FROM = { 'scripts/install.sh': 'system_scripts.py" publish "$SRC_DIR"' };
// The one step that makes the copy runs the fresh tree's own tool, from a folder only root can write.
const PUBLISH = /^COPY=\$\(python3 -B "\$(SRC_DIR|FRESH)\/scripts\/system_scripts\.py" publish "\$\1"\) \\$/;
// The copy a publish prints is root's, whatever tree it was taken from.
const MAKES_COPY = /^"?\$\((?:SSH ")?python3 -B "?\$\{?\w+\}?\/(?:scripts\/)?system_scripts\.py"? (?:publish|find)\b/;
const ASSIGN = /(?:^|[;&|)]\s*)(?:local\s+|export\s+|readonly\s+)?([A-Za-z_]\w*)=(\S.*)?$/;
const variable = (names) => String.raw `\$\{?(?:${[...names].join('|')})\}?(?![\w])`;
function treeNames(text) {
    const names = new Set(TREE_NAMES);
    const lines = text.split('\n').filter(line => !/^\s*#/.test(line));
    for (let grew = true; grew;) {
        grew = false;
        for (const line of lines) {
            const match = ASSIGN.exec(line);
            if (!match || names.has(match[1]) || MAKES_COPY.test(match[2] ?? ''))
                continue;
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
function shellOffenders(file, text) {
    const tree = variable(treeNames(text));
    const runs = new RegExp(String.raw `(?:^|[\s;&|(\x60])(?:/(?:usr/)?bin/)?(?:bash|sh|python3?|node|source|exec|\.)(?:\s+-[A-Za-z]+)*`
        + String.raw `\s+["']?(?:${tree}|/home/)`);
    const direct = new RegExp(String.raw `(?:^|[;&|]\s*|\b(?:then|do|else)\s+)["']?${tree}/[^\s"']+\.(?:sh|py)\b`);
    const intoSystem = new RegExp(String.raw `\b(?:cp|install|rsync|ln)\s.*(?:${tree}|/home/).*\s["']?(?:/etc|/usr|/lib|/bin|/sbin|`
        + String.raw `\$\{?(?:PYTHON_LIB_DIR|SYSTEMD_DIR|SUDOERS_FILE|TMPFILES_DIR)\b)`);
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
function pythonOffenders(file, text) {
    const interpreter = String.raw `\b(?:run|execute|Popen|call|check_call|check_output)\(\s*`
        + String.raw `(?:\[\s*'(?:/(?:usr/)?bin/)?(?:bash|sh|python3?|node)'|\[\s*sys\.executable)\s*,\s*`;
    const started = new RegExp(interpreter + String.raw `(?!'-)(?:str\(\s*)?([A-Za-z_][\w.]*)`);
    const inline = /'-c'.*str\(\s*([A-Za-z_][\w.]*)/;
    return text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => {
        if (OTHER_FORK.includes(line.trim()))
            return false;
        const name = (started.exec(line) ?? (/\b(?:run|execute|Popen)\(/.test(line) ? inline.exec(line) : null))?.[1];
        return name !== undefined && !TRUSTED_PY.includes(name);
    })
        .map(({ at, line }) => `${at}: ${line.trim()}`);
}
// Skipping the ownership check is for the stage a 3.6 updater hands off from, and nothing else.
function anyOwnerOffenders(files) {
    const uses = Object.entries(files).flatMap(([file, text]) => text.split('\n')
        .map((line, index) => ({ file, line, index, lines: text.split('\n') }))
        .filter(({ line }) => line.includes('--any-owner') && !/^\s*#/.test(line)));
    const handoff = (lines, index) => {
        const start = lines.indexOf('if [ "$HANDOFF" = 1 ]; then');
        const end = lines.findIndex((line, at) => at > start && /^(?:else|elif|fi)\b/.test(line));
        return start >= 0 && start < index && index < end;
    };
    const ok = uses.length === 1 && uses[0].file === 'scripts/update.sh' && handoff(uses[0].lines, uses[0].index)
        && /publish --any-owner "\$STAGE"\)/.test(uses[0].line);
    return ok ? [] : uses.map(({ file, index, line }) => `${file}:${index + 1}: ${line.trim()}`);
}
// The trees the publish exemption trusts come only from root's private download folder.
const TRUSTED_FROM = {
    WORK: /^(?:""|\$\(mktemp -d "\$SYSTEM_DIR\/\.download\.XXXXXX"\)(?: \\)?)$/,
    UNZIP_DIR: /^"\$WORK\/tree"$/,
    FRESH: /^(?:"\$WORK\/tree"|\$\(find "\$WORK\/tree" -mindepth 1 -maxdepth 1 -type d \| head -n1\))$/,
    SRC_DIR: /^\$\(find "\$UNZIP_DIR" -mindepth 1 -maxdepth 1 -type d \| head -n1\)$/,
    SYSTEM_DIR: /^(?:\/usr\/local\/lib\/nightstand|"\$\{NIGHTSTAND_SYSTEM_DIR:-\/usr\/local\/lib\/nightstand\}")$/,
};
function trustedOffenders(file, text) {
    if (!text.split('\n').some(line => PUBLISH.test(line.trim())))
        return [];
    return text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}`, match: ASSIGN.exec(line) }))
        .filter(({ line, match }) => !/^\s*#/.test(line) && match && match[1] in TRUSTED_FROM
        && !TRUSTED_FROM[match[1]].test((match[2] ?? '').trim()))
        .map(({ at, line }) => `${at}: ${line.trim()}`);
}
// With -c, -m or a script on stdin Python puts the working directory on its
// path, and the working directory may be the server user's. -I leaves it off.
function unisolatedOffenders(file, text) {
    const option = String.raw `(?:['"]?-[WX]['"]?\s+[^\s-]\S*|['"]?-[A-Za-z]+['"]?)`;
    const binary = String.raw `(?:^|[\s;&|(/'"])python(?:3(?:\.\d+)?)?['"]?`;
    const python = new RegExp(String.raw `${binary}((?:\s+${option})*\s+['"]?-(?:[A-Za-z]*[cm])?)['"]?(?=\s|$)`, 'g');
    return text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => !/^\s*#/.test(line)
        && [...line.matchAll(python)].some(match => !/(?:^|[\s'"])-[A-Za-z]*[IP]/.test(match[1])))
        .map(({ at, line }) => `${at}: ${line.trim()}`);
}
// Only the publish tool itself may name the ownership exemption in Python.
function pythonAnyOwnerOffenders(files) {
    return Object.entries(files).filter(([file]) => file !== 'scripts/system_scripts.py')
        .flatMap(([file, text]) => text.split('\n').map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => /any_owner\s*=\s*True/.test(line)).map(({ at, line }) => `${at}: ${line.trim()}`));
}
const env = (system) => ({ ...process.env, NIGHTSTAND_SYSTEM_DIR: system });
function tree(dir, version, note = '') {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, 'server/src'), { recursive: true });
    writeFileSync(path.join(dir, 'server/src/serverInfo.json'), JSON.stringify({ version }));
    writeFileSync(path.join(dir, 'scripts/update.sh'), `# nightstand-update-handoff: 1\n# ${version}${note}\n`);
    return dir;
}
function publish(system, dir) {
    const result = spawnSync('python3', ['-B', TOOL, 'publish', dir], { env: env(system), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
const pointAt = (system, copy) => assert.equal(spawnSync('python3', ['-B', TOOL, 'point', copy], { env: env(system) }).status, 0);
const live = (system) => readlinkSync(path.join(system, 'live'));
const copies = (system) => readdirSync(path.join(system, 'copies')).filter(name => !name.startsWith('.'));
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
    it('skips the ownership check only for the 3.6 handoff, and publishes only root\'s own download', () => {
        const all = [...ROOT_RUN, ...DEVELOPER_TOOLS, ...listed('scripts', '.py').filter(file => file !== 'scripts/system_scripts.py')];
        const texts = Object.fromEntries(all.map(file => [file, read(file)]));
        assert.deepEqual(anyOwnerOffenders(texts), []);
        const python = Object.fromEntries(spawnSync('git', ['ls-files', '*.py'], { cwd: repoRoot, encoding: 'utf8' }).stdout
            .split('\n').filter(Boolean).map(file => [file, read(file)]));
        assert.ok(Object.keys(python).length > 10);
        assert.deepEqual(pythonAnyOwnerOffenders(python), []);
        assert.notDeepEqual(pythonAnyOwnerOffenders({ ...python, 'scripts/switch_installation.py': 'copy = publish(tree, any_owner=True)' }), []);
        assert.deepEqual(ROOT_RUN.flatMap(file => trustedOffenders(file, read(file))), []);
        for (const [file, probe] of [['scripts/rollback_pod.sh', 'python3 -B "$NIGHTSTAND_SCRIPTS/system_scripts.py" publish --any-owner "$LIVE"'],
            ['scripts/install.sh', 'COPY=$(python3 -B "$TOOL" publish --any-owner "$STAGE")']]) {
            assert.notDeepEqual(anyOwnerOffenders({ ...texts, [file]: `${texts[file]}\n${probe}\n` }), [], probe);
        }
        for (const [file, probe] of [['scripts/migrate/pod-installer.sh', 'FRESH="$STAGE"'],
            ['scripts/install.sh', 'SRC_DIR=/home/dac/free-sleep'], ['scripts/migrate/agent-bootstrap-installer.sh', 'WORK=$(mktemp -d)'],
            ['scripts/install.sh', 'UNZIP_DIR="free-sleep-unzip"'], ['scripts/migrate/pod-installer.sh', 'SYSTEM_DIR=/home/dac/system']]) {
            assert.notDeepEqual(trustedOffenders(file, `${read(file)}\n${probe}\n`), [], probe);
        }
    });
    it('runs the biometrics venv only as the server user', () => {
        // Each command that starts the venv's python or makes the venv must itself be
        // the one sudo runs as dac; a file test and a unit's ExecStart run nothing as root.
        const offenders = (file, text) => text.split('\n')
            .filter(line => !/^\s*#/.test(line))
            .filter(line => [...line.matchAll(/\/home\/dac\/venv\/bin\/python|\bpython3(?: -\w+)* -m venv \/home\/dac/g)]
            .some(match => !/(?:sudo (?:-H )?-u dac |-x |ExecStart=)$/.test(line.slice(0, match.index))))
            .map(line => `${file}: ${line.trim()}`);
        assert.deepEqual(ROOT_RUN.flatMap(file => offenders(file, read(file))), []);
        for (const probe of ['/home/dac/venv/bin/python -I -m pip install x', 'cd x && /home/dac/venv/bin/python calibrate.py',
            'python3 -I -m venv /home/dac/venv', 'run_limited 600 "${RUNNER[@]}" /home/dac/venv/bin/python -I -m pip install x',
            'sudo -u dac true && /home/dac/venv/bin/python -I -m pip install x', 'sudo -u dac true; python3 -I -m venv /home/dac/venv',
            'sudo -u dac /home/dac/venv/bin/python -c pass && /home/dac/venv/bin/python calibrate.py']) {
            assert.notDeepEqual(offenders('scripts/x.sh', probe), [], probe);
        }
        const upstream = read('scripts/switch-to-upstream.sh');
        assert.match(upstream, /stat -L -c '%U' \/home\/dac\/venv/);
        assert.doesNotMatch(upstream, /installing the upstream dependency as root/);
    });
    it('runs inline Python as root only in isolated mode', () => {
        assert.deepEqual(ROOT_RUN.flatMap(file => unisolatedOffenders(file, read(file))), []);
        for (const probe of ["python3 -c 'import json'", 'python3 - "$1" <<\'PY\'', 'x=$(printf x | python3 -c "', 'python3 -B -c pass',
            'python3 -m json.tool', '/home/dac/venv/bin/python -c pass', 'ok && python3 -I -c pass; python3 -c pass',
            'python3 -Bc \'import json\'', 'python3 "-Bc" pass', 'python3 -W ignore -c pass', 'python3 -X utf8 -c pass',
            '"$VENV/bin/python" -c pass', '/usr/bin/python3.11 -B -m json.tool', '"$VENV/bin/python3.9" -Wignore -c pass']) {
            assert.notDeepEqual(unisolatedOffenders('scripts/x.sh', probe), [], probe);
        }
        for (const fine of ['python3 -I -c pass', 'python3 -B -I - "$1" <<\'PY\'', 'python3 -B "$COPY/scripts/x.py"', 'python3 -IB -c pass',
            'python3 -Ic pass', 'python3 -W ignore -I -c pass', '"$VENV/bin/python" -I -X utf8 -c pass', 'python3 -B "$COPY/x.py" -c']) {
            assert.deepEqual(unisolatedOffenders('scripts/x.sh', fine), [], fine);
        }
    });
    it('keeps the recovery, restore and migration helpers out of /home/dac', () => {
        for (const [file, name] of [['scripts/update.sh', 'RECOVERY_HELPER'], ['scripts/migrate/pod-installer.sh', 'RESTORE_SCRIPT_DEST'],
            ['scripts/migrate/agent-bootstrap-installer.sh', 'RESTORE_SCRIPT_DEST']]) {
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
                if (/\.sh/.test(line) && file.endsWith('.service'))
                    assert.match(line, /\/usr\/local\/lib\/nightstand\//, `${file}: ${line}`);
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
        const serverFiles = spawnSync('grep', ['-rln', '/home/dac/free-sleep/scripts', path.join(repoRoot, 'server/src'), '--include=*.ts'], { encoding: 'utf8' }).stdout.split('\n').filter(file => file && !file.endsWith('.test.ts'));
        assert.deepEqual(serverFiles, []);
    });
});
describe('which copy root runs after a tree comes back', () => {
    // rollback_pod.sh, the updater's own rollback and boot recovery all call this.
    const follow = (system, liveTree) => spawnSync('bash', ['-c',
        'say() { echo "$*"; }; LIVE="$1"; source "$2"; follow_scripts', 'follow', liveTree, path.join(repoRoot, 'scripts/restore_helpers.sh')], { env: env(system), encoding: 'utf8' });
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
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('update.sh', () => {
    const update = read('scripts/update.sh');
    const between = (from, to) => {
        const start = update.indexOf(from);
        assert.ok(start >= 0, `missing ${from}`);
        const end = update.indexOf(to, start);
        assert.ok(end > start, `missing ${to}`);
        return update.slice(start, end);
    };
    const helpers = read('scripts/restore_helpers.sh');
    const moveTree = helpers.slice(helpers.indexOf('move_tree() {'), helpers.indexOf('\n}\n', helpers.indexOf('move_tree() {')) + 3);
    it('a refused move leaves no marker behind in the tree', () => {
        const dir = scratch();
        try {
            mkdirSync(path.join(dir, 'live'));
            mkdirSync(path.join(dir, 'prev/taken'), { recursive: true });
            const result = spawnSync('bash', ['-c', `${moveTree}\nmove_tree "$1/live" "$1/prev"`, 'x', dir], { encoding: 'utf8' });
            assert.notEqual(result.status, 0);
            assert.deepEqual(readdirSync(path.join(dir, 'live')), []);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    function download(isDowngrade, setup = '') {
        const dir = scratch();
        const release = tree(path.join(dir, 'release', 'nightstand-3.7.0'), '3.7.0');
        writeFileSync(path.join(release, 'scripts/archive-raw.sh'), 'RETENTION_HOURS=100\nMIN_FREE_KB=1\n');
        mkdirSync(path.join(dir, 'persistent/free-sleep-data'), { recursive: true });
        writeFileSync(path.join(dir, 'persistent/free-sleep-data/raw-archive.conf'), 'RETENTION_HOURS=200\n');
        spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
            path.join(dir, 'release'), path.join(dir, 'release')]);
        const section = between('# --- download + stage', 'chown -hR dac:dac "$STAGE"').replaceAll('/persistent/', `${dir}/persistent/`);
        const result = spawnSync('bash', ['-c', `set -uo pipefail
SYSTEM_DIR="$FIXTURE/system"; STAGE="$FIXTURE/home/free-sleep-staging"; NIGHTSTAND_SCRIPTS="${repoRoot}/scripts"
EXPECTED_VERSION=3.7.0; RESOLVED_ZIP_URL=https://example.invalid/v3.7.0.zip; IS_DOWNGRADE=${isDowngrade}
mkdir -p "$FIXTURE/home" "$FIXTURE/outside"
say() { :; }
fail() { echo "FAIL $*"; exit 1; }
curl() { while [ "$1" != -o ]; do shift; done; cp "$FIXTURE/release.zip" "$2"; }
verify_tree() { echo "verify $1" >> "$FIXTURE/calls"; }
chown() { echo "chown $* published=$(ls "$SYSTEM_DIR/copies" | grep -vc '^[.]')" >> "$FIXTURE/calls"; }
${moveTree}
${setup}
${section}chown -hR dac:dac "$STAGE"
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
            assert.match(box.calls, /^chown -hR dac:dac \S+ published=1$/m);
            assert.deepEqual(readdirSync(box.system).filter(name => name.startsWith('.download.')), []);
        }
        finally {
            rmSync(box.dir, { recursive: true, force: true });
        }
    });
    it('stops before the chown when the server user swaps the stage for a symlink', () => {
        // The server user owns /home/dac, so it can put a symlink back between
        // the rm and the move. GNU mv -T is a rename that never follows it.
        const race = 'rm() { command rm "$@"; [ "${!#}" != "$STAGE" ] || ln -s "$FIXTURE/outside" "$STAGE"; }';
        const gnuMv = 'mv() { if [ "$1" = -T ]; then python3 -c \'import os, sys; os.rename(*sys.argv[1:])\' "$2" "$3"; else command mv "$@"; fi; }';
        for (const emulate of ['', gnuMv]) {
            const box = download('no', `${race}\n${emulate}`);
            try {
                assert.match(box.result.stdout, /^FAIL could not stage v3\.7\.0$/m, box.result.stdout + box.result.stderr);
                assert.deepEqual(readdirSync(path.join(box.dir, 'outside')), []);
                assert.doesNotMatch(box.calls, /chown/);
            }
            finally {
                rmSync(box.dir, { recursive: true, force: true });
            }
        }
    });
    it('keeps the configured archive retention in the copy root runs on a downgrade', () => {
        const box = download('yes');
        try {
            assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
            const copy = /NEW_COPY=(.*)/.exec(box.result.stdout)?.[1] ?? '';
            for (const file of [path.join(copy, 'scripts/archive-raw.sh'), path.join(box.stage, 'scripts/archive-raw.sh')]) {
                assert.match(readFileSync(file, 'utf8'), /^RETENTION_HOURS=200$/m, file);
            }
        }
        finally {
            rmSync(box.dir, { recursive: true, force: true });
        }
    });
    function handoff(fromStage) {
        const dir = scratch();
        const system = path.join(dir, 'system');
        const stage = tree(path.join(dir, 'stage'), '3.7.0');
        copyFileSync(TOOL, path.join(stage, 'scripts/system_scripts.py'));
        const source = fromStage ? stage : publish(system, stage);
        // The old updater gave its stage to the server user before handing off.
        if (fromStage)
            chmodSync(path.join(stage, 'scripts'), 0o777);
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
        }
        finally {
            rmSync(box.dir, { recursive: true, force: true });
        }
    });
    it('continues from a copy without making another', () => {
        const box = handoff(false);
        try {
            assert.equal(box.result.status, 0, box.result.stdout + box.result.stderr);
            assert.match(box.result.stdout, new RegExp(`^NEW_COPY=${box.source}$`, 'm'));
            assert.equal(copies(box.system).length, 1);
        }
        finally {
            rmSync(box.dir, { recursive: true, force: true });
        }
    });
    it('hands off to the new version\'s copy, never to the stage', () => {
        assert.match(update, /grep -Fxq "\$HANDOFF_MARKER" "\$NEW_COPY\/scripts\/update\.sh"/);
        assert.match(update, /exec bash "\$NEW_COPY\/scripts\/update\.sh"/);
        assert.doesNotMatch(update, /\$STAGE\/scripts\//);
    });
    it('points root at the new copy right after the swap, before the new units', () => {
        const swap = update.indexOf('move_tree "$STAGE" "$LIVE" ||');
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
describe('trees moved into the server user\'s folder', () => {
    const helper = (src) => {
        const start = src.indexOf('move_tree() {');
        assert.ok(start >= 0);
        return src.slice(start, src.indexOf('\n}\n', start) + 3);
    };
    it('every script moves them with the same checked move_tree', () => {
        const reference = helper(read('scripts/restore_helpers.sh'));
        for (const file of ['scripts/install.sh', 'scripts/migrate/pod-installer.sh',
            'scripts/migrate/agent-bootstrap-installer.sh', 'ops/deploy.sh', 'ops/rollback.sh',
            'scripts/migrate/switch-to-this-fork.sh']) {
            assert.equal(helper(read(file)), reference, file);
        }
    });
    // The server user can put a symlink where root is about to move a tree.
    const plantAfterRm = (...targets) => `mkdir -p "$FIXTURE/outside"
rm() { command rm "$@"; case "\${!#}" in ${targets.join('|')}) ln -s "$FIXTURE/outside" "\${!#}";; esac; }`;
    const gnuMv = 'mv() { if [ "$1" = -T ]; then python3 -c \'import os, sys; os.rename(*sys.argv[1:])\' "$2" "$3"; else command mv "$@"; fi; }';
    function switchDownload(setup = '') {
        const dir = scratch();
        const release = path.join(dir, 'release', 'free-sleep-abc');
        mkdirSync(path.join(release, 'server'), { recursive: true });
        writeFileSync(path.join(release, 'server/marker'), 'upstream');
        spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
            path.join(dir, 'release'), path.join(dir, 'release')]);
        const src = read('scripts/switch-to-upstream.sh');
        const start = src.indexOf('say "Downloading upstream');
        const section = src.slice(start, src.indexOf('chown -hR dac:dac "$STAGE"', start));
        const result = spawnSync('bash', ['-c', `set -uo pipefail
SYSTEM_DIR="$FIXTURE/system"; STAGE="$FIXTURE/home/free-sleep-revert-staging"; ZIP="$FIXTURE/home/free-sleep-revert.zip"
SWITCH_COMMIT=abc; UPSTREAM_ZIP_URL=https://example.invalid/abc.zip
mkdir -p "$FIXTURE/home"
say() { :; }
fail() { echo "FAIL $*"; exit 1; }
curl() { while [ "$1" != -o ]; do shift; done; cp "$FIXTURE/release.zip" "$2"; }
chown() { echo "chown $*" >> "$FIXTURE/calls"; }
${helper(read('scripts/restore_helpers.sh'))}
${setup}
${section}chown -hR dac:dac "$STAGE"
echo STAGED`], { env: { ...process.env, FIXTURE: dir }, encoding: 'utf8' });
        const list = (name) => (existsSync(path.join(dir, name)) ? readdirSync(path.join(dir, name)) : []);
        return { dir, result, outside: list('outside'), staged: list('home/free-sleep-revert-staging/server'),
            calls: existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8') : '' };
    }
    it('switch-to-upstream.sh unpacks upstream where only root can write, then stages it', () => {
        const box = switchDownload();
        try {
            assert.match(box.result.stdout, /^STAGED$/m, box.result.stdout + box.result.stderr);
            assert.deepEqual(box.staged, ['marker']);
            assert.match(box.calls, /^chown -hR dac:dac \S+free-sleep-revert-staging$/m);
        }
        finally {
            rmSync(box.dir, { recursive: true, force: true });
        }
    });
    it('switch-to-upstream.sh unpacks nothing into a symlink the server user plants', () => {
        for (const emulate of ['', gnuMv]) {
            const box = switchDownload(`${plantAfterRm('"$STAGE"', '"$STAGE.unzip"')}\n${emulate}`);
            try {
                assert.match(box.result.stdout, /^FAIL could not stage upstream; live install untouched$/m, box.result.stdout + box.result.stderr);
                assert.deepEqual(box.outside, []);
                assert.doesNotMatch(box.calls, /chown/);
            }
            finally {
                rmSync(box.dir, { recursive: true, force: true });
            }
        }
    });
    it('restore_dependencies moves nothing into a symlink planted at the live node_modules', () => {
        const dir = scratch();
        try {
            for (const tree of ['live', 'failed']) {
                mkdirSync(path.join(dir, tree, 'server'), { recursive: true });
                writeFileSync(path.join(dir, tree, 'server/package-lock.json'), 'same');
            }
            mkdirSync(path.join(dir, 'failed/server/node_modules'));
            mkdirSync(path.join(dir, 'outside'));
            // Planted after the check that no node_modules is there.
            const result = spawnSync('bash', ['-c', `source "$1"; LIVE="$FIXTURE/live"
cmp() { ln -s "$FIXTURE/outside" "$LIVE/server/node_modules"; command cmp "$@"; }
chown() { echo "chown $*"; }
restore_dependencies "$FIXTURE/failed"`, 'test', path.join(repoRoot, 'scripts/restore_helpers.sh')], { env: { ...process.env, FIXTURE: dir }, encoding: 'utf8' });
            assert.deepEqual(readdirSync(path.join(dir, 'outside')), []);
            assert.doesNotMatch(result.stdout, /chown/);
            assert.match(result.stdout, /WARNING: could not move dependencies back/);
            assert.ok(existsSync(path.join(dir, 'failed/server/node_modules')));
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('moves no tree with a plain mv', () => {
        // Files, not trees: the settings carried over from old installs and the restore progress note.
        const files = /SOURCE_FILE|RESTORE_STATE\.tmp/;
        for (const file of ['scripts/update.sh', 'scripts/switch-to-upstream.sh', 'scripts/rollback_pod.sh',
            'scripts/recover_update.sh', 'scripts/restore_helpers.sh', 'scripts/install.sh',
            'scripts/migrate/restore-original-fork.sh', 'scripts/migrate/pod-installer.sh',
            'scripts/migrate/agent-bootstrap-installer.sh', 'scripts/migrate/switch-to-this-fork.sh',
            'ops/deploy.sh', 'ops/rollback.sh']) {
            const text = read(file);
            const start = text.indexOf('move_tree() {');
            const rest = start < 0 ? text : text.slice(0, start) + text.slice(text.indexOf('\n}\n', start) + 3);
            const lines = rest.split('\n').filter(line => !/^\s*#/.test(line) && /(?:^|[\s{(|&;])mv\s+\\?["$]/.test(line) && !files.test(line));
            assert.deepEqual(lines, [], file);
        }
    });
    it('never chowns recursively through a symlink', () => {
        const files = spawnSync('git', ['ls-files', 'scripts', 'ops'], { cwd: repoRoot, encoding: 'utf8' })
            .stdout.split('\n').filter(file => /\.(sh|py)$/.test(file) && !file.startsWith('scripts/tests/'));
        for (const file of files)
            assert.doesNotMatch(read(file), /chown -R\b/, file);
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
describe('health checks', () => {
    // Each script's health loop, with its fixed paths moved into a temp tree.
    const HEALTH = [
        ['scripts/update.sh', 'home/free-sleep-staging.health'],
        ['scripts/switch-to-upstream.sh', 'home/free-sleep-revert-staging.health'],
        ['scripts/rollback_pod.sh', 'tmp/free-sleep-rollback-health'],
        ['scripts/migrate/pod-installer.sh', 'tmp/free-sleep-migrate-health'],
    ];
    const healthBlock = (file) => {
        const src = read(file);
        const start = src.lastIndexOf('say "Health check (up to 90s)"');
        const end = file === 'scripts/update.sh' ? src.indexOf('\nfi\n', start) + 4 : src.indexOf('rm -f "$HBODY"\n', start) + 15;
        const helper = file === 'scripts/update.sh' ? src.slice(src.indexOf('serves_version() {'), start) : '';
        assert.ok(start > 0 && end > start, file);
        return helper + src.slice(start, end);
    };
    for (const [file, planted] of HEALTH) {
        it(`${file} saves the answer in a fresh file, never through a link at a fixed name`, () => {
            const dir = mkdtempSync(path.join(tmpdir(), 'health-body-'));
            try {
                mkdirSync(path.join(dir, 'tmp'));
                mkdirSync(path.join(dir, 'home'));
                const victim = path.join(dir, 'victim');
                writeFileSync(victim, 'keep');
                symlinkSync(victim, path.join(dir, planted));
                const block = healthBlock(file).replaceAll('/tmp/', `${dir}/tmp/`).replaceAll('/home/dac', `${dir}/home`);
                const result = spawnSync('bash', ['-c', `set -uo pipefail
say() { :; }; sleep() { :; }; systemctl() { :; }
curl() {
  local out=/dev/null; while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
  printf '{"freeSleep":{"version":"9.9.9"},"left":{"currentTemperatureF":80}}' > "$out"; printf 200
}
STAGE='${dir}/home/${path.basename(planted).replace(/\.health$/, '')}'
STAGED_VERSION=9.9.9 TARGET_VERSION=9.9.9 MIGRATION_FAILED=no BASELINE_FILE=
${block}
echo "HEALTHY=$HEALTHY"`], { encoding: 'utf8', env: { ...process.env, TMPDIR: path.join(dir, 'tmp') } });
                assert.match(result.stdout, /HEALTHY=yes/, result.stdout + result.stderr);
                assert.equal(readFileSync(victim, 'utf8'), 'keep');
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        it(`${file} fails the health check at once when it cannot make the temp file`, () => {
            const dir = mkdtempSync(path.join(tmpdir(), 'health-body-'));
            try {
                const block = healthBlock(file).replaceAll('/tmp/', `${dir}/`).replaceAll('/home/dac', dir);
                const result = spawnSync('bash', ['-c', `set -uo pipefail
say() { echo "$*"; }; sleep() { :; }; systemctl() { :; }; mktemp() { return 1; }
curl() { echo called >> '${dir}/curl'; printf 200; }
STAGE='${dir}/stage'; STAGED_VERSION=9.9.9 TARGET_VERSION=9.9.9 MIGRATION_FAILED=no BASELINE_FILE=
${block}
echo "HEALTHY=$HEALTHY"`], { encoding: 'utf8' });
                assert.match(result.stdout, /HEALTHY=no/, result.stdout + result.stderr);
                assert.match(result.stdout, /could not create a temporary file/);
                assert.equal(existsSync(path.join(dir, 'curl')), false);
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});
describe('root writes into the server user\'s data folder', () => {
    const between = (file, from, to) => {
        const src = read(file);
        const start = src.indexOf(from);
        const end = src.indexOf(to, start);
        assert.ok(start >= 0 && end > start, `${file}: ${from}`);
        return src.slice(start, end + to.length);
    };
    const box = (body) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'data-writes-'));
        try {
            const data = path.join(dir, 'persistent/free-sleep-data');
            mkdirSync(path.join(data, 'lowdb'), { recursive: true });
            body(dir, data);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
    const run = (dir, block, prelude = '') => spawnSync('bash', ['-c', `set -uo pipefail
say() { echo "$*"; }
systemctl() { [ "$1" != is-active ] || { echo inactive; return 3; }; }
${prelude}
${block.replaceAll('/persistent/', `${dir}/persistent/`).replaceAll('/home/dac', `${dir}/home`)}`], { encoding: 'utf8' });
    // The server user puts the link back right after root removes it.
    const racingRm = (links) => `rm() {
  command rm "$@"; local a
  for a in "$@"; do
${links.map(([at, to]) => `    [ "$a" != '${at}' ] || ln -s '${to}' '${at}'`).join('\n')}
  done
}
`;
    it('install.sh records the socket path and moves old settings without following links', () => {
        box((dir, data) => {
            mkdirSync(path.join(dir, 'home/free-sleep-database'), { recursive: true });
            writeFileSync(path.join(dir, 'home/free-sleep-database/settingsDB.json'), 'old settings');
            writeFileSync(path.join(dir, 'frank.sh'), 'DAC_SOCKET=/run/dac.sock\n');
            mkdirSync(path.join(dir, 'outside'));
            const settings = path.join(data, 'lowdb/settingsDB.json');
            const sock = path.join(data, 'dac_sock_path.txt');
            symlinkSync(path.join(dir, 'outside'), settings);
            symlinkSync(path.join(dir, 'created'), sock);
            const block = between('scripts/install.sh', '# Puts text $2', '\ndone\n')
                .replace('/opt/eight/bin/frank.sh', path.join(dir, 'frank.sh'));
            const race = racingRm([[settings, path.join(dir, 'outside')], [sock, path.join(dir, 'created')]]);
            const result = run(dir, `grep() { echo /run/dac.sock; }\n${block}`, race);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.deepEqual(readdirSync(path.join(dir, 'outside')), []);
            assert.equal(existsSync(path.join(dir, 'created')), false);
            assert.equal(readFileSync(sock, 'utf8'), '/run/dac.sock\n');
            assert.equal(readFileSync(settings, 'utf8'), 'old settings');
            assert.equal(existsSync(path.join(dir, 'home/free-sleep-database/settingsDB.json')), false);
        });
    });
    it('install.sh reads an old settings file without following a link swapped in after its check', () => {
        box((dir, data) => {
            const source = path.join(dir, 'home/free-sleep-database/settingsDB.json');
            mkdirSync(path.dirname(source), { recursive: true });
            writeFileSync(source, 'old settings');
            writeFileSync(path.join(dir, 'secret'), 'root only');
            const block = between('scripts/install.sh', '# Puts text $2', '\ndone\n')
                .replace('/opt/eight/bin/frank.sh', path.join(dir, 'missing'));
            // Whatever reads the source next finds a link to a root-only file.
            const swap = `swap() { case "$*" in *'${source}'*) command rm -f '${source}'; ln -s '${path.join(dir, 'secret')}' '${source}';; esac; }
cp() { swap "$@"; command cp "$@"; }
python3() { swap "$@"; command python3 "$@"; }`;
            run(dir, block, swap);
            const settings = path.join(data, 'lowdb/settingsDB.json');
            assert.ok(!existsSync(settings) || !readFileSync(settings, 'utf8').includes('root only'));
        });
    });
    it('install.sh leaves no temporary file in /persistent when it cannot put one in place', () => {
        box((dir, data) => {
            writeFileSync(path.join(dir, 'frank.sh'), 'DAC_SOCKET=/run/dac.sock\n');
            mkdirSync(path.join(data, 'dac_sock_path.txt', 'busy'), { recursive: true });
            const block = between('scripts/install.sh', '# Puts text $2', '\ndone\n')
                .replace('/opt/eight/bin/frank.sh', path.join(dir, 'frank.sh'));
            run(dir, `grep() { echo /run/dac.sock; }\n${block}`);
            assert.deepEqual(readdirSync(path.join(dir, 'persistent')).filter(name => name.startsWith('.')), []);
        });
    });
    it('switch-to-upstream.sh puts the settings back without following links', () => {
        box((dir, data) => {
            const bk = path.join(dir, 'bk');
            mkdirSync(path.join(bk, 'lowdb'), { recursive: true });
            for (const name of ['settingsDB.json', 'schedulesDB.json'])
                writeFileSync(path.join(bk, 'lowdb', name), `saved ${name}`);
            writeFileSync(path.join(dir, 'victim'), 'keep');
            const settings = path.join(data, 'lowdb/settingsDB.json');
            symlinkSync(path.join(dir, 'victim'), settings);
            const fn = between('scripts/switch-to-upstream.sh', 'restore_switch_data() {', '\n}\n');
            const race = racingRm([[settings, path.join(dir, 'victim')]]);
            const result = run(dir, `${fn}
DATA_CHANGED=yes RESTORE_ATTEMPTED=no ARCHIVE_WAS_ACTIVE=inactive BK='${bk}'\nrestore_switch_data`, race);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(readFileSync(path.join(dir, 'victim'), 'utf8'), 'keep');
            assert.equal(readFileSync(settings, 'utf8'), 'saved settingsDB.json');
            assert.deepEqual(readdirSync(path.join(dir, 'persistent')).filter(name => name.startsWith('.')), []);
        });
    });
});
describe('pod-installer.sh database preflight', () => {
    it('copies the snapshot into a folder root made, never into the server user\'s stage', () => {
        const src = read('scripts/migrate/pod-installer.sh');
        const start = src.indexOf('say "Database compatibility preflight');
        const block = src.slice(start, src.indexOf('\nfi\n', src.indexOf('say "Database snapshot retained', start)) + 4);
        const dir = mkdtempSync(path.join(tmpdir(), 'db-preflight-'));
        try {
            mkdirSync(path.join(dir, 'persistent/free-sleep-data'), { recursive: true });
            writeFileSync(path.join(dir, 'persistent/free-sleep-data/free-sleep.db'), 'db');
            mkdirSync(path.join(dir, 'copy/scripts'), { recursive: true });
            writeFileSync(path.join(dir, 'copy/scripts/sqlite-safety.py'), '');
            const result = spawnSync('bash', ['-c', `set -uo pipefail
say() { :; }; fail() { echo "FAIL $*"; exit 1; }
python3() { echo "python3 $*" >> '${dir}/calls'; }
chown() { :; }; sudo() { :; }
mktemp() { echo "mktemp $*" >> '${dir}/calls'; command mktemp "$@"; }
COPY='${dir}/copy'; STAGE='${dir}/stage'; NPX=npx
${block.replaceAll('/persistent/', `${dir}/persistent/`)}`], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            const calls = readFileSync(path.join(dir, 'calls'), 'utf8');
            assert.doesNotMatch(calls, /\/stage\//);
            assert.match(calls, /^mktemp -d \S+\/persistent\/\.nightstand-db-preflight\.XXXXXX$/m);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=rootOwnedScripts.test.js.map