import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Runs scripts/enable_biometrics.sh with its helper scripts, the venv python
// and curl replaced by stubs that record what ran. A first install used to
// leave Biometrics reading off in the app while the stream ran.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Records the user a command runs as, then runs it.
const SUDO = (calls) => `echo "sudo $*" >> "${calls}"\n[ "$1" != -H ] || shift\n[ "$1" != -u ] || shift 2\nexec "$@"`;
// The server user runs every file in its own tree.
const asDac = (log, pattern) => log.some((line, at) => /^sudo (?:-H )?-u dac /.test(line) && pattern.test(line) && log[at + 1]?.startsWith('python '));
function run({ installed = false, calibrationFails = false, refuseOn = false, natsImports = true, pipFails = false, lock = '', shell = '', logTimeout = false, stubs = {}, timeoutStub = '', async = false, limit = 900 } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-enable-biometrics-'));
    const home = path.join(dir, 'home');
    const scripts = path.join(home, 'free-sleep', 'scripts');
    const bin = path.join(dir, 'bin');
    const calls = path.join(dir, 'calls');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(path.join(home, 'free-sleep', 'biometrics', 'sleep_detection'), { recursive: true });
    mkdirSync(path.join(home, 'venv', 'bin'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(path.join(scripts, 'is_biometrics_installed.py'), `import sys\nsys.exit(${installed ? 1 : 0})\n`);
    writeFileSync(path.join(scripts, 'restore_helpers.sh'), stubs['restore_helpers.sh'] ?? readFileSync(path.join(repoRoot, 'scripts/restore_helpers.sh'), 'utf8'));
    for (const name of ['unblock_internet_access.sh', 'block_internet_access.sh', 'setup_python.sh',
        'install_python_packages.sh', 'setup_streamer_service.sh']) {
        const fails = pipFails && name === 'install_python_packages.sh';
        writeFileSync(path.join(scripts, name), stubs[name] ?? `echo "${name}" >> "${calls}"\n${fails ? 'exit 1\n' : ''}`);
    }
    const executable = (file, body) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); };
    for (const tool of ['iptables', 'ip6tables'])
        executable(path.join(bin, tool), `echo "\${0##*/} $*" >> "${calls}"`);
    const python = `echo "python $*" >> "${calls}"\n[ "$2" = -c ] && exit ${natsImports ? 0 : 1}\nexit ${calibrationFails ? 1 : 0}`;
    executable(path.join(home, 'venv', 'bin', 'python'), python);
    // refuseOn: the server cannot turn the stream on yet (its sudo rule is
    // missing), so it answers 500 to a body that turns Biometrics on.
    executable(path.join(bin, 'curl'), [
        'for a in "$@"; do last="$a"; done',
        `body=$(echo "$last" | tr -d ' \\n'); echo "curl $body" >> "${calls}"`,
        refuseOn ? 'case "$body" in *\'"enabled":true\'*) exit 22 ;; esac' : ':',
    ].join('\n'));
    if (timeoutStub)
        executable(path.join(bin, 'timeout'), timeoutStub);
    else if (logTimeout)
        executable(path.join(bin, 'timeout'), `echo "timeout $*" >> "${calls}"\nshift\nexec "$@"`);
    executable(path.join(bin, 'systemctl'), `echo "systemctl $*" >> "${calls}"`);
    executable(path.join(bin, 'sudo'), SUDO(calls));
    const script = readFileSync(path.join(repoRoot, 'scripts/enable_biometrics.sh'), 'utf8')
        .replaceAll('/usr/local/lib/nightstand/live/scripts', scripts).replaceAll('/home/dac', home).replaceAll(' 900 bash', ` ${limit} bash`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_OPERATION_LOCK: lock || path.join(dir, 'operation.lock'),
        NIGHTSTAND_OPERATION_OWNER: '' };
    if (async) {
        return { child: spawn('bash', ['-c', script], { env }), dir, calls };
    }
    let result;
    if (shell) {
        const file = path.join(dir, 'enable_biometrics.sh');
        writeFileSync(file, script);
        result = spawnSync(shell, [file], { env, encoding: 'utf8', timeout: 10_000 });
    }
    else {
        result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 10_000 });
    }
    const log = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
    rmSync(dir, { recursive: true, force: true });
    return { ...result, log };
}
// Starts the script and hands back the child and a way to read its log.
function launch(stub) {
    const started = run({ stubs: { 'setup_python.sh': stub }, async: true });
    const out = [];
    started.child.stdout?.on('data', d => out.push(String(d)));
    const exited = new Promise(resolve => started.child.once('exit', (code, signal) => resolve(signal ? null : code)));
    const log = () => (existsSync(started.calls) ? readFileSync(started.calls, 'utf8').trim().split('\n') : []);
    return { ...started, out, exited, log };
}
const alive = (pid) => { try {
    process.kill(pid, 0);
    return true;
}
catch {
    return false;
} };
const turnsOn = (line) => line.startsWith('curl') && line.includes('"enabled":true');
describe('enable_biometrics.sh', () => {
    it('turns Biometrics on in the app once a first install has finished', () => {
        const result = run();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const on = result.log.findIndex(turnsOn);
        assert.ok(on >= 0, result.log.join('\n'));
        assert.ok(on > result.log.findIndex((line) => line.startsWith('python') && line.includes('calibrate')), 'after calibration');
        assert.ok(on > result.log.indexOf('block_internet_access.sh'), 'after the firewall is back');
    });
    it('leaves Biometrics off when the install fails', () => {
        const result = run({ calibrationFails: true });
        assert.notEqual(result.status, 0);
        assert.ok(!result.log.some(turnsOn), result.log.join('\n'));
    });
    it('records the install as healthy even when the switch cannot be turned on', () => {
        // After fs-reset this path is how Biometrics comes back; a refused switch
        // must not also lose the installation status the app checks.
        for (const installed of [true, false]) {
            const result = run({ installed, refuseOn: true });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(result.log.some((line) => line.startsWith('curl') && line.includes('"status":"healthy"') && !line.includes('"enabled"')), result.log.join('\n'));
            assert.match(result.stdout, /Biometrics is installed\. Turn it on in Settings > Features\./);
        }
    });
    it('still turns it on when it was already installed', () => {
        const result = run({ installed: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.log.some(turnsOn), result.log.join('\n'));
    });
    // nats-py is installed in the venv or bundled with Nightstand, so nothing is downloaded for it.
    for (const natsImports of [true, false]) {
        it(`never downloads nats-py or opens the firewall for it (imports: ${natsImports})`, () => {
            const result = run({ installed: true, natsImports });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(result.log.some(line => line.startsWith('python -I -c') && line.endsWith('/free-sleep/biometrics')), result.log.join('\n'));
            assert.ok(!result.log.some(line => /pip|internet_access/.test(line)), result.log.join('\n'));
            assert.match(result.stdout, natsImports ? /nats-py is available/ : /reads the RAW files instead/);
            assert.ok(result.log.some(turnsOn), result.log.join('\n'));
        });
    }
    const firewall = (log) => log.filter(line => /^ip6?tables /.test(line));
    it('lets only HTTPS and DNS out for the downloads and never flushes the firewall', () => {
        const result = run();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(!result.log.includes('unblock_internet_access.sh'), result.log.join('\n'));
        assert.ok(!firewall(result.log).some(line => / -[FXZ]( |$)/.test(line)), firewall(result.log).join('\n'));
        const opened = result.log.findIndex(line => /^iptables .*-I OUTPUT 1 -p tcp --dport 443 -j ACCEPT$/.test(line));
        assert.ok(result.log.some(line => /^ip6tables .*-I OUTPUT 1 -p tcp --dport 443 -j REJECT/.test(line)), result.log.join('\n'));
        assert.ok(opened >= 0 && opened < result.log.indexOf('setup_python.sh'), result.log.join('\n'));
        assert.ok(result.log.indexOf('install_python_packages.sh') < result.log.indexOf('block_internet_access.sh'), result.log.join('\n'));
    });
    it('bounds both downloads to 900 seconds so the firewall window cannot stay open', () => {
        const result = run({ logTimeout: true });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        for (const name of ['setup_python.sh', 'install_python_packages.sh']) {
            assert.ok(result.log.some(line => new RegExp(`^timeout 900 bash \\S*/scripts/${name}$`).test(line)), result.log.join('\n'));
        }
    });
    it('closes the window and reports the failure when a download fails', () => {
        const result = run({ pipFails: true });
        assert.notEqual(result.status, 0);
        assert.ok(result.log.indexOf('block_internet_access.sh') > result.log.indexOf('install_python_packages.sh'), result.log.join('\n'));
        assert.ok(result.log.some(line => line.startsWith('curl') && line.includes('"status":"failed"')), result.log.join('\n'));
        assert.ok(!result.log.some(turnsOn), result.log.join('\n'));
    });
    it('names the step that failed', () => {
        const result = run({ stubs: { 'setup_python.sh': 'exit 3' } });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /Python setup failed \(exit 3\)/);
        assert.ok(result.log.some(line => line.startsWith('curl') && line.includes('"status":"failed"')), result.log.join('\n'));
        assert.ok(result.log.includes('block_internet_access.sh'), result.log.join('\n'));
    });
    it('says which download timed out', () => {
        const result = run({ timeoutStub: 'case "$*" in *install_python_packages*) exit 124 ;; esac\nshift\nexec "$@"' });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /Python packages timed out after 900 seconds or was stopped/);
    });
    for (const [signal, code, piped] of [['SIGTERM', 143, false], ['SIGHUP', 129, false], ['SIGINT', 130, false],
        ['SIGTERM', 143, true]]) {
        it(`posts failed, closes the window and stops the download on ${signal}${piped ? ' after its log reader died' : ''}`, async () => {
            const started = launch('echo $$ > "$0.pid"\nexec sleep 60');
            try {
                const pidFile = path.join(started.dir, 'home', 'free-sleep', 'scripts', 'setup_python.sh.pid');
                for (let i = 0; i < 100 && !existsSync(pidFile); i++)
                    await new Promise(r => setTimeout(r, 50));
                const pid = Number(readFileSync(pidFile, 'utf8'));
                if (piped)
                    started.child.stdout?.destroy();
                const begun = Date.now();
                started.child.kill(signal);
                const status = await Promise.race([started.exited, new Promise(r => setTimeout(() => r('hung'), 15_000))]);
                assert.equal(status, code, started.out.join(''));
                assert.ok(Date.now() - begun < 15_000);
                const log = started.log();
                assert.ok(log.some(line => line.startsWith('curl') && line.includes('"status":"failed"')), log.join('\n'));
                assert.ok(log.includes('block_internet_access.sh'), log.join('\n'));
                for (let i = 0; i < 40 && alive(pid); i++)
                    await new Promise(r => setTimeout(r, 50));
                assert.equal(alive(pid), false, 'download still running');
            }
            finally {
                started.child.kill('SIGKILL');
                rmSync(started.dir, { recursive: true, force: true });
            }
        });
    }
    // The timeout stubs end without stopping the step, as a BusyBox timeout or
    // the run_limited watchdog can.
    for (const [name, gnu, limit] of [['a timeout that only stops itself', true, 900], ['the run_limited watchdog', false, 1]]) {
        it(`stops a download child and frees the lock after ${name}`, async () => {
            const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-enable-step-'));
            const lock = path.join(dir, 'operation.lock');
            const pids = path.join(dir, 'sleep.pid');
            const timeoutStub = gnu
                ? `case "$*" in "1 true") exit 0 ;; esac\nshift\n"$@" &\nwhile [ ! -s "${pids}" ]; do sleep 0.05; done\nexit 124`
                : 'exit 1';
            try {
                const result = run({ lock, limit, timeoutStub, stubs: { 'setup_python.sh': `sleep 60 &\necho $! > "${pids}"\nwait` } });
                assert.notEqual(result.status, 0, result.stdout + result.stderr);
                assert.ok(result.log.some(line => line.startsWith('curl') && line.includes('"status":"failed"')), result.log.join('\n'));
                const pid = Number(readFileSync(pids, 'utf8'));
                // An orphan the container's init never reaps stays a zombie, which holds nothing.
                const state = () => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
                const running = () => alive(pid) && !state().startsWith('Z');
                for (let i = 0; i < 40 && running(); i++)
                    await new Promise(r => setTimeout(r, 50));
                assert.equal(running(), false, `download child still running (${state().trim()})`);
                const free = spawnSync('python3', ['-c', 'import fcntl, sys; fcntl.flock(open(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)', lock]);
                assert.equal(free.status, 0, 'lock still held');
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
    it('takes the lock before restarting an installed stream', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-enable-lock-'));
        const lock = path.join(dir, 'operation.lock');
        const holder = spawn('python3', ['-c',
            'import fcntl, sys, time\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(30)', lock]);
        try {
            await new Promise(resolve => holder.stdout.once('data', resolve));
            const result = run({ installed: true, lock });
            assert.equal(result.status, 1);
            assert.ok(!result.log.some(line => line.startsWith('systemctl restart')), result.log.join('\n'));
            assert.match(result.stdout, /is running/);
        }
        finally {
            holder.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('changes nothing while an update, rollback or switch holds the lock', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-enable-lock-'));
        const lock = path.join(dir, 'operation.lock');
        const holder = spawn('python3', ['-c',
            'import fcntl, sys, time\nf = open(sys.argv[1], "a")\nfcntl.flock(f, fcntl.LOCK_EX)\nprint("held", flush=True)\ntime.sleep(30)', lock]);
        try {
            await new Promise(resolve => holder.stdout.once('data', resolve));
            const result = run({ lock });
            assert.notEqual(result.status, 0);
            assert.deepEqual(firewall(result.log).filter(line => !/ -S /.test(line)), []);
            assert.ok(!result.log.includes('setup_python.sh'), result.log.join('\n'));
            assert.match(result.stdout, /is running/);
        }
        finally {
            holder.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('stops without blaming an update when its helpers cannot be loaded', () => {
        const result = run({ stubs: { 'restore_helpers.sh': 'return 1' } });
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout, /is running/);
        assert.deepEqual(result.log, []);
    });
    const dash = spawnSync('sh', ['-c', 'command -v dash']).stdout?.toString().trim();
    it('runs when started with a shell that is not bash', { skip: dash ? false : 'dash is not installed' }, () => {
        const result = run({ shell: dash });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.log.some(turnsOn), result.log.join('\n'));
    });
    it('runs the venv and the calibration only as the server user', () => {
        const result = run();
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(asDac(result.log, /calibrate_sensor_thresholds\.py$/), result.log.join('\n'));
        const installed = run({ installed: true });
        assert.ok(asDac(installed.log, /venv\/bin\/python -I -c .*\/free-sleep\/biometrics$/), installed.log.join('\n'));
    });
    it('finds the bundled nats-py with the venv check, without site-packages', () => {
        const script = readFileSync(path.join(repoRoot, 'scripts/enable_biometrics.sh'), 'utf8');
        const code = script.match(/venv\/bin\/python -I -c '([^']*import vendored, nats)'/);
        assert.ok(code, 'the nats check');
        const args = ['-I', '-S', '-c', `${code[1]}; print(nats.__file__)`, path.join(repoRoot, 'biometrics')];
        const result = spawnSync('python3', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.startsWith(path.join(repoRoot, 'biometrics', 'vendor', 'nats')), result.stdout);
    });
});
describe('setup_python.sh', () => {
    it('unpacks the CPython sources in a folder only root can reach, and removes it', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-setup-python-'));
        try {
            const bin = path.join(dir, 'bin');
            const temp = path.join(dir, 'tmp');
            const stdlib = path.join(dir, 'stdlib');
            const cwd = path.join(dir, 'cwd');
            for (const folder of [bin, temp, stdlib, cwd, path.join(dir, 'zip/cpython-3.9.9/Lib/xml')])
                mkdirSync(folder, { recursive: true });
            writeFileSync(path.join(dir, 'zip/cpython-3.9.9/Lib/xml/new.py'), 'NEW = 1\n');
            writeFileSync(path.join(stdlib, 'kept.py'), 'kept\n');
            writeFileSync(path.join(dir, 'zip/cpython-3.9.9/Lib/kept.py'), 'replaced\n');
            spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
                path.join(dir, 'cpython'), path.join(dir, 'zip')]);
            writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "Python 3.9.9"; else echo '${stdlib}'; fi\n`);
            writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp '${dir}/cpython.zip' "$2"\n`);
            chmodSync(path.join(bin, 'python3'), 0o755);
            chmodSync(path.join(bin, 'curl'), 0o755);
            const result = spawnSync('bash', [path.join(repoRoot, 'scripts/setup_python.sh')], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_SYSTEM_DIR: temp } });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.equal(readFileSync(path.join(stdlib, 'xml/new.py'), 'utf8'), 'NEW = 1\n');
            assert.equal(readFileSync(path.join(stdlib, 'kept.py'), 'utf8'), 'kept\n');
            assert.match(readFileSync(path.join(repoRoot, 'scripts/setup_python.sh'), 'utf8'), /mktemp -d/);
            assert.doesNotMatch(readFileSync(path.join(repoRoot, 'scripts/setup_python.sh'), 'utf8'), /\/home\/dac/);
            assert.deepEqual(readdirSync(temp), []);
            assert.deepEqual(readdirSync(cwd), []);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
describe('install_python_packages.sh', () => {
    function install(venv) {
        const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-python-packages-'));
        try {
            const home = path.join(dir, 'home');
            const scripts = path.join(dir, 'scripts');
            const bin = path.join(dir, 'bin');
            const calls = path.join(dir, 'calls');
            for (const folder of [home, path.join(scripts, 'python'), bin])
                mkdirSync(folder, { recursive: true });
            writeFileSync(path.join(scripts, 'python', 'requirements.txt'), 'numpy\n');
            const python = `#!/bin/sh\necho "python $*" >> "${calls}"\n`;
            if (venv === 'link') {
                mkdirSync(path.join(dir, 'envs', 'bin'), { recursive: true });
                symlinkSync(path.join(dir, 'envs'), path.join(home, 'venv'));
            }
            else if (venv === 'dir')
                mkdirSync(path.join(home, 'venv', 'bin'), { recursive: true });
            const executable = (file, body) => { writeFileSync(file, body); chmodSync(file, 0o755); };
            executable(path.join(bin, 'python3'), `${python}case "$*" in *" -m venv "*) mkdir -p "$4/bin"; `
                + `printf '%s' '${python}' > "$4/bin/python"; chmod 755 "$4/bin/python" ;; *) echo 312 ;; esac\n`);
            if (venv !== 'none')
                executable(path.join(home, 'venv', 'bin', 'python'), python);
            executable(path.join(bin, 'sudo'), `#!/bin/sh\n${SUDO(calls)}\n`);
            executable(path.join(bin, 'chown'), `#!/bin/sh\necho "chown $*" >> "${calls}"\n`);
            const file = path.join(scripts, 'install_python_packages.sh');
            writeFileSync(file, readFileSync(path.join(repoRoot, 'scripts/install_python_packages.sh'), 'utf8').replaceAll('/home/dac', home));
            const result = spawnSync('bash', [file], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
            return { ...result, home, log: readFileSync(calls, 'utf8').trim().split('\n') };
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    for (const venv of ['none', 'dir', 'link']) {
        it(`creates the venv and installs into it only as the server user (existing venv: ${venv})`, () => {
            const result = install(venv);
            assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(asDac(result.log, / -m venv \S*\/home\/venv$/), result.log.join('\n'));
            // -H: pip keeps its cache in the server user's home.
            assert.ok(asDac(result.log, /^sudo -H -u dac \S*venv\/bin\/python -I -m pip install -r \S*\/scripts\/python\/requirements\.txt$/), result.log.join('\n'));
            // A venv an earlier release made as root is handed over first, without following a link.
            const handed = result.log.indexOf(`chown -hR dac:dac ${result.home}/venv`);
            assert.equal(handed >= 0, venv === 'dir', result.log.join('\n'));
            if (handed >= 0)
                assert.ok(handed < result.log.findIndex(line => / -m venv /.test(line)), result.log.join('\n'));
        });
    }
});
//# sourceMappingURL=enableBiometricsScript.test.js.map