import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pod's self-updater is bash, so it can't be unit-tested here, but a
// syntax error or a wrong URL would brick the update path. Gate the cheap,
// high-signal invariants: the scripts parse, they point at this fork, and
// the safety rails (rollback, WAN re-block) are present.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// This file ships inside the agent overlay (see agentManifest.ts), so it may
// only assert about files the overlay carries. Limited to the agent's own
// scripts; ops/deploy.sh, ops/rollback.sh (this repo's dev/deploy tooling,
// never shipped) and scripts/enable_biometrics.sh, scripts/disable_biometrics.sh
// (stock's own files, which the agent does not touch) live in
// opsScripts.test.ts instead.
const SCRIPTS = [
  'scripts/update.sh',
  'scripts/update_service.sh',
  'scripts/install.sh',
];

describe('updater shell scripts', () => {
  for (const script of SCRIPTS) {
    it(`${script} exists and parses (bash -n)`, () => {
      const full = path.join(repoRoot, script);
      assert.equal(existsSync(full), true, `${script} is missing`);
      assert.doesNotThrow(() => execFileSync('bash', ['-n', full]));
    });
  }

  it('update.sh pulls from this fork by default, overridable via env', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');
    assert.match(src, /NIGHTSTAND_REPO:-LTimothy\/nightstand/, 'must default to this fork');
    assert.match(src, /NIGHTSTAND_BRANCH:-main/, 'must default to main');
    assert.match(src, /ZIP_URL="https:\/\/github\.com\/\$\{NIGHTSTAND_REPO\}\/archive\/refs\/heads\/\$\{NIGHTSTAND_BRANCH\}\.zip"/);
    assert.match(
      src,
      /INFO_URL="https:\/\/raw\.githubusercontent\.com\/\$\{NIGHTSTAND_REPO\}\/\$\{NIGHTSTAND_BRANCH\}\/server\/src\/serverInfo\.json"/
    );
    assert.match(src, /block_internet_access\.sh/, 'must re-block WAN');
    assert.match(src, /trap cleanup EXIT/, 'must re-block WAN even on failure');
    assert.match(src, /rolling back/i, 'must have a rollback path');
    assert.match(src, /server\/dist\/server\.js/, 'must verify the staged build output');
    // The archive's top dir is named after the repo, so it must be resolved
    // dynamically, never hardcoded to a repo name that a rename would break.
    assert.doesNotMatch(src, /free-sleep-main|nightstand-main/, 'must not hardcode the archive dir name');
    assert.match(src, /find "\$STAGE\.unzip".*-type d/, 'must resolve the staged archive dir dynamically');
  });

  // free-sleep-update.service ExecStarts update_service.sh, which runs
  // update.sh. If either loses its exec bit the unit dies with 203/EXEC
  // before writing a single log line.
  for (const script of SCRIPTS) {
    it(`${script} is executable`, () => {
      const mode = statSync(path.join(repoRoot, script)).mode;
      assert.ok(mode & 0o111, `${script} must carry the exec bit`);
    });
  }

  it('the update unit runs the script via bash (immune to lost exec bits)', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
    assert.match(src, /ExecStart=\/bin\/bash \/home\/dac\/free-sleep\/scripts\/update_service\.sh/);
  });

  // install.sh is the from-scratch bootstrap, and it installs this fork. The
  // units and sudoers rules it goes on to wire up (rollback, revert to stock)
  // name scripts that exist only here, so pointing it at the stock upstream
  // archive would install a tree those rules do not match.
  it('install.sh installs from this fork, whose scripts it wires up', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
    assert.match(src, /REPO_URL="https:\/\/github\.com\/LTimothy\/nightstand\/archive\/refs\/heads\/main\.zip"/);
  });

  // GitHub names an archive's top directory after the repo, so this fork's zip
  // unpacks to nightstand-main rather than free-sleep-main. Hardcoding either
  // name silently breaks the install the moment the repo is renamed.
  it('install.sh resolves the unpacked archive directory instead of hardcoding it', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
    assert.match(src, /find \. -mindepth 1 -maxdepth 1 -type d -name '\*-main'/);
    assert.doesNotMatch(src, /mv free-sleep-main/);
  });

  it('install.sh bootstraps node through the shared ensure-node.sh', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
    assert.match(src, /bash "\$REPO_DIR\/scripts\/ensure-node\.sh" "\$USERNAME"/);
  });

  // Regression coverage: disable_biometrics.sh existed but was never granted
  // a sudoers rule or invoked, so flipping the Settings biometrics toggle off
  // never stopped free-sleep-stream.service. Gate both halves of the fix:
  // fresh installs get the rule, and existing pods self-heal it on their
  // next update (mirroring the instant-rollback sudoers self-heal below).
  it('install.sh grants a NOPASSWD sudoers rule for disable_biometrics.sh', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
    assert.match(
      src,
      /ALL=\(ALL\) NOPASSWD: \/bin\/sh \/home\/dac\/free-sleep\/scripts\/disable_biometrics\.sh/
    );
  });

  it('update.sh self-heals the disable_biometrics.sh sudoers rule on existing pods', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');
    assert.match(
      src,
      /ALL=\(ALL\) NOPASSWD: \/bin\/sh \/home\/dac\/free-sleep\/scripts\/disable_biometrics\.sh/
    );
  });

  // Target-version protocol: the server writes update-target.json before
  // starting the service; a syntax slip here would either silently ignore a
  // requested version+downgrade (surprising) or brick every plain update
  // (catastrophic), so gate both the presence and the ordering of the safety
  // checks.
  describe('update.sh target-version protocol', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');

    it('reads and consumes update-target.json exactly once', () => {
      assert.match(src, /TARGET_FILE=\/persistent\/free-sleep-data\/update-target\.json/);
      assert.match(src, /rm -f "\$TARGET_FILE"/, 'must delete the target file so it cannot redirect a future plain update');
      // Consume-once ordering: the file is read into a variable before it's
      // removed, and removed before the requested version is ever acted on.
      const readIdx = src.indexOf('TARGET_JSON=$(cat "$TARGET_FILE")');
      const rmIdx = src.indexOf('rm -f "$TARGET_FILE"');
      const useIdx = src.indexOf('TARGET_VERSION=$(printf');
      assert.ok(readIdx > -1 && rmIdx > -1 && useIdx > -1, 'expected read -> consume -> use sequence to be present');
      assert.ok(readIdx < rmIdx && rmIdx < useIdx, 'must delete the target file before using its contents');
    });

    it('has a floor version below which targeted installs are refused', () => {
      assert.match(src, /FLOOR_VERSION="\d+\.\d+\.\d+"/);
      assert.match(src, /is below the floor/);
    });

    it('refuses a downgrade unless allowDowngrade was requested', () => {
      assert.match(src, /ALLOW_DOWNGRADE/);
      assert.match(src, /IS_DOWNGRADE/);
      assert.match(src, /is older than the running.*refusing without allowDowngrade/);
    });

    it('skips prisma migrate on a downgrade', () => {
      assert.match(src, /IS_DOWNGRADE.*=.*yes.*\n.*skipping prisma migrate/);
    });

    it('resolves a tagged release via the GitHub tag-archive URL, not just the branch zip', () => {
      assert.match(src, /TAG_ZIP_URL_PREFIX="https:\/\/github\.com\/\$\{NIGHTSTAND_REPO\}\/archive\/refs\/tags\/v"/);
    });

    it('verifies releases.json before installing a requested version', () => {
      assert.match(src, /RELEASES_URL="https:\/\/raw\.githubusercontent\.com\/\$\{NIGHTSTAND_REPO\}\/\$\{NIGHTSTAND_BRANCH\}\/releases\.json"/);
      assert.match(src, /is not a known release/);
    });

    it('refuses a staged tree whose version does not match what was requested', () => {
      assert.match(src, /staged tree reports v\$STAGED_VERSION but v\$TARGET_VERSION was requested/);
    });
  });
});

describe('update.sh will not ship code onto a schema that did not migrate', () => {
  // A release once shipped with its new tables missing: prisma migrate failed
  // against the biometrics streamer's SQLite lock, the failure was a warning,
  // and the health check passed because HTTP 200, the version string and the
  // sensor reading are all blind to a missing table. This is the in-app update
  // path, so it is the one that reaches a user's pod.
  const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');

  const assertOrder = (markers: string[], label: string) => {
    let from = 0;
    for (const marker of markers) {
      const idx = src.indexOf(marker, from);
      assert.notEqual(idx, -1, `${label}: "${marker}" is missing, or out of order`);
      from = idx + marker.length;
    }
  };

  it('stops the biometrics streamer before it migrates', () => {
    assertOrder([
      'systemctl stop free-sleep-stream',
      'prisma migrate deploy',
    ], 'stop-before-migrate');
  });

  it('retries the migration rather than giving up on one lock', () => {
    assert.match(src, /for attempt in 1 2 3; do[\s\S]*prisma migrate deploy/);
  });

  it('asserts the end state instead of trusting the exit code', () => {
    assert.match(src, /prisma migrate status/, 'nothing verifies that migrations actually applied');
  });

  it('fails the update when migrations did not apply, so it rolls back', () => {
    assert.match(src, /MIGRATION_FAILED=yes/, 'a failed migration must be recorded');
    assertOrder([
      'if [ "$MIGRATION_FAILED" = yes ]; then',
      'HEALTHY=no',
    ], 'migration-failure-forces-unhealthy');
  });

  it('never downgrades a failed migration to a bare warning', () => {
    assert.doesNotMatch(
      src,
      /prisma step failed; health check will decide/,
      'the health check cannot see a missing table, so it must not be the arbiter',
    );
  });

  it('decides whether to migrate from what the database is missing, not from a schema diff', () => {
    // A schema-file comparison cannot see a database an earlier update left
    // half-migrated, so reinstalling the same version could never finish the
    // job. migrate status is a read, so it can be asked before the streamer is
    // stopped, and only a pending migration should stop it.
    assertOrder([
      'Downgrade: skipping prisma migrate',
      'prisma migrate status',
      'systemctl stop free-sleep-stream',
      'prisma migrate deploy',
    ], 'status-gates-migrate');
  });

  it('still regenerates the client when the schema changed with nothing to migrate', () => {
    // node_modules is carried over from the previous version when the
    // lockfile is unchanged, generated client included, so a schema change
    // without a migration still needs generate.
    assert.match(src, /SCHEMA_CHANGED=yes/);
    assert.match(src, /elif \[ "\$SCHEMA_CHANGED" = yes \]; then[\s\S]{0,600}prisma generate/);
  });

  it('still skips migrations on a downgrade', () => {
    // Migrations are additive by standing rule, so an older build runs fine
    // against a newer schema. Reverting one would be the destructive path.
    assert.match(src, /IS_DOWNGRADE.*=.*yes/);
    assertOrder(['Downgrade: skipping prisma migrate', 'prisma migrate deploy'], 'downgrade-skips-first');
  });

  it('restarts the streamer it stopped, rather than leaving it down', () => {
    assert.match(src, /STREAM_WAS_ACTIVE/, 'nothing records whether the streamer was running');
    assert.match(src, /systemctl restart free-sleep-stream/, 'a stopped streamer is never started again');
  });
});

describe('update.sh hands the rest of an update to the version it installs', () => {
  // The updater that runs is the installed one, so without this a fix to it
  // reaches a pod one release after it ships. Each test below guards one way
  // the handoff could break an update, most of all a downgrade: an older
  // updater handed the job would find the target request already consumed and
  // install the latest release instead of the one asked for.
  const src = readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8');

  const assertOrder = (markers: string[], label: string) => {
    let from = 0;
    for (const marker of markers) {
      const idx = src.indexOf(marker, from);
      assert.notEqual(idx, -1, `${label}: "${marker}" is missing, or out of order`);
      from = idx + marker.length;
    }
  };

  it('carries the marker as a whole line, so the next version will hand off to it', () => {
    assert.match(src, /^# nightstand-update-handoff: 1$/m);
  });

  it('only hands off to a copy that carries the marker', () => {
    assertOrder([
      'grep -Fxq "$HANDOFF_MARKER" "$STAGE/scripts/update.sh"',
      'exec bash "$STAGE/scripts/update.sh"',
    ], 'marker-gates-exec');
  });

  it('hands off only after the internet is blocked again and before anything is backed up', () => {
    assertOrder([
      'close_wan',
      'exec bash "$STAGE/scripts/update.sh"',
      'Backing up code + data',
    ], 'handoff-between-download-and-backup');
  });

  it('clears the cleanup trap first, since it deletes the stage the new updater needs', () => {
    assertOrder(['trap - EXIT', 'exec bash "$STAGE/scripts/update.sh"'], 'trap-cleared');
  });

  it('passes the two values the rest of the update depends on', () => {
    assert.match(src, /export NIGHTSTAND_HANDOFF_TARGET="\$TARGET_VERSION"/);
    assert.match(src, /export NIGHTSTAND_HANDOFF_IS_DOWNGRADE="\$IS_DOWNGRADE"/);
  });

  it('never re-reads the target request or downloads again once handed off', () => {
    assertOrder([
      'if [ "$HANDOFF" = 1 ]; then',
      'TARGET_VERSION="${NIGHTSTAND_HANDOFF_TARGET:-}"',
      'else',
      'rm -f "$TARGET_FILE"',
      'curl -fL --max-time 300 -o "$ZIP"',
    ], 'handed-off-run-skips-fetch');
  });

  it('never hands off twice', () => {
    assertOrder([
      'if [ "$HANDOFF" != 1 ]; then',
      'exec bash "$STAGE/scripts/update.sh"',
    ], 'no-handoff-loop');
  });

  it('keeps the inline python at column 0, where an indented block would break it', () => {
    // The download steps sit unindented inside the handoff branch for this
    // reason; indenting them hands python an IndentationError mid-update.
    assert.match(src, /\nimport json, sys\n/);
    assert.match(src, /\ndef parts\(v\): return/);
  });
});
