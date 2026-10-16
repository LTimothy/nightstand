import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// install.sh is what new owners run, so its release choice, checksum check
// and saved channel run here as bash, section by section, with curl faked.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(path.join(repoRoot, 'scripts/install.sh'), 'utf8');
const between = (from: string, to: string) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `missing ${to} after ${from}`);
  return src.slice(start, end);
};

const compareVersions = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// Fixtures sit at and above the installer's floor so they stay valid when it
// is raised.
const FLOOR = /^MIN_INSTALL_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(src)?.[1] ?? '99.0.0';
const [floorMajor, floorMinor] = FLOOR.split('.').map(Number);
const NEXT = `${floorMajor}.${floorMinor + 1}.0`;
const NEXT_FIX = `${floorMajor}.${floorMinor + 1}.1`;
const esc = (version: string) => version.replaceAll('.', '\\.');

const BETA_FIRST = JSON.stringify({ channels: ['stable', 'beta'], releases: [
  { version: NEXT, channel: 'beta', treeSha256: 'b'.repeat(64) },
  { version: FLOOR, channel: 'stable', treeSha256: 'a'.repeat(64) },
] });
const STABLE_FIRST = JSON.stringify({ channels: ['stable', 'beta'], releases: [
  { version: NEXT_FIX, channel: 'stable', treeSha256: 'c'.repeat(64) },
  { version: NEXT, channel: 'beta', treeSha256: 'b'.repeat(64) },
] });
// What releases.json held when the floor was added: the newest stable release
// predates the scripts this installer calls.
const OLD_STABLE = JSON.stringify({ channels: ['stable', 'beta'], releases: [
  { version: NEXT, channel: 'beta', treeSha256: 'b'.repeat(64) },
  { version: '3.3.2', channel: 'stable' },
] });
const OLD_SETTINGS = '/home/dac/free-sleep-database/settingsDB.json';
const SETTINGS = '/persistent/free-sleep-data/lowdb/settingsDB.json';

const envWith = (extra: Record<string, string>) => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NIGHTSTAND_CHANNEL;
  return { ...env, ...extra };
};

describe('install.sh prebuilt-image credential check', () => {
  for (const helperStatus of [null, 0, 1]) {
    it(`continues with credential helper status ${helperStatus ?? 'absent'}`, t => {
      const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-image-check-'));
      t.after(() => rmSync(folder, { recursive: true, force: true }));
      mkdirSync(path.join(folder, 'scripts'));
      if (helperStatus !== null) {
        writeFileSync(path.join(folder, 'scripts/check_image_credentials.sh'),
          `#!/bin/bash\necho checked\nexit ${helperStatus}\n`);
      }
      const section = between('# Optional on older releases', '# Finish');
      const result = spawnSync('bash', ['-c', `set -euo pipefail\nCOPY="$FIXTURE"\n${section}\necho continued`], {
        encoding: 'utf8', env: envWith({ FIXTURE: folder }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /continued/);
      assert.equal(result.stdout.includes('checked'), helperStatus !== null);
      assert.equal(result.stdout.includes('WARNING'), helperStatus === 1);
    });
  }
});

interface Saved { old?: string; current?: string }

function pick(env: Record<string, string> = {}, manifest = BETA_FIRST, curl = `printf '%s' '${manifest}'`, saved: Saved = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-pick-'));
  const oldFile = path.join(dir, 'old-settingsDB.json');
  const currentFile = path.join(dir, 'settingsDB.json');
  if (saved.old !== undefined) writeFileSync(oldFile, saved.old);
  if (saved.current !== undefined) writeFileSync(currentFile, saved.current);
  const section = between('# Which release to install', '# Download the repository')
    .replaceAll(OLD_SETTINGS, oldFile).replaceAll(SETTINGS, currentFile);
  const result = spawnSync('bash', ['-c', `set -euo pipefail
curl() { ${curl}; }
${section}
echo "$VERSION $CHANNEL $EXPECTED_DIGEST $REPO_URL"`], { env: envWith(env), encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { ...result, out: result.stdout.trim().split('\n').at(-1) ?? '' };
}

// Runs the checksum section against an unpacked tree holding a copy of the
// real digest script, as a fresh install does.
function verify(expected: (digest: string) => string, withScript = true, staged: string | null = '3.6.0') {
  const unzip = mkdtempSync(path.join(tmpdir(), 'nightstand-verify-'));
  const tree = path.join(unzip, 'nightstand-3.6.0');
  mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  mkdirSync(path.join(tree, 'server/src'), { recursive: true });
  writeFileSync(path.join(tree, 'README.md'), 'hello\n');
  if (staged !== null) writeFileSync(path.join(tree, 'server/src/serverInfo.json'), JSON.stringify({ version: staged }));
  const script = path.join(tree, 'scripts/tree_digest.py');
  copyFileSync(path.join(repoRoot, 'scripts/tree_digest.py'), script);
  copyFileSync(path.join(repoRoot, 'scripts/system_scripts.py'), path.join(tree, 'scripts/system_scripts.py'));
  const digest = spawnSync('python3', [script, tree], { encoding: 'utf8' }).stdout.trim();
  if (!withScript) rmSync(script);
  const result = spawnSync('bash', ['-c', `set -euo pipefail
VERSION=3.6.0
UNZIP_DIR="$TEST_UNZIP"
SRC_DIR="$TEST_TREE"
EXPECTED_DIGEST="$TEST_DIGEST"
${between('# Checks the download', '# Stop both database writers')}
echo continued`], {
    env: envWith({ TEST_UNZIP: unzip, TEST_TREE: tree, TEST_DIGEST: expected(digest), NIGHTSTAND_SYSTEM_DIR: path.join(unzip, 'system') }),
    encoding: 'utf8',
  });
  const unzipKept = existsSync(unzip);
  rmSync(unzip, { recursive: true, force: true });
  return { ...result, unzipKept };
}

function saveChannel(existing: string | null, env: Record<string, string> = {}, mode?: number, failWrite = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-install-'));
  const settings = path.join(dir, 'settingsDB.json');
  if (existing !== null) writeFileSync(settings, existing);
  if (existing !== null && mode !== undefined) chmodSync(settings, mode);
  let section = between('# Save the update channel', 'if [ -d /persistent/deviceinfo/ ]').replaceAll(SETTINGS, settings);
  if (failWrite) section = section.replace('os.replace(tmp, path)', 'raise OSError("simulated")');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nCHANNEL=\${CHANNEL_UNDER_TEST}\n${section}\necho continued`], {
    env: envWith(env), encoding: 'utf8',
  });
  const text = existsSync(settings) ? readFileSync(settings, 'utf8') : null;
  const fileMode = existsSync(settings) ? statSync(settings).mode & 0o777 : null;
  const tmpKept = existsSync(`${settings}.tmp`);
  rmSync(dir, { recursive: true, force: true });
  let saved = null;
  try { saved = text === null ? null : JSON.parse(text); } catch { saved = text; }
  return { ...result, saved, fileMode, tmpKept };
}

describe('install.sh release choice', () => {
  it('installs the newest release by default, as a tag', () => {
    assert.equal(pick().out, `${NEXT} beta ${'b'.repeat(64)} https://github.com/LTimothy/nightstand/archive/refs/tags/v${NEXT}.zip`);
  });

  it('follows the newest release\'s own channel when none is given or saved', () => {
    assert.match(pick({}, STABLE_FIRST).out, new RegExp(`^${esc(NEXT_FIX)} stable c{64} .*/refs/tags/v${esc(NEXT_FIX)}\\.zip$`));
  });

  it('installs the newest stable release when asked', () => {
    assert.match(pick({ NIGHTSTAND_CHANNEL: 'stable' }).out, new RegExp(`^${esc(FLOOR)} stable a{64} .*/refs/tags/v${esc(FLOOR)}\\.zip$`));
  });

  it('keeps an asked-for beta channel even when the newest release is stable', () => {
    assert.match(pick({ NIGHTSTAND_CHANNEL: 'beta' }, STABLE_FIRST).out, new RegExp(`^${esc(NEXT_FIX)} beta c{64} `));
  });

  it('installs a release with no published checksum, leaving the digest empty', () => {
    const manifest = JSON.stringify({ releases: [{ version: FLOOR, channel: 'stable' }] });
    const result = pick({}, manifest);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.out, `${FLOOR} stable  https://github.com/LTimothy/nightstand/archive/refs/tags/v${FLOOR}.zip`);
  });

  it('refuses a release older than the installer supports, before downloading', () => {
    const result = pick({ NIGHTSTAND_CHANNEL: 'stable' }, OLD_STABLE);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), 'v3.3.2 is older than this installer supports. To install the newest release, '
      + 'run the command again with NIGHTSTAND_CHANNEL=beta in front of it.');
  });

  it('a reinstall follows the saved stable channel', () => {
    assert.match(pick({}, BETA_FIRST, undefined, { current: '{"updateChannel":"stable"}' }).out, new RegExp(`^${esc(FLOOR)} stable `));
    assert.notEqual(pick({}, OLD_STABLE, undefined, { current: '{"updateChannel":"stable"}' }).status, 0);
  });

  it('a reinstall follows the saved beta channel', () => {
    assert.match(pick({}, STABLE_FIRST, undefined, { current: '{"updateChannel":"beta"}' }).out, new RegExp(`^${esc(NEXT_FIX)} beta `));
  });

  it('reads the old settings path first, since the install moves it over the new one', () => {
    const saved = { old: '{"updateChannel":"stable"}', current: '{"updateChannel":"beta"}' };
    assert.match(pick({}, BETA_FIRST, undefined, saved).out, new RegExp(`^${esc(FLOOR)} stable `));
  });

  it('settings with no saved channel, or an unreadable one, keep the newest release and its channel', () => {
    assert.match(pick({}, BETA_FIRST, undefined, { current: '{"timeZone":"UTC"}' }).out, new RegExp(`^${esc(NEXT)} beta `));
    assert.match(pick({}, BETA_FIRST, undefined, { current: '{not json' }).out, new RegExp(`^${esc(NEXT)} beta `));
    assert.match(pick({}, BETA_FIRST, undefined, { current: '{"updateChannel":"nightly"}' }).out, new RegExp(`^${esc(NEXT)} beta `));
  });

  it('NIGHTSTAND_CHANNEL overrides the saved channel', () => {
    const saved = { current: '{"updateChannel":"stable"}' };
    assert.match(pick({ NIGHTSTAND_CHANNEL: 'beta' }, BETA_FIRST, undefined, saved).out, new RegExp(`^${esc(NEXT)} beta `));
    const beta = { current: '{"updateChannel":"beta"}' };
    assert.match(pick({ NIGHTSTAND_CHANNEL: 'stable' }, BETA_FIRST, undefined, beta).out, new RegExp(`^${esc(FLOOR)} stable `));
  });

  it('says plainly when releases.json is malformed, with no traceback', () => {
    for (const manifest of ['{}', '{"releases":[{"channel":"stable"}]}', '{"releases":[{"version":3,"channel":"stable"}]}', 'not json']) {
      const result = pick({}, manifest);
      assert.notEqual(result.status, 0, manifest);
      assert.match(result.stdout, /Could not choose a release from releases\.json/, manifest);
      assert.doesNotMatch(result.stderr, /Traceback/, manifest);
    }
  });

  it('refuses an unknown channel', () => {
    const result = pick({ NIGHTSTAND_CHANNEL: 'nightly' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /NIGHTSTAND_CHANNEL must be stable or beta/);
  });

  it('stops and says why when releases.json cannot be fetched', () => {
    const result = pick({}, BETA_FIRST, 'return 22');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Could not choose a release from releases\.json/);
    assert.doesNotMatch(result.stdout, /Installing Nightstand/);
  });

  it('stops when no release is on the channel', () => {
    const manifest = JSON.stringify({ releases: [{ version: NEXT, channel: 'beta' }] });
    const result = pick({ NIGHTSTAND_CHANNEL: 'stable' }, manifest);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no release on the selected channel/);
    assert.match(result.stdout, /Could not choose a release from releases\.json/);
  });

  it('refuses a version that is not a plain release number', () => {
    const manifest = JSON.stringify({ releases: [{ version: `${NEXT}/../main`, channel: 'stable' }] });
    const result = pick({}, manifest);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Could not choose a release from releases\.json/);
  });

  it('never downloads a branch', () => {
    assert.doesNotMatch(src, /refs\/heads\//);
  });

  // The floor may name the coming release while CHANGELOG.md has an
  // [Unreleased] section. The release commit turns that section into the
  // version, and from then on the floor must not be newer than the release.
  it('has a floor the release commit cannot leave above its own version', () => {
    assert.match(src, /^MIN_INSTALL_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/m);
    assert.ok(compareVersions(FLOOR, '3.4.0') >= 0, 'older trees lack setup_services.sh and sqlite-safety.py');
    const version = (JSON.parse(readFileSync(path.join(repoRoot, 'server/src/serverInfo.json'), 'utf8')) as { version: string }).version;
    const top = /^## (.+)$/m.exec(readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'))?.[1] ?? '';
    if (!top.startsWith('[Unreleased]')) {
      assert.ok(compareVersions(FLOOR, version) <= 0, `MIN_INSTALL_VERSION ${FLOOR} is newer than the release, v${version}`);
    }
  });

  it('chooses, downloads and checks the release before stopping anything', () => {
    const choose = src.indexOf('# Which release to install');
    const download = src.indexOf('curl -fL -o "$ZIP_FILE" "$REPO_URL"');
    const check = src.indexOf('# Checks the download');
    const stop = src.indexOf('systemctl stop');
    assert.ok(choose >= 0 && choose < download, 'choose before the download');
    assert.ok(download < check, 'check after the download');
    assert.ok(check < stop, 'check before any service stops');
    assert.ok(check < src.indexOf('mv "$REPO_DIR" "$PREV_DIR"'), 'check before the live tree is replaced');
  });
});

describe('install.sh download', () => {
  it('says plainly when the release cannot be downloaded, and cleans up', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-download-'));
    const system = path.join(dir, 'system');
    const result = spawnSync('bash', ['-c', `set -euo pipefail
VERSION=3.6.0
SYSTEM_DIR="$TEST_SYSTEM"
REPO_URL=https://example.invalid/v3.6.0.zip
curl() { : > "$3"; return 22; }
${between('# Download the repository', 'echo "Unzipping the repository..."')}
echo continued`], { env: envWith({ TEST_SYSTEM: system }), encoding: 'utf8' });
    // Downloaded into a private folder in the root-owned one, never the working directory.
    const zipKept = readdirSync(system).some(name => existsSync(path.join(system, name, 'release.zip')));
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^Could not download v3\.6\.0 from GitHub\. Nothing was installed\.$/m);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.equal(zipKept, false);
  });
});

describe('install.sh checksum check', () => {
  it('goes on when the download matches its published checksum', () => {
    const result = verify((digest) => digest);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^v3\.6\.0 matches its published checksum$/m);
    assert.match(result.stdout, /continued/);
  });

  it('stops with the plain refusal and cleans up on a mismatch', () => {
    const result = verify(() => '0'.repeat(64));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^The download of v3\.6\.0 does not match its published checksum\. Nothing was installed\.$/m);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.equal(result.unzipKept, false);
  });

  it('installs without a check when the release has no published checksum', () => {
    const result = verify(() => '');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^No published checksum for v3\.6\.0; installing without one$/m);
    assert.match(result.stdout, /continued/);
  });

  it('installs without a check when the release predates the checksum script', () => {
    const result = verify(() => 'b'.repeat(64), false);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^v3\.6\.0 was released before checksum checks; installing without one$/m);
    assert.match(result.stdout, /continued/);
  });
});

describe('install.sh staged version', () => {
  it('refuses a download that reports a different version, and cleans up', () => {
    const result = verify(() => '', true, '3.5.0');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^staged tree reports v3\.5\.0 but releases\.json lists v3\.6\.0; refusing a mislabeled release$/m);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.equal(result.unzipKept, false);
  });

  it('refuses a download with no readable serverInfo.json', () => {
    const result = verify(() => '', true, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /^staged tree has no readable serverInfo\.json$/m);
    assert.equal(result.unzipKept, false);
  });
});

describe('install.sh saved channel', () => {
  it('saves the installed channel on a fresh install', () => {
    assert.deepEqual(saveChannel(null, { CHANNEL_UNDER_TEST: 'beta' }).saved, { updateChannel: 'beta' });
  });

  it('keeps the owner\'s choice on a reinstall unless a channel was given', () => {
    assert.equal(saveChannel('{"updateChannel":"stable","timeZone":"UTC"}', { CHANNEL_UNDER_TEST: 'beta' }).saved.updateChannel, 'stable');
    const given = saveChannel('{"updateChannel":"stable","timeZone":"UTC"}', { CHANNEL_UNDER_TEST: 'beta', NIGHTSTAND_CHANNEL: 'beta' }).saved;
    assert.deepEqual(given, { updateChannel: 'beta', timeZone: 'UTC' });
  });

  it('adds the channel to carried-over settings that have none', () => {
    assert.deepEqual(saveChannel('{"timeZone":"UTC"}', { CHANNEL_UNDER_TEST: 'beta' }).saved, { timeZone: 'UTC', updateChannel: 'beta' });
  });

  it('keeps the settings file\'s permissions', () => {
    assert.equal(saveChannel('{"timeZone":"UTC"}', { CHANNEL_UNDER_TEST: 'beta' }, 0o660).fileMode, 0o660);
  });

  it('warns and goes on when the settings file cannot be read', () => {
    const result = saveChannel('{not json', { CHANNEL_UNDER_TEST: 'beta', NIGHTSTAND_CHANNEL: 'beta' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WARNING: could not save the update channel/);
    assert.match(result.stdout, /continued/);
    assert.equal(result.saved, '{not json');
    assert.doesNotMatch(result.stderr, /Traceback/);
  });

  it('removes its temporary file when the write fails', () => {
    const result = saveChannel('{"timeZone":"UTC"}', { CHANNEL_UNDER_TEST: 'beta' }, undefined, true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WARNING: could not save the update channel/);
    assert.equal(result.tmpKept, false);
    assert.deepEqual(result.saved, { timeZone: 'UTC' });
  });

  it('runs after old settings are moved into place, before ownership is fixed', () => {
    const save = src.indexOf('# Save the update channel');
    assert.ok(save > src.indexOf('for entry in "${FILES_TO_MOVE[@]}"'), 'after the old settings move');
    assert.ok(save < src.indexOf('chown -R "$USERNAME":"$USERNAME" /persistent/free-sleep-data/'), 'before the chown');
  });
});

// From stopping the services to the step after Node: the stretch where a
// reinstall replaces the live tree and can still fail.
// The failing step can first start units of the new install (started) and
// leave one that then does not stop (stuck: "<unit> fails|stays|deactivating").
function replaceTree({ live = true, nodeFails = true, started = [] as string[], stuck = '' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-reinstall-'));
  const tree = (name: string, version: string) => {
    mkdirSync(path.join(dir, name, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, name, 'version'), version);
  };
  if (live) tree('free-sleep', 'old');
  tree('unzip/nightstand', 'new');
  const starts = started.map(unit => `echo active > "$FIXTURE/state-${unit}"\n`).join('');
  writeFileSync(path.join(dir, 'unzip/nightstand/scripts/ensure-node.sh'),
    `${starts}${stuck ? `echo '${stuck}' > "$FIXTURE/stuck"\n` : ''}exit ${nodeFails ? 1 : 0}\n`);
  const result = spawnSync('bash', ['-c', `set -euo pipefail
REPO_DIR="$FIXTURE/free-sleep"; PREV_DIR="$FIXTURE/free-sleep-prev"; FAILED_DIR="$FIXTURE/free-sleep-failed"
UNZIP_DIR="$FIXTURE/unzip"; SRC_DIR="$UNZIP_DIR/nightstand"; USERNAME=dac
COPY="$FIXTURE/copy"; mkdir -p "$COPY"; cp -R "$SRC_DIR/scripts" "$COPY/"
systemctl() {
  local unit state stuck
  case "$1" in
    is-active)
      unit=$2; [ "$unit" != --quiet ] || unit=$3
      state=$(cat "$FIXTURE/state-$unit" 2>/dev/null || echo inactive)
      [ "$2" = --quiet ] || echo "$state"
      [ "$state" = active ];;
    cat) [ "$2" = free-sleep ];;
    *)
      echo "$* $(cat "$REPO_DIR/version" 2>/dev/null)" >> "$FIXTURE/services"
      stuck=$(cat "$FIXTURE/stuck" 2>/dev/null || true)
      case "$1:$stuck" in
        "stop:$2 fails") return 1;;
        "stop:$2 stays") ;;
        "stop:$2 deactivating") echo deactivating > "$FIXTURE/state-$2";;
        stop:*) echo inactive > "$FIXTURE/state-$2";;
        start:*|restart:*) echo active > "$FIXTURE/state-$2";;
      esac;;
  esac
}
chown() { :; }
${between('# Stop both database writers', '# Setup /persistent/free-sleep-data')}
echo continued`], { env: envWith({ FIXTURE: dir }), encoding: 'utf8' });
  const read = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : '');
  const output = {
    ...result, live: read('free-sleep/version'), previous: read('free-sleep-prev/version'),
    failed: read('free-sleep-failed/version'), services: read('services'),
    serverState: read('state-free-sleep').trim(), streamState: read('state-free-sleep-stream').trim(),
  };
  rmSync(dir, { recursive: true, force: true });
  return output;
}

describe('install.sh over an existing install', () => {
  it('puts the previous install back and starts it when a later step fails', () => {
    const result = replaceTree();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
    assert.match(result.services, /^stop free-sleep old$/m);
    assert.match(result.services, /^start free-sleep old$/m);
  });

  it('keeps the previous install aside while the new one is set up', () => {
    const result = replaceTree({ nodeFails: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /continued/);
    assert.equal(result.live, 'new');
    assert.equal(result.previous, 'old');
  });

  it('a failed first install has nothing to put back', () => {
    const result = replaceTree({ live: false });
    assert.notEqual(result.status, 0);
    assert.equal(result.live, 'new');
    assert.equal(result.previous, '');
  });

  // The new install starts the stream before its server, so a later failure
  // finds a writer running from the new tree.
  it('stops what the new install started before putting the previous install back', () => {
    const result = replaceTree({ started: ['free-sleep-stream'] });
    assert.notEqual(result.status, 0);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
    assert.match(result.services, /^stop free-sleep-stream new$/m);
    assert.equal(result.streamState, 'inactive');
    assert.match(result.services, /^start free-sleep old$/m);
  });

  for (const unit of ['free-sleep', 'free-sleep-stream']) {
    for (const [mode, what] of [['fails', 'fails to stop'], ['stays', 'stays active'], ['deactivating', 'is still deactivating']]) {
      it(`keeps both installs where they are when ${unit} ${what}`, () => {
        const result = replaceTree({ started: ['free-sleep', 'free-sleep-stream'], stuck: `${unit} ${mode}` });
        assert.notEqual(result.status, 0);
        assert.equal(result.live, 'new');
        assert.equal(result.previous, 'old');
        assert.equal(result.failed, '');
        assert.match(result.stdout, /WARNING: the previous install could not be put back\. It is in .*free-sleep-prev\./);
        assert.doesNotMatch(result.stdout, /previous install was put back/);
        assert.doesNotMatch(result.services, /^start .* old$/m);
      });
    }
  }

  it('gives up the previous install only once the new server has started', () => {
    const started = src.indexOf('systemctl start free-sleep.service');
    assert.ok(started > 0);
    assert.ok(src.indexOf('RESTORE_PREVIOUS=no', started) > started);
    assert.equal(src.slice(src.indexOf('RESTORE_PREVIOUS=yes')).indexOf('RESTORE_PREVIOUS=no') > 0, true);
  });
});

// A reinstall from stopping the services through the new server's health
// check: the stretch where the previous install waits to be put back.
// interrupt runs in the script's own shell at the health check's first wait;
// setup runs before the install's sections.
function reinstall({
  live = true, migrates = true, answers = true, interrupt = '', setup = '', temperature = '80', version = NEXT,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightstand-reinstall-'));
  const tree = (name: string, version: string) => {
    mkdirSync(path.join(dir, name, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, name, 'version'), version);
  };
  if (live) tree('free-sleep', 'old');
  tree('unzip/nightstand', 'new');
  mkdirSync(path.join(dir, 'etc'));
  mkdirSync(path.join(dir, 'tmp'));
  writeFileSync(path.join(dir, 'unzip/nightstand/scripts/ensure-node.sh'), 'exit 0\n');
  const sections = [
    between('# Stop both database writers', '# Setup /persistent/free-sleep-data'),
    between('# Run Prisma migrations', '# Create systemd service'),
    between('# Create systemd service', '# Install the RAW-archive retention timer'),
  ].join('\n').replaceAll('/etc/systemd/system/', '$FIXTURE/etc/');
  const answer = answers ? `{"freeSleep":{"version":"${version}"},"left":{"currentTemperatureF":${temperature}}}` : '';
  const result = spawnSync('bash', ['-c', `set -euo pipefail
REPO_DIR="$FIXTURE/free-sleep"; PREV_DIR="$FIXTURE/free-sleep-prev"; FAILED_DIR="$FIXTURE/free-sleep-failed"
UNZIP_DIR="$FIXTURE/unzip"; SRC_DIR="$UNZIP_DIR/nightstand"; USERNAME=dac; SERVER_DIR="$REPO_DIR/server"
COPY="$FIXTURE/copy"; mkdir -p "$COPY"; cp -R "$SRC_DIR/scripts" "$COPY/"
VERSION=${NEXT}; STAGED_VERSION=${NEXT}; DEST="$FIXTURE/backup.db"
systemctl() {
  local unit state
  case "$1" in
    is-active)
      unit=$2; [ "$unit" != --quiet ] || unit=$3
      state=$(cat "$FIXTURE/state-\${unit%.service}" 2>/dev/null || echo inactive)
      [ "$2" = --quiet ] || echo "$state"
      [ "$state" = active ];;
    cat) [ "$2" = free-sleep ] && ${live};;
    *)
      echo "$* $(cat "$REPO_DIR/version" 2>/dev/null)" >> "$FIXTURE/services"
      case "$1" in
        stop) echo inactive > "$FIXTURE/state-\${2%.service}";;
        start|restart) echo active > "$FIXTURE/state-\${2%.service}";;
      esac;;
  esac
}
chown() { :; }
sleep() { ${interrupt || ':'}; }
sudo() { echo "sudo $*" >> "$FIXTURE/services"; ${migrates ? 'return 0' : 'return 1'}; }
curl() {
  local out=/dev/null
  while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done
  printf '%s' '${answer}' > "$out"; [ -n '${answer}' ] && printf 200 || printf 000
}
${setup}
${sections}
echo continued`], {
    env: envWith({ FIXTURE: dir, TMPDIR: path.join(dir, 'tmp'), NIGHTSTAND_OPERATION_LOCK: path.join(dir, 'lock') }),
    encoding: 'utf8', timeout: 20000,
  });
  const read = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : '');
  const output = {
    ...result, live: read('free-sleep/version'), previous: read('free-sleep-prev/version'),
    failed: read('free-sleep-failed/version'), services: read('services'),
    serverState: read('state-free-sleep').trim(), tmpLeft: readdirSync(path.join(dir, 'tmp')),
    lockReleased: spawnSync('python3', ['-c',
      'import fcntl, sys; handle=open(sys.argv[1], "a"); fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)',
      path.join(dir, 'lock')]).status === 0,
  };
  rmSync(dir, { recursive: true, force: true });
  return output;
}

describe('install.sh keeps the previous install until the new one is healthy', () => {
  it('a failed migration fails the reinstall and puts the previous install back', () => {
    const result = reinstall({ migrates: false });
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.match(result.stdout, /Prisma migrations failed!/);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
    assert.doesNotMatch(result.services, /^start free-sleep\.service new$/m, 'the new server never starts');
    assert.match(result.services, /^start free-sleep old$/m);
    assert.match(result.stdout, /the previous install was put back/);
  });

  it('a failed migration fails a first install too, starting nothing', () => {
    const result = reinstall({ live: false, migrates: false });
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.equal(result.live, 'new');
    assert.doesNotMatch(result.services, /^start /m);
  });

  it('a new server that never answers puts the previous install back', () => {
    const result = reinstall({ answers: false });
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /continued/);
    assert.match(result.stdout, /did not pass its health check/);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
    assert.match(result.services, /^stop free-sleep new$/m);
    assert.match(result.services, /^start free-sleep old$/m);
    assert.equal(result.serverState, 'active');
    assert.deepEqual(result.tmpLeft, [], 'the health check leaves no file behind');
  });

  it('an interrupted health check puts the previous install back', () => {
    const result = reinstall({ interrupt: 'kill -TERM $$' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
    assert.match(result.services, /^start free-sleep old$/m);
    assert.equal(result.serverState, 'active');
    assert.deepEqual(result.tmpLeft, [], 'the health check leaves no file behind');
  });

  // A dropped SSH session hangs up the run and takes its output with it.
  const lostOutput: [string, string][] = [['closed', 'exec >&- 2>&-']];
  if (existsSync('/dev/full')) lostOutput.push(['full', 'exec >/dev/full 2>/dev/full']);
  for (const [what, redirect] of lostOutput) {
    it(`a hangup with its output ${what} still puts the previous install back and starts it`, () => {
      const result = reinstall({ interrupt: `${redirect}; kill -HUP $$` });
      assert.equal(result.status, 129, result.stderr);
      assert.equal(result.live, 'old');
      assert.equal(result.failed, 'new');
      // With stdout closed, the script's own lines can land in the fake's log.
      assert.match(result.services, /^start free-sleep old/m);
      assert.equal(result.serverState, 'active');
    });
  }

  const aroundMove = (when: 'before' | 'after') => `mv() {
  local leaving=no
  [ "$1 $2" != "$REPO_DIR $PREV_DIR" ] || leaving=yes
  ${when === 'before' ? '[ "$leaving" = no ] || kill -TERM $$' : ':'}
  command mv "$@" || return
  ${when === 'after' ? '[ "$leaving" = no ] || kill -TERM $$' : ':'}
}`;

  it('an interruption just before the previous install moves aside leaves it in place and starts it', () => {
    const result = reinstall({ setup: aroundMove('before') });
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, '');
    assert.match(result.services, /^start free-sleep old$/m);
    assert.equal(result.serverState, 'active');
  });

  it('an interruption just after the previous install moves aside puts it back and starts it', () => {
    const result = reinstall({ setup: aroundMove('after') });
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.equal(result.live, 'old');
    assert.match(result.services, /^start free-sleep old$/m);
    assert.equal(result.serverState, 'active');
  });

  it('keeps the new install once its server answers', () => {
    const result = reinstall();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /continued/);
    assert.equal(result.live, 'new');
    assert.equal(result.previous, 'old');
    assert.equal(result.serverState, 'active');
    assert.doesNotMatch(result.services, /^stop free-sleep new$/m);
    assert.deepEqual(result.tmpLeft, [], 'the health check leaves no file behind');
  });

  it('keeps the new install when its server answers before a side reports a temperature', () => {
    const result = reinstall({ temperature: 'null' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /continued/);
    assert.equal(result.live, 'new');
    assert.equal(result.previous, 'old');
  });

  it('a new server answering as another version puts the previous install back', () => {
    const result = reinstall({ answers: true, temperature: '80', version: '0.0.1' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(result.live, 'old');
    assert.equal(result.failed, 'new');
  });

  it('the health check is the one the updater runs after its swap', () => {
    const check = (text: string) => {
      const start = text.indexOf('# Waits up to 90 s for the server to answer as version $1');
      assert.ok(start >= 0);
      return text.slice(start, text.indexOf('\n}\n', start) + 3);
    };
    assert.equal(check(src), check(readFileSync(path.join(repoRoot, 'scripts/update.sh'), 'utf8')));
  });

  it('a first install has nothing to put back, so it does not wait on the health check', () => {
    const result = reinstall({ live: false, answers: false });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /continued/);
    assert.equal(result.live, 'new');
    assert.doesNotMatch(result.stdout, /health attempt/);
  });
});

describe('install.sh operation lock', () => {
  it('refuses a held lock before downloading or changing files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'install-lock-'));
    const holder = spawn('python3', ['-u', '-c',
      'import fcntl, sys; handle=open(sys.argv[1], "a"); fcntl.flock(handle, fcntl.LOCK_EX); print("ready"); sys.stdin.readline()',
      path.join(dir, 'lock')]);
    const exited = new Promise<void>(resolve => holder.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.once('error', reject);
        holder.stdout.once('data', () => resolve());
        holder.once('exit', () => reject(new Error('lock holder exited before the test')));
      });
      const result = spawnSync('bash', ['-c', `
curl() { echo download > "$FIXTURE/download"; exit 99; }
${src}`], { encoding: 'utf8', cwd: dir, env: envWith({ FIXTURE: dir, NIGHTSTAND_OPERATION_LOCK: path.join(dir, 'lock') }) });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /already running/);
      assert.ok(!existsSync(path.join(dir, 'download')));
      assert.deepEqual(readdirSync(dir), ['lock']);
    } finally {
      holder.stdin.end('done\n');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const failure of [false, true]) {
    it(`holds the lock through health checking and releases it after ${failure ? 'restore' : 'success'}`, () => {
      const lockSection = between('# Share admission', '# Variables');
      const result = reinstall({
        setup: `${lockSection}\nexport LOCK_PATH="$OPERATION_LOCK"`,
        interrupt: `python3 - "$LOCK_PATH" <<'PY'
import fcntl, sys
with open(sys.argv[1], 'a') as handle:
 try:
  fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
 except BlockingIOError:
  sys.exit(0)
sys.exit(1)
PY
[ $? -eq 0 ] || exit 99`,
        answers: !failure,
      });
      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      assert.equal(result.live, failure ? 'old' : 'new');
      assert.equal(result.lockReleased, true);
    });
  }
});

describe('install.sh root-owned copy', () => {
  it('copies the scripts for root before the tree moves or changes owner, and runs only that copy', () => {
    const publish = src.indexOf('COPY=$(python3 -B "$SRC_DIR/scripts/system_scripts.py" publish "$SRC_DIR")');
    const move = src.indexOf('mv "$SRC_DIR" "$REPO_DIR"');
    const owner = src.indexOf('chown -R "$USERNAME":"$USERNAME" "$REPO_DIR"');
    assert.ok(publish > 0 && publish < move && move < owner, `${publish} ${move} ${owner}`);
    assert.match(src, /bash "\$COPY\/scripts\/setup_services\.sh" "\$COPY"/);
    const unzip = mkdtempSync(path.join(tmpdir(), 'nightstand-install-copy-'));
    try {
      const tree = path.join(unzip, 'nightstand-3.7.0');
      mkdirSync(path.join(tree, 'scripts'), { recursive: true });
      copyFileSync(path.join(repoRoot, 'scripts/system_scripts.py'), path.join(tree, 'scripts/system_scripts.py'));
      const result = spawnSync('bash', ['-c', `set -euo pipefail
UNZIP_DIR="$1"; SRC_DIR="$2"
${between('# Copied for root while only root', '# Report legacy')}
echo "COPY=$COPY"`, 'install', unzip, tree], { env: { ...process.env, NIGHTSTAND_SYSTEM_DIR: path.join(unzip, 'system') }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const copy = /COPY=(.*)/.exec(result.stdout)?.[1] ?? '';
      assert.ok(existsSync(path.join(copy, 'scripts/system_scripts.py')), result.stdout);
    } finally { rmSync(unzip, { recursive: true, force: true }); }
  });
});
