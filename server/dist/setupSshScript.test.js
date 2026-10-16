import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
it('setup_ssh.sh writes the built-in SFTP subsystem without an external binary', t => {
    const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-ssh-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    for (const directory of ['etc/ssh', 'etc/systemd/system', 'home/root', 'var/run', 'bin']) {
        mkdirSync(path.join(folder, directory), { recursive: true });
    }
    writeFileSync(path.join(folder, 'etc/ssh/authorized_keys'), 'old key\n');
    for (const command of ['chown', 'systemctl']) {
        const file = path.join(folder, 'bin', command);
        writeFileSync(file, '#!/bin/sh\nexit 0\n');
        chmodSync(file, 0o755);
    }
    const source = readFileSync(path.join(repoRoot, 'scripts/setup_ssh.sh'), 'utf8');
    const copy = path.join(folder, 'setup_ssh.sh');
    writeFileSync(copy, source.replaceAll('/etc/', `${folder}/etc/`)
        .replaceAll('/home/root/', `${folder}/home/root/`).replaceAll('/var/run/', `${folder}/var/run/`));
    const result = spawnSync('bash', [copy], {
        input: '\nssh-ed25519 fixture\n', encoding: 'utf8',
        env: { ...process.env, PATH: `${folder}/bin:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['sshd_config', 'ssh_config']) {
        const config = readFileSync(path.join(folder, 'etc/ssh', file), 'utf8');
        assert.match(config, /^Subsystem\s+sftp\s+internal-sftp$/m);
        assert.doesNotMatch(config, /\/usr\/libexec\/sftp-server/);
    }
    assert.equal(readFileSync(path.join(folder, 'home/root/ssh/authorized_keys'), 'utf8'), 'ssh-ed25519 fixture\n');
});
//# sourceMappingURL=setupSshScript.test.js.map