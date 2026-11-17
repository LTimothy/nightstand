import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
it('prints the section and the checked block, and nothing from other versions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-notes-'));
    const changelog = '# Changelog\n\n## [3.6.0] - 2026-10-08\n\nSummary.\n\n- One.\n\n## [3.5.1] - 2026-10-01\n\n- Old.\n';
    writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    writeFileSync(path.join(dir, 'checked.md'), '- CI: link, all checks passed.\n');
    const result = spawnSync('python3', [path.join(repoRoot, 'scripts/release_notes.py'), '3.6.0', path.join(dir, 'checked.md')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Summary.\n\n- One.\n\n### Checked before release\n\n- CI: link, all checks passed.\n');
});
it('fails for a version without a section', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-notes-'));
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
    writeFileSync(path.join(dir, 'checked.md'), 'x');
    const args = [path.join(repoRoot, 'scripts/release_notes.py'), '9.9.9', path.join(dir, 'checked.md')];
    const failResult = spawnSync('python3', args, { cwd: dir });
    assert.notEqual(failResult.status, 0);
});
it('fails until the changelog credits an outside author by handle', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-notes-'));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    const commit = (email, message) => git('-c', 'user.name=x', '-c', `user.email=${email}`, 'commit', '-q', '--allow-empty', '-m', message);
    git('init', '-q');
    git('config', 'user.email', 'me@example.com');
    commit('me@example.com', 'one');
    git('tag', 'v1.0.0');
    commit('11404482+Some-One@users.noreply.github.com', 'fix');
    writeFileSync(path.join(dir, 'checked.md'), 'x');
    const run = (entry) => {
        writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [1.1.0] - 2026-11-16\n\n- ${entry}\n`);
        return spawnSync('python3', [path.join(repoRoot, 'scripts/release_notes.py'), '1.1.0', 'checked.md'], { cwd: dir, encoding: 'utf8' });
    };
    const uncredited = run('A fix.');
    assert.notEqual(uncredited.status, 0);
    assert.match(uncredited.stderr, /@Some-One/);
    assert.notEqual(run('A fix. By @Some-One-Else.').status, 0);
    assert.equal(run('A fix. By @Some-One.').status, 0);
});
//# sourceMappingURL=releaseNotes.test.js.map