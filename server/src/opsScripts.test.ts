import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This repo's own dev and deploy tooling, which deliberately does not ship
// in the agent overlay (see agentManifest.ts): ops/deploy.sh, ops/rollback.sh
// and scripts/deploy-dev.sh never reach a pod as overlay files, and
// scripts/enable_biometrics.sh / scripts/disable_biometrics.sh are stock's own
// files, which the agent must not touch. Because none of that is agent-owned,
// coverage for it lives here rather than in updaterScripts.test.ts, which
// ships inside the overlay and may only assert about files the overlay carries.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const OPS_SCRIPTS = ['ops/deploy.sh', 'ops/rollback.sh'];
const STOCK_BIOMETRICS_SCRIPTS = ['scripts/enable_biometrics.sh', 'scripts/disable_biometrics.sh'];

describe('this repo\'s own tooling (not part of the agent overlay)', () => {
  for (const script of [...OPS_SCRIPTS, ...STOCK_BIOMETRICS_SCRIPTS]) {
    it(`${script} exists and parses (bash -n)`, () => {
      const full = path.join(repoRoot, script);
      assert.equal(existsSync(full), true, `${script} is missing`);
      assert.doesNotThrow(() => execFileSync('bash', ['-n', full]));
    });
  }

  for (const script of [...OPS_SCRIPTS, ...STOCK_BIOMETRICS_SCRIPTS]) {
    it(`${script} is executable in this repo`, () => {
      const mode = statSync(path.join(repoRoot, script)).mode;
      assert.ok(mode & 0o111, `${script} must carry the exec bit`);
    });
  }

  it('reset_db.sh recreates the database with migrate deploy, not migrate dev', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/reset_db.sh'), 'utf8');
    assert.doesNotMatch(src, /migrate dev|npm run migrate/);
    assert.match(src, /prisma migrate deploy/);
  });

  it('disable_biometrics.sh actually stops and disables the stream service', () => {
    const src = readFileSync(path.join(repoRoot, 'scripts/disable_biometrics.sh'), 'utf8');
    assert.match(src, /systemctl stop free-sleep-stream/);
    assert.match(src, /systemctl disable free-sleep-stream/);
  });
});

// A deploy host and a pod that are both Wi-Fi stations on one subnet do not
// talk to each other directly: the access point receives every frame on its
// radio and retransmits it on that same radio, so a sustained upload between
// them costs double the airtime of an ordinary download and collapses at a
// far lower rate. Past that rate the path wedges instead of degrading, and
// the transfer dies once the pod's sshd stops seeing keepalive replies,
// around ClientAliveInterval 15 x ClientAliveCountMax 4. Measured on one such
// link: 36 MB lands in 8.7s throttled to 4 MB/s, while 6 MB/s and anything
// above it hang outright. Plain scp and an unrelated HTTP pull stall exactly
// the same way, so the cliff belongs to the path, not to ssh or tar. The ship
// therefore paces itself under the cliff rather than letting TCP find it, and
// still retries, because one stall must not end a deploy.
describe('deploy.sh survives a stalled upload', () => {
  const src = readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8');

  it('retries the staging ship rather than failing the deploy on one stall', () => {
    assert.match(src, /SHIP_ATTEMPTS=/, 'deploy.sh must define a ship retry count');
    assert.match(
      src,
      /while \[ "?\$?attempt"? -le "?\$SHIP_ATTEMPTS"? \]|for attempt in \$\(seq 1 "?\$SHIP_ATTEMPTS"?\)/,
      'the staging ship must run inside a retry loop',
    );
  });

  it('gives the ship its own stall detection so a hung attempt fails fast', () => {
    assert.match(src, /ServerAliveInterval/, 'the ship must detect a stall itself');
    assert.match(src, /ServerAliveCountMax/, 'the ship must bound how long it waits on a stall');
  });

  it('verifies the staged tree arrived whole before anything is swapped', () => {
    assert.match(
      src,
      /STAGE\/server\/dist\/server\.js/,
      'a retried, truncatable transfer must be checked for completeness, not assumed',
    );
  });

  it('still aborts the deploy if every attempt stalls', () => {
    assert.match(src, /die "staging ship failed/, 'exhausting the retries must abort, never swap a partial tree');
  });

  it('paces the ship with a rate limit rather than letting TCP find the cliff', () => {
    assert.match(src, /SHIP_RATE_KBIT=/, 'deploy.sh must define a ship rate limit');
    assert.match(src, /-l "\$SHIP_RATE_KBIT"/, 'the limit must be applied to the transfer, not just declared');
  });

  it('defaults that rate below where a relayed wireless upload collapses', () => {
    const match = src.match(/SHIP_RATE_KBIT="\$\{SHIP_RATE_KBIT:-(\d+)\}"/);
    assert.ok(match, 'SHIP_RATE_KBIT must carry an overridable default');
    // 4 MB/s = 32000 Kbit/s was the fastest rate observed to land the whole
    // tree; 6 MB/s hung. Anything above this ships a deploy that cannot finish.
    assert.ok(
      Number(match[1]) <= 32000,
      `default ${match[1]} Kbit/s is at or above the rate where the upload wedges`,
    );
  });
});

// deploy-dev.sh crosses the same relayed wireless leg as ops/deploy.sh, so it
// meets the same cliff. It usually ships small content-hash deltas that stay
// under it, which is why this went unnoticed while full deploys failed, but a
// dependency sync or the biometrics tarball is big enough to wedge. Its scp
// calls all share one options array, so the limit belongs there once: a new
// call site that skips the array would be silently unthrottled, which is what
// the routing test below exists to catch.
describe('deploy-dev.sh paces its uploads over the same link', () => {
  const src = readFileSync(path.join(repoRoot, 'scripts/deploy-dev.sh'), 'utf8');

  it('applies a rate limit to the shared scp options', () => {
    assert.match(src, /SHIP_RATE_KBIT=/, 'deploy-dev.sh must define a ship rate limit');
    assert.match(src, /-l "\$SHIP_RATE_KBIT"/, 'the limit must be applied, not just declared');
  });

  it('defaults that rate below where a relayed wireless upload collapses', () => {
    const match = src.match(/SHIP_RATE_KBIT="\$\{SHIP_RATE_KBIT:-(\d+)\}"/);
    assert.ok(match, 'SHIP_RATE_KBIT must carry an overridable default');
    assert.ok(
      Number(match[1]) <= 32000,
      `default ${match[1]} Kbit/s is at or above the rate where the upload wedges`,
    );
  });

  it('routes every scp call through those shared options', () => {
    // Only where scp is the command being run. Matching it anywhere on the
    // line would also hit the word inside progress strings like
    // dim "... (scp attempt $attempt)".
    const scpCalls = src.split('\n')
      .filter(line => !line.trim().startsWith('#'))
      .filter(line => /(^\s*|\bif\s+|\bthen\s+|&&\s+|\|\|\s+|;\s*)scp\s/.test(line));
    assert.ok(scpCalls.length > 0, 'expected deploy-dev.sh to invoke scp');
    for (const call of scpCalls) {
      assert.match(
        call,
        /"\$\{SCP_OPTS\[@\]\}"/,
        `this scp bypasses the throttled options and can wedge the link: ${call.trim()}`,
      );
    }
  });
});

describe('deploy.sh will not ship code onto a schema that did not migrate', () => {
  // A release once shipped with its new tables missing: prisma migrate failed
  // against the biometrics streamer's SQLite lock, the failure was a warning,
  // and the health check passed because HTTP 200, the version string and the
  // sensor reading are all blind to a missing table. Each test below is one
  // link in that chain.
  const src = readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8');

  const assertOrder = (markers: string[], label: string) => {
    let from = 0;
    for (const marker of markers) {
      const idx = src.indexOf(marker, from);
      assert.notEqual(idx, -1, `${label}: "${marker}" is missing, or out of order`);
      from = idx + marker.length;
    }
  };

  it('stops the biometrics streamer before it migrates', () => {
    // The streamer holds the same SQLite file the schema engine needs.
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

  it('fails the deploy when migrations did not apply, so it rolls back', () => {
    assert.match(src, /MIGRATION_FAILED=yes/, 'a failed migration must be recorded');
    assertOrder([
      'if [ "$MIGRATION_FAILED" = "yes" ]; then',
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
    assert.match(src, /elif \[ "\$SCHEMA_CHANGED" = "yes" \]; then[\s\S]{0,600}prisma generate/);
  });

  it('restarts the streamer it stopped, rather than leaving it down', () => {
    // try-restart is a no-op on a stopped unit, which is exactly what the
    // migration step leaves behind.
    assert.match(src, /STREAM_WAS_ACTIVE/, 'nothing records whether the streamer was running');
    assert.match(src, /systemctl restart free-sleep-stream/, 'a stopped streamer is never started again');
  });
});

// The Pod runs committed bundles, so a deploy must not ship ones older than
// the source they were built from.
describe('deploy.sh refuses stale bundles', () => {
  const src = readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8');
  const fn = src.slice(src.indexOf('bundle_behind() {'), src.indexOf('\n}\n', src.indexOf('bundle_behind() {')) + 3);

  function git(dir: string, ...args: string[]) {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  }
  function behind(dir: string) {
    return spawnSync('bash', ['-c', `${fn}\nbundle_behind server/public app ':(exclude,glob)**/*.test.tsx'`], { cwd: dir }).status === 0;
  }

  it('compares the last source commit with the last bundle commit', () => {
    assert.ok(fn.startsWith('bundle_behind() {'), 'deploy.sh must define bundle_behind');
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-bundles-'));
    mkdirSync(path.join(dir, 'app/src'), { recursive: true });
    mkdirSync(path.join(dir, 'server/public'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(path.join(dir, 'app/src/page.tsx'), 'a');
    writeFileSync(path.join(dir, 'server/public/index.js'), 'a');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'build');
    assert.equal(behind(dir), false, 'fresh bundle reported stale');
    writeFileSync(path.join(dir, 'app/src/page.test.tsx'), 'test');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'test only');
    assert.equal(behind(dir), false, 'a test-only change must not count');
    writeFileSync(path.join(dir, 'app/src/page.tsx'), 'b');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'source');
    assert.equal(behind(dir), true, 'stale bundle not detected');
  });

  it('checks bundles before touching the pod and honours --force', () => {
    const check = src.indexOf('bundle_behind server/public');
    assert.ok(check !== -1 && check < src.indexOf('# --- preflight: pod'), 'bundle check must run before the pod preflight');
    assert.match(src.slice(check - 200, check + 800), /FORCE/);
    assert.match(src, /scripts\/check-bundles\.sh/);
  });
});

describe('deploy.sh runs root-owned copies', () => {
  it('deploy.sh copies the scripts for root before the stage changes owner, and runs only that copy', () => {
    const src = readFileSync(path.join(repoRoot, 'ops/deploy.sh'), 'utf8');
    const publish = src.indexOf('COPY=$(SSH "python3 -B $STAGE/scripts/system_scripts.py publish $STAGE")');
    assert.ok(publish > 0 && publish < src.indexOf('SSH "chown -R dac:dac $STAGE"'));
    assert.match(src, /bash \$COPY\/scripts\/close_update_window\.sh/);
    assert.match(src, /sh "\$COPY\/scripts\/block_internet_access\.sh"/);
    assert.match(src, /bash \$COPY\/scripts\/setup_resource_limits\.sh/);
    const start = src.indexOf('if [ "$HEALTHY" = "yes" ]; then\n  # Root runs the new copy');
    const healthy = src.slice(start, src.indexOf('# --- automatic rollback'));
    assert.match(healthy, /SSH "bash \$COPY\/scripts\/setup_services\.sh \$COPY"/);
    assert.doesNotMatch(src.slice(src.indexOf('# --- automatic rollback')), /setup_services|system_scripts\.py (?:publish|point)/);
  });
});
