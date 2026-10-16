# Contributing

Nightstand is a personal fork of
[jmew/free-sleep](https://github.com/jmew/free-sleep), which builds on
[throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep). I
maintain it for my own Pod. Issues and pull requests are welcome, and I merge
fixes that are useful to others, but there is no roadmap, and a feature
request may not be picked up. For changes to the broader project, contribute
to [throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep)
(see its CONTRIBUTING.md) or to
[jmew/free-sleep](https://github.com/jmew/free-sleep).

## Where to start

- Open pull requests against `dev`. Work lands there, and `main` moves only
  at a release (see
  [Release cadence and promotion](#release-cadence-and-promotion)).
- [AGENTS.md](AGENTS.md) is a map of the code for people and coding agents:
  repository layout, commands, where the scheduling and hardware code lives,
  and the hardware cautions.
- [server/README_SERVER.md](server/README_SERVER.md) covers running the
  server on your computer or on a Pod and how the server is organized.
  [server/API.md](server/API.md) documents every route.
  [app/README_APP.md](app/README_APP.md) covers the app's dev server,
  including a demo mode that needs no Pod.
- [biometrics/DEVELOPER.md](biometrics/DEVELOPER.md) covers the Python
  code, and [docs/CALIBRATION.md](docs/CALIBRATION.md) lists its numeric
  constants and why each has its value.
- [docs/TESTING.md](docs/TESTING.md) lists the tests, what CI runs, what has
  been tried on a real Pod and what is not tested.
- Read [docs/EIGHT_SLEEP_PROTOCOL.md](docs/EIGHT_SLEEP_PROTOCOL.md) before
  changing anything that talks to the hardware.

## AI-assisted contributions

Contributions written with AI tools are welcome and are reviewed like any
other. Point your tool at [AGENTS.md](AGENTS.md) first. However the code was
written, the person who opens the pull request is its author: you have read
and tested it, and you respond to review feedback and to any problems it
causes. Mentioning it in the pull request helps me review hardware-facing
changes, but it does not change whether a change is accepted.

## Setup

Use the Node version in `.nvmrc` (Volta users get the version pinned in
`server/package.json`). Install dependencies in both packages. The app
imports schema files from `server/src`, so it needs the server's dependencies
as well:

```
(cd server && npm ci && npm run generate)
(cd app && npm ci)
```

`npm run generate` builds the Prisma client, which the server's build and
tests need. The server tests also run the Python tests in `scripts/tests/`,
so `python3` must be on your path.

## Before a pull request

Typecheck, lint, and test both packages. From the repository root:

```
(cd server && npx tsc --noEmit && npm run lint && npm test)
(cd app && npx tsc -b && npm run lint && npm test)
```

CI runs the same tests and lint, plus these, which are worth running locally
when your change touches that area:

- Biometrics (CI runs Python 3.9 and 3.10):
  `pip install -r scripts/python/requirements.txt pytest`, then
  `python -m pytest biometrics/__tests__/`
- End-to-end tests against the demo build:
  `cd app && npx playwright install chromium webkit && npm run build:demo && npx playwright test`
- `shellcheck -S error scripts/*.sh scripts/migrate/*.sh ops/*.sh`

The Pod runs prebuilt code, so `server/dist/` and `server/public/` (the app's
build output) are committed. They must match the source on `main`, so a
release rebuilds them as its last step. On `dev` they may lag behind between
batches; rebuild once at the end of a batch rather than after every change.
Rebuild from a clean `npm ci` with `npm run build:pr` in both `server/` and
`app/`, then run `scripts/check-bundles.sh`: the builds do not delete old
output, and it lists files nothing uses anymore so you can remove them.
`ops/deploy.sh` refuses to ship bundles older than the source. CI rebuilds
from a clean `npm ci` and fails on `main`, and on pull requests into `main`,
if the result differs from what is committed; on `dev` it only notes it.

## Tests

New code comes with tests. Some older code has little coverage; it gains
tests as it is changed, and anything added now lands with tests for its
logic.

- Server: `node:test`, with test files next to the code they cover
  (`server/src/**/*.test.ts`). When the important part of a change is hard
  to test directly (shell scripts, UI wiring), move the logic into a plain
  module and test that, or at least test the invariants that would otherwise
  break without anyone noticing. `server/src/updaterScripts.test.ts` shows
  the pattern.
- App: Vitest with jsdom, Testing Library, and MSW. A change to an app
  component or page comes with a colocated `*.test.tsx` that renders it
  against the mock data using `renderWithProviders` or `renderApp`.
  [app/src/test/README.md](app/src/test/README.md) explains the harness.
- Biometrics: pytest, in `biometrics/__tests__/`.
- Scripts: shell scripts are tested from `server/src` against throwaway
  copies with the Pod's commands replaced, and the Python helpers in
  `scripts/` by `scripts/tests/`.

## Optional features

Anything a user might reasonably want off ships behind a feature flag:

- A key in `defaultFeatures` in `server/src/db/settingsSchema.ts`, with a
  default that keeps existing Pods behaving as they did.
- A row in the Features group of Settings
  (`app/src/pages/SettingsPage/FeaturesSection/FeaturesSection.tsx`), or no
  row for a flag that only API clients use. `sleepScore` is one: the app no
  longer shows the score, and the flag still turns its routes on and off.
- An entry in `server/src/features/featuresManifest.ts`, whose tests fail if a
  settings feature key has no entry.

Always-on work also gets a manifest entry, with `flag: null` and the reason in
`rationale`. Manifest ids are never renamed, since `releases.json` lists them.
New settings keys are merged into stored settings at startup (see
`server/src/db/settings.ts`), so they need no migration.

## Running your changes on a Pod

The in-app updater installs published releases only. To run your own changes
on a Pod:

- `ops/deploy.sh` deploys the committed `HEAD` of your local clone over the
  LAN, with the same backup, health check, and automatic rollback as the
  updater (see [ops/ANTIBRICK.md](ops/ANTIBRICK.md)). `ops/deploy.sh --check`
  runs the preflight checks without deploying.
- `scripts/deploy-dev.sh` is the faster loop for iteration: it builds locally
  and copies only the files whose content changed since the last deploy. It
  has no backup or rollback step. Set `POD_HOST` to your Pod's address; the
  script header lists the other options.

Both scripts push code rather than running a full install, so they do not
install systemd units, sudoers rules or the hardware watchdog.
[server/README_SERVER.md](server/README_SERVER.md#units-a-deploy-does-not-install)
lists the one-time steps. For hot reload of server code, run the server
directly on the Pod, as described in the same file.

## Commit style

Conventional Commits, matching the existing history:

```
type(scope): subject
```

- Types: `feat`, `fix`, `ui`, `docs`, `build`, `ops`, `ci`, `refactor`,
  `chore`, `test`.
- Scope is optional. Common ones are `app`, `server`, `biometrics`, `ops`,
  and `install`.
- The subject is lowercase and imperative, with no trailing period.
- No trailers. The body explains why the change is needed, not only what it
  does.
- Before pushing, fold small follow-ups (a lint fix, a test tweak) into the
  commit they belong to with `git commit --fixup <commit>` and
  `git rebase -i --autosquash`. Pushed commits are not rewritten.

## Credit for ported work

Much of this code comes from other forks of free-sleep, and changes are
still ported from them. Credit goes where the work came from:

- A commit taken whole from another fork is applied with
  `git cherry-pick -x <commit>`, so its author stays the git author and the
  commit records where it came from. Cite the commit in the fork where it
  was first made, not a copy of it. Keep its message as it is, and make any
  changes, such as wording or formatting, in a separate commit of your own.
- Never write a `(cherry picked from commit ...)` line by hand.
- Work adapted from another fork, or only part of a commit, goes in your own
  commit, whose body names the source: the fork and commit, or the pull
  request, and its author's GitHub handle.
- The changelog entry for ported work says where it came from, for example
  "Adapted from [EpicPi's pull request 51 to
  throwaway31265/free-sleep](https://github.com/throwaway31265/free-sleep/pull/51)."
  Reports and ideas are credited by handle the same way.

## Versioning

Semver, `MAJOR.MINOR.PATCH`, always with all three parts. The version is set
in one place, `server/src/serverInfo.json`.

- PATCH: a bug fix or internal change with no new behavior.
- MINOR: a new user-facing feature that is backward compatible.
- MAJOR: a breaking change to data schemas, the API, or on-Pod configuration
  that needs manual attention when deploying.

Nightstand's version stream started at 3.0.0 when it split from jmew's fork,
which was at 2.1.4 and followed the original project's 2.x line.
`upstreamBase` in the same file records the original-project release this
build is based on. Change it only when a build moves to a newer base.

Every release is also recorded in `releases.json` at the repository root,
with a `channel` of `stable` or `beta` and a `kind` of `bundle` (`agent` is
an older value the app still accepts; no release uses it), and tagged in git
as `v<version>` (for example `v3.2.0`).

## Release cadence and promotion

Cut a release when a coherent set of user-facing work is ready, not after
every change. Work lands on `dev`, with notes under a `## [Unreleased]`
heading in `CHANGELOG.md`. When there is enough for a version, that heading
becomes the release, `main` is fast-forwarded to `dev`, and the release
commit is tagged.

`main` moves only at a release, so it always matches the newest release.
This matters because installed Pods, the app and the installer read
`releases.json` from `main`, and the fork switch tool and updaters from
3.3.0 and earlier download `main` itself. The installer and current
updaters download the chosen release's tag. Beta and stable are not
branches: each release's channel is a field in `releases.json`.

Avoid a series of one-commit releases. They make the changelog noisy and the
version number less meaningful.

Every release starts on `beta`, which gets new work first and has had less
testing. It runs on my own Pod 5 before I move it to `stable`; there is no
fixed waiting period, so `stable` changes less often. A change aimed at a
model I do not own is confirmed by an owner of that model, or its changelog
entry says it is not confirmed. `scripts/promote_release.sh <version>`
changes a single entry's channel in `releases.json` and prints the matching
`gh release edit` command to run.

- Trivial or documentation-only releases can start on `stable` directly.

Downgrades and rollbacks never reverse a Prisma migration: the older server
runs against the newer schema. This works because migrations are additive,
which is a standing rule. A new migration must never drop or rename a column
or table that an older, still-installable release reads.

New SQLite migrations must use one `BEGIN; ... COMMIT;` transaction. Never
edit a shipped migration: tests pin its checksum. The compatibility check
allows new tables, non-unique indexes, and additive columns; a required column
on an existing table needs a non-null default. It also allows dropping a
non-unique `_idx` index that duplicates a unique one, since older code reads
the same rows through the unique index. Other drops, renames, new constraints
on existing tables, and table rebuilds are refused. Test an upgrade and an
older reader against a copy of the resulting database before release.

## Release ritual

1. Bump the version in `server/src/serverInfo.json`.
2. Pin the SHA-256 checksum of each new migration in
   `server/prisma/shipped-migrations.json`.
3. If `scripts/install.sh` now needs something only this release ships,
   raise its `MIN_INSTALL_VERSION` to this version.
4. Add the new release to the top of `releases.json`, following the shape of
   the entry below it: `kind` (always `bundle`), `version`, `date`, and
   `channel` (`beta` unless there is a reason to ship straight to `stable`).
   A bundle also carries its own `upstreamBase`, the release it was built
   from, and its `features` list. Its `treeSha256` is added in step 8.
5. Add a matching entry at the top of `CHANGELOG.md` (the `## [Unreleased]`
   notes become `## [<version>] - <date>`), starting with a one-sentence
   summary on its own line before the notes. The app shows it as the
   release's preview. End the entry with one line,
   `Checked on: <model>, <what was exercised>, <nights>.` If the test
   counts in `docs/TESTING.md` have moved by more than about a hundred,
   update them from the last CI run on `dev`.
6. Rebuild both packages from a clean `npm ci` (`npm run build:pr` in
   `server/` and `app/`), remove any files `scripts/check-bundles.sh` lists,
   run it again until it lists nothing, and commit the output.
7. Commit everything together on `dev`. The release commit is the last
   commit before the tag.
8. Run `scripts/release_digest.sh`, which writes the release's checksum
   (`treeSha256`) into `releases.json` and amends the release commit. Then
   fast-forward `main` to `dev` (`git switch main && git merge --ff-only
   dev`) and tag: `git tag -a v<version> -m "..."`.
9. Push both branches and the tag: `git push origin main dev v<version>`.
10. Create the GitHub Release: `gh release create v<version> --title
    "v<version>" --notes-file <(python3 scripts/release_notes.py <version>
    checked.md)`, where `checked.md` contains only the bullets below, filled
    in and kept out of the repository. From the repository root, preview with
    `python3 scripts/release_notes.py <version> checked.md`. Both arguments
    are required. The script prints that version's `CHANGELOG.md` section,
    adds the `### Checked before release` heading, then prints the bullets.
    When an entry is later corrected, run
    `gh release edit v<version> --notes-file <(...)` with the same script. Add
    `-R LTimothy/nightstand` if `gh` picks the wrong default repository
    (this clone has several other forks configured as remotes for
    cherry-picking). Pass `--prerelease` for a `beta` release. When a
    release is later promoted to `stable` in `releases.json`, also run
    `gh release edit v<version> --prerelease=false` (and `--latest` if it is
    the newest stable release) to match.

```markdown
- CI: {link to the run on the tag}, all checks passed.
- Hardware: {model}, firmware {version}, {what was exercised}, {dates}.
- Nights on the maintainer's Pod before stable: {n} (beta releases: not yet).
- Not checked: {models not tested, features not exercised, browsers not run}.
```

## Publishing an upstream switch target

Publishing a target is a separate step, never part of an ordinary Nightstand
release. I publish an `upstreamSwitchV2` record only after the
[upstream switch gate](docs/TESTING.md#upstream-switch-publication-gate)
passes, first in a Linux VM with real systemd, then in an explicitly
authorized hardware round trip. Simulated tests alone do not pass the gate.

After both stages pass:

1. Retain the test record, including the Nightstand build, exact upstream
   artifacts, Pod model, firmware, observed sensor format, results and limits.
2. Add a top-level `upstreamSwitchV2` object to `releases.json` with `commit`
   (the full 40-character tested upstream commit), `version` (the version in
   that artifact's `server/src/serverInfo.json`), `treeSha256` (the tested
   tree's SHA-256 digest) and `date` (the actual hardware validation date in
   `YYYY-MM-DD` form). Do not use the release date or a planned test date.
3. Compute the digest from that commit in the upstream repository, with
   Nightstand's helper available locally:

   ```bash
   git -c core.autocrlf=false -c core.eol=lf -c core.attributesFile=/dev/null \
     archive <tested-upstream-commit> |
     python3 -B /path/to/nightstand/scripts/tree_digest.py --tar -
   ```

4. Check that the record identifies the artifact exercised by the gate and
   that the Versions dialog shows that version, commit and validation date.
   A different target needs its own gate before publication.

Leave the legacy `upstreamSwitch` record unchanged. Older installed scripts
read it and do not have the new transaction safeguards. Do not remove it or
point it at 3.0.x. The new switch refuses an invalid V2 record instead of
falling back to upstream's `main`.

Until the gate passes, keep V2 unpublished. The Versions dialog explains
that the legacy pin is the pre-3.0 commit `ca7dc543`, that the full switch
has not been tested on hardware, and that support for switching to 3.0.x is
being prepared.
