import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Runs scripts/enable_biometrics.sh with its helper scripts, the venv python
// and curl replaced by stubs that record what ran. A first install used to
// leave Biometrics reading off in the app while the stream ran.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function run({ installed = false, calibrationFails = false, refuseOn = false, natsImports = true, pipFails = false, lock = '', shell = '', logTimeout = false } = {}) {
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
    writeFileSync(path.join(scripts, 'restore_helpers.sh'), readFileSync(path.join(repoRoot, 'scripts/restore_helpers.sh'), 'utf8'));
    for (const name of ['unblock_internet_access.sh', 'block_internet_access.sh', 'setup_python.sh',
        'install_python_packages.sh', 'setup_streamer_service.sh']) {
        const fails = pipFails && name === 'install_python_packages.sh';
        writeFileSync(path.join(scripts, name), `echo "${name}" >> "${calls}"\n${fails ? 'exit 1\n' : ''}`);
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
    if (logTimeout)
        executable(path.join(bin, 'timeout'), `echo "timeout $*" >> "${calls}"\nshift\nexec "$@"`);
    executable(path.join(bin, 'systemctl'), `echo "systemctl $*" >> "${calls}"`);
    const script = readFileSync(path.join(repoRoot, 'scripts/enable_biometrics.sh'), 'utf8')
        .replaceAll('/usr/local/lib/nightstand/live/scripts', scripts).replaceAll('/home/dac', home);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_OPERATION_LOCK: lock || path.join(dir, 'operation.lock'),
        NIGHTSTAND_OPERATION_OWNER: '' };
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
    const dash = spawnSync('sh', ['-c', 'command -v dash']).stdout?.toString().trim();
    it('runs when started with a shell that is not bash', { skip: dash ? false : 'dash is not installed' }, () => {
        const result = run({ shell: dash });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(result.log.some(turnsOn), result.log.join('\n'));
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
//# sourceMappingURL=enableBiometricsScript.test.js.map