import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// scripts/setup_resource_limits.sh bounds our services so a runaway job
// cannot take memory from the pod's firmware. Run against a scratch systemd
// directory with systemctl stubbed out.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/setup_resource_limits.sh');
const OLD_RESTART_DROPIN = `# Managed by scripts/setup_resource_limits.sh. See that script for why.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
StartLimitInterval=0
`;
function runScript(systemdVersion) {
    const root = mkdtempSync(path.join(tmpdir(), 'nightstand-limits-'));
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'systemctl-calls');
    execFileSync('mkdir', ['-p', bin]);
    const version = systemdVersion ? `echo "systemd ${systemdVersion} (${systemdVersion})"; exit 0` : 'exit 1';
    writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\nif [ "$1" = --version ]; then ${version}; fi\necho "$@" >> "${calls}"\n`);
    chmodSync(path.join(bin, 'systemctl'), 0o755);
    execFileSync('bash', [SCRIPT], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NIGHTSTAND_SYSTEMD_DIR: root },
    });
    const dropinNamed = (unit, file) => readFileSync(path.join(root, `${unit}.d`, file), 'utf8');
    const dropin = (unit) => dropinNamed(unit, '10-nightstand-limits.conf');
    return { dropin, dropinNamed, calls: readFileSync(calls, 'utf8') };
}
describe('setup_resource_limits.sh', () => {
    it('parses and carries the exec bit', () => {
        assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
        assert.ok(statSync(SCRIPT).mode & 0o111);
    });
    it('caps the server and makes its processes the preferred OOM victim', () => {
        const conf = runScript().dropin('free-sleep.service');
        assert.match(conf, /^\[Service\]$/m);
        assert.match(conf, /^MemoryMax=1200M$/m);
        assert.match(conf, /^OOMScoreAdjust=300$/m);
        assert.match(conf, /^MemoryAccounting=yes$/m);
    });
    it('caps the biometrics stream the same way', () => {
        const conf = runScript().dropin('free-sleep-stream.service');
        assert.match(conf, /^MemoryMax=512M$/m);
        assert.match(conf, /^OOMScoreAdjust=300$/m);
    });
    it('restarts the server five seconds after any exit, with no start limit', () => {
        const conf = runScript().dropinNamed('free-sleep.service', '20-nightstand-restart.conf');
        assert.match(conf, /^\[Unit\]\nStartLimitIntervalSec=0$/m);
        assert.match(conf, /^Restart=always$/m);
        assert.match(conf, /^RestartSec=5$/m);
    });
    it('grows the wait between automatic restarts up to a minute on systemd 254 and newer', () => {
        const conf = runScript('255').dropinNamed('free-sleep.service', '20-nightstand-restart.conf');
        const service = conf.slice(conf.indexOf('[Service]'));
        assert.match(service, /^RestartSec=5$/m);
        assert.match(service, /^RestartSteps=4$/m);
        assert.match(service, /^RestartMaxDelaySec=60$/m);
    });
    it('keeps the fixed wait on older systemd or an unknown version', () => {
        for (const version of ['253', undefined]) {
            const conf = runScript(version).dropinNamed('free-sleep.service', '20-nightstand-restart.conf');
            assert.equal(conf, OLD_RESTART_DROPIN);
        }
    });
    it('also sets the older StartLimitInterval spelling in [Service] for systemd before 230', () => {
        const conf = runScript().dropinNamed('free-sleep.service', '20-nightstand-restart.conf');
        const service = conf.slice(conf.indexOf('[Service]'));
        assert.match(service, /^StartLimitInterval=0$/m);
        assert.doesNotMatch(conf.slice(0, conf.indexOf('[Service]')), /^StartLimitInterval=/m);
    });
    it('leaves the stream service restart behaviour alone', () => {
        assert.throws(() => runScript().dropinNamed('free-sleep-stream.service', '20-nightstand-restart.conf'));
    });
    it('reloads systemd and restarts nothing itself', () => {
        const { calls } = runScript();
        assert.equal(calls.trim(), 'daemon-reload');
    });
    it('is installed by update.sh before the server starts', () => {
        const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');
        const install = src.indexOf('scripts/setup_resource_limits.sh');
        const start = src.indexOf('\nsystemctl start free-sleep\n');
        assert.ok(install > 0, 'update.sh must run setup_resource_limits.sh');
        assert.ok(start > install, 'the limits must be written before free-sleep starts');
    });
    it('is installed by ops/deploy.sh before the server starts', () => {
        const src = readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8');
        const install = src.indexOf('scripts/setup_resource_limits.sh');
        const start = src.indexOf('SSH "systemctl start free-sleep"');
        assert.ok(install > 0, 'deploy.sh must run setup_resource_limits.sh');
        assert.ok(start > install, 'the limits must be written before free-sleep starts');
    });
    it('is installed by install.sh', () => {
        const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
        assert.match(src, /scripts\/setup_resource_limits\.sh/);
    });
});
//# sourceMappingURL=resourceLimitsScript.test.js.map