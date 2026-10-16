import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The agent bootstrap runs against a pod that is not ours, running stock code
// we did not write, and it takes that pod's web layer down for a few seconds
// to do its work. It cannot be unit-tested against a real stock pod, so this
// gates the same class of invariant migrationScripts.test.ts gates for the
// fork-switch tool: the documented safety ordering is actually present in the
// source, in the right order, not merely present somewhere in the file.
//
// Each test below corresponds to a way the tool could quietly stop being safe
// while still looking correct to a reader.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LAPTOP = 'ops/bootstrap-agent.sh';
const POD = 'scripts/migrate/agent-bootstrap-installer.sh';

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

function assertOrder(src: string, markers: string[], label: string) {
  let from = 0;
  for (const marker of markers) {
    const idx = src.indexOf(marker, from);
    assert.notEqual(idx, -1, `${label}: "${marker}" is missing, or out of order`);
    from = idx + marker.length;
  }
}

describe('the agent bootstrap scripts', () => {
  it('both parse', () => {
    for (const rel of [LAPTOP, POD]) {
      execFileSync('bash', ['-n', path.join(repoRoot, rel)]);
    }
  });

  it('refuses a pod that is not stock, on both sides', () => {
    // The laptop half checks before it builds, so a wrong target costs nothing.
    // The pod half checks again because it can be run standalone, and because
    // the state could change between the two.
    const laptop = read(LAPTOP);
    assert.match(laptop, /already-agent/, 'the laptop half does not detect an existing agent');
    assert.match(laptop, /no-install/, 'the laptop half does not detect a missing install');

    const pod = read(POD);
    assert.match(pod, /already carries agent files/, 'the pod half does not refuse an existing agent');
    assert.match(pod, /already registers an update route/, 'the pod half does not refuse a patched routes.ts');
  });

  it('copies the stock install before it touches anything', () => {
    // The overlay is applied to a copy so the pod's own upstream code is what
    // ends up underneath the agent, and so the running tree is untouched until
    // the swap. Both halves of that are load-bearing.
    assertOrder(read(POD), [
      'cp -a "$LIVE" "$FRESH"',
      'Applying the agent overlay to the copy',
      'mv "$FRESH" "$STAGE"',
      'systemctl stop free-sleep',
    ], 'stage-before-stop');
  });

  it('arms the dead-man sentinel before it stops the service', () => {
    assertOrder(read(POD), [
      'systemctl enable --now "$SENTINEL_TIMER"',
      'systemctl stop free-sleep',
      'mv "$LIVE" "$PREV"',
    ], 'sentinel-before-swap');
  });

  it('refuses to proceed if the sentinel cannot be armed', () => {
    assert.match(
      read(POD),
      /systemctl enable --now "\$SENTINEL_TIMER" \|\| fail/,
      'a failure to arm the sentinel must abort, not warn',
    );
  });

  it('restores when the health check fails', () => {
    const pod = read(POD);
    assertOrder(pod, [
      'HEALTHY=0',
      'deviceStatus',
      'if [ "$HEALTHY" != "1" ]; then',
      'restore_and_report',
    ], 'restore-on-unhealthy');
    // and only clears the swap marker once it has passed
    assertOrder(pod, ['if [ "$HEALTHY" != "1" ]; then', 'rm -f "$SWAP_MARKER"'], 'marker-cleared-after-health');
  });

  it('drops the swap marker before it mutates the live tree', () => {
    // restore-original-fork.sh keys off this marker to decide whether a swap
    // began. Setting it after the move would leave a window where a killed
    // installer looks like it never started.
    assertOrder(read(POD), [': > "$SWAP_MARKER"', 'mv "$LIVE" "$PREV"'], 'marker-before-move');
  });

  it('installs the rollback and revert units and their sudoers rules only after a passed health check', () => {
    const pod = read(POD);
    assert.ok(
      pod.indexOf('bash "$COPY/scripts/setup_services.sh"') > pod.indexOf('if [ "$HEALTHY" != "1" ]; then'),
      'setup_services.sh must not run before the health check',
    );
    assertOrder(pod, [
      'if [ "$HEALTHY" != "1" ]; then',
      'bash "$COPY/scripts/setup_services.sh" "$COPY"',
      'rm -f "$SWAP_MARKER"',
    ], 'services-after-health');
  });

  it('never enables the rollback or revert units, only installs them', () => {
    // `enable --now` on either would execute the action immediately, undoing
    // the install before the health check runs.
    const pod = read(POD);
    assert.doesNotMatch(pod, /enable --now free-sleep-rollback/, 'rollback unit must not be started');
    assert.doesNotMatch(pod, /enable --now free-sleep-revert/, 'revert unit must not be started');
  });

  it('never touches firmware or temperature control', () => {
    // Scan what the scripts DO, not what they say. Both files carry a safety
    // creed in comments that names the very things it promises not to touch,
    // so a naive whole-file search reports its own documentation.
    const code = (src: string) => src
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    for (const rel of [LAPTOP, POD]) {
      const src = code(read(rel));
      for (const forbidden of ['dac.sock', 'franken', 'firmware', 'settings/temperature', '/api/execute']) {
        assert.ok(
          !src.toLowerCase().includes(forbidden.toLowerCase()),
          `${rel} reaches "${forbidden}" in executable code; this tool must not touch the hardware path`,
        );
      }
    }
  });

  it('sends only the manifest paths, and asks the manifest rather than a second list', () => {
    // A hardcoded file list in the shipper would drift from the manifest the
    // closure gate protects, and the agent boundary would then mean two
    // different things.
    const laptop = read(LAPTOP);
    assert.match(laptop, /agentManifest\.ts/, 'the laptop half does not read the manifest');
    assert.match(laptop, /AGENT_MANIFEST/, 'the laptop half does not enumerate manifest entries');
    assert.doesNotMatch(laptop, /server\/src\/jobs\/rollback\.ts/, 'the laptop half hardcodes a manifest path');
  });

  it('applies the two patches to the pod\'s own files, not to shipped copies', () => {
    const pod = read(POD);
    assert.match(pod, /\$FRESH\/server\/src\/setup\/routes\.ts/, 'routes.ts is not patched in the staged copy');
    assert.match(pod, /\$FRESH\/server\/package\.json/, 'package.json is not patched in the staged copy');
    // and the patch entries are skipped when copying files in
    assert.match(pod, /\[ "\$mode" = "patch" \]|patch\)/, 'the copy loop does not special-case patch entries');
  });

  it('keeps the stock tree for rollback rather than deleting it', () => {
    const pod = read(POD);
    assert.match(pod, /mv "\$LIVE" "\$PREV"/, 'the stock tree is not preserved at $PREV');
    assert.doesNotMatch(pod, /rm -rf "\$PREV"/, 'the stock tree must never be deleted outright');
  });
});
