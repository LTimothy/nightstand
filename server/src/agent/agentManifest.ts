// The committed definition of the agent overlay: the smallest set of files
// that turns a stock upstream install into one that can update itself, roll
// back, and revert to stock, with no other behavior change.
//
// Day zero, only self-update is live. The rollback and revert units listed
// below are files in the tree; nothing has installed them to
// /etc/systemd/system or written their sudoers rules until install.sh or
// update.sh has run once, and jobs/rollback.ts and jobs/revertToStock.ts
// just start those units. So a freshly overlaid pod can update itself, and
// the other two light up once it has.
//
// This is a server-side tooling artifact, not client code, and is not
// imported by the app bundle. ops/build-agent.sh reads it to generate the
// overlay; agentManifest.test.ts gates it.
//
// Modes:
//   add   the file is absent from stock and is copied in
//   copy  the file exists in stock and is replaced wholesale
//   patch the file exists in stock and is edited surgically, because
//         copying it would drag the rest of this tree along with it

export type AgentMode = 'add' | 'copy' | 'patch';

export type AgentEntry = {
  path: string;
  mode: AgentMode;
  why: string;
};

// Upstream publishes no tags at all, so the version string below resolves to
// no ref and cannot identify a tree. The sha is the base; the version is a
// label for humans, read out of upstream's own serverInfo.json. If upstream
// pushes to main without bumping that version, "2.1.5" silently denotes a
// different tree, which is why the sha is what gets pinned.
export const AGENT_BASE = {
  repo: 'https://github.com/throwaway31265/free-sleep.git',
  version: '2.1.5',
  sha: 'dc0c710f2800a7b6c0e3356abd5c5c166e0a36e1',
};

// What agent files may reach for outside the agent itself: other agent
// files, the paths and packages declared below, and Node builtins (bare
// forms from NODE_BUILTINS_BARE, or anything node:-prefixed). Every path and
// package below is verified present in stock at AGENT_BASE.sha; Node
// builtins are not stock's to grant, since Node ships itself, so they live
// in their own list rather than STOCK_CONTRACT.packages. Keeping this short
// is what keeps the agent small, and agentManifest.test.ts fails if any
// agent file imports outside it.
//
// Scope, so this is not read as more than it is: that gate walks TypeScript
// imports, so it covers the .ts/.tsx entries below. The shell scripts and
// systemd units are not checked for what they reach for, and install.sh and
// update.sh do call sibling scripts that the overlay does not carry. Those
// resolve because both run against a full fork tree, not against the overlay
// alone.
export const STOCK_CONTRACT = {
  paths: [
    'app/src/api/api.ts',
    'app/src/api/deviceStatus.ts',
    'app/src/api/jobs.ts',
    'app/src/api/settings.ts',
    'server/src/logger.ts',
  ],
  packages: [
    'react',
    'react-router-dom',
    'zustand',
    'axios',
    'semver',
    '@mui/material',
    '@mui/icons-material',
    '@tanstack/react-query',
    'express',
    'zod',
  ],
};

// Node builtins agent files bare-import, e.g. `import fs from 'fs'`.
// node:-prefixed forms (e.g. `node:fs`) are always allowed too; that rule is
// a resolver detail and lives in agentManifest.test.ts, not here.
export const NODE_BUILTINS_BARE = ['fs', 'child_process'];

export const AGENT_MANIFEST: AgentEntry[] = [
  // The update path. Stock already has an updater; the agent replaces it with
  // one that also does rollback, revert to stock, and targeted versions.
  { path: 'app/src/api/serverInfo.ts', mode: 'copy', why: 'asks this fork for the latest version rather than upstream' },
  { path: 'app/src/api/useLatestVersion.ts', mode: 'add', why: 'selects a release eligible for the saved update channel' },
  { path: 'app/src/api/releases.ts', mode: 'add', why: 'fetches and validates the release manifest' },
  { path: 'app/src/api/update.ts', mode: 'add', why: 'update, rollback and revert API client' },
  { path: 'app/src/api/updateSchema.ts', mode: 'add', why: 'shared update request and response types' },
  { path: 'app/src/state/updateAttentionStore.ts', mode: 'add', why: 'retains update request outcomes while navigating the app' },
  { path: 'app/src/api/useUpdateProgress.ts', mode: 'add', why: 'polls for the pod coming back on a new version' },
  { path: 'app/src/api/bedInUse.ts', mode: 'add', why: 'reads the reasons an update, rollback or switch is held while the bed may be in use' },
  { path: 'app/src/components/InUseConfirm.tsx', mode: 'add', why: 'shows those reasons before the second confirmation' },
  { path: 'app/src/components/VersionStatus.tsx', mode: 'copy', why: 'hosts the update prompt and the rollback and revert rows' },
  { path: 'app/src/pages/SettingsPage/DeviceSettingsSection/UpdateFreeSleepButton.tsx', mode: 'copy', why: 'triggers the pod self-updater' },
  { path: 'app/src/pages/SettingsPage/VersionsPage/RollbackRow.tsx', mode: 'add', why: 'instant offline rollback to the previous tree' },
  {
    path: 'app/src/pages/SettingsPage/VersionsPage/RevertToStockRow.tsx',
    mode: 'add',
    why: 'the reversibility claim: return the pod to plain upstream',
  },
  {
    path: 'app/src/pages/SettingsPage/VersionsPage/RhythmsLeaveNote.tsx',
    mode: 'add',
    why: 'tells a Rhythms user what a rollback or the switch to upstream does',
  },

  // Pod-side machinery.
  { path: 'scripts/install.sh', mode: 'copy', why: 'installs this fork and wires the agent units' },
  { path: 'scripts/update.sh', mode: 'copy', why: 'download, back up, swap, health check, auto rollback' },
  { path: 'scripts/update_service.sh', mode: 'copy', why: 'systemd entry point for the updater' },
  { path: 'scripts/setup_services.sh', mode: 'add', why: 'installs the updater, rollback and revert units and their sudoers rules' },
  { path: 'scripts/restore_helpers.sh', mode: 'add', why: 'shared writer, dependency, firewall and restart steps for restores' },
  { path: 'scripts/recover_update.sh', mode: 'add', why: 'settles marked update swaps after an interruption' },
  { path: 'scripts/systemd/free-sleep-recover-update.service', mode: 'add', why: 'bounds one recovery attempt after boot' },
  { path: 'scripts/systemd/free-sleep-recover-update.timer', mode: 'add', why: 'schedules recovery without holding boot completion' },
  { path: 'scripts/rollback_pod.sh', mode: 'add', why: 'swaps the live and previous trees offline' },
  { path: 'scripts/close_update_window.sh', mode: 'add', why: 'closes the download window after the update or revert unit stops' },
  // No snapshot exists to restore. Upstream ships no tags, so this downloads
  // the upstream commit releases.json records as checked with the switch, or
  // main until one is recorded. Neither is pinned to AGENT_BASE.sha, and
  // neither need equal the tree the pod started from.
  { path: 'scripts/switch-to-upstream.sh', mode: 'add', why: 'the reversibility claim: downloads and installs plain upstream' },
  { path: 'scripts/revert-to-stock.sh', mode: 'add', why: 'the old name of switch-to-upstream.sh, which older units and docs still run' },
  { path: 'scripts/systemd/free-sleep-rollback.service', mode: 'add', why: 'stock has no systemd directory; it writes its unit inline' },
  { path: 'scripts/systemd/free-sleep-revert.service', mode: 'add', why: 'stock has no systemd directory; it writes its unit inline' },

  { path: 'scripts/sqlite-safety.py', mode: 'add', why: 'consistent database snapshots and verified migration recovery' },
  { path: 'scripts/prepare-downgrade.py', mode: 'add', why: 'preserves configured sensor archive retention in older trees' },
  { path: 'scripts/prepare-upstream.py', mode: 'add', why: 'prepares settings accepted by the upstream reader' },
  { path: 'scripts/write_result.py', mode: 'add', why: 'records how an update, rollback or switch ended, so the app can report it' },
  { path: 'scripts/tree_digest.py', mode: 'add', why: 'checks a downloaded release against the checksum releases.json publishes for it' },
  { path: 'scripts/system_scripts.py', mode: 'add', why: 'keeps the scripts root runs in a folder only root can write' },

  // Server routes and jobs.
  { path: 'server/src/jobs/privilegedCommand.ts', mode: 'add', why: 'checks unit and sudo readiness before accepting an operation' },
  { path: 'server/src/jobs/update.ts', mode: 'copy', why: 'runs update.sh via the sudoers-permitted unit' },
  { path: 'server/src/jobs/rollback.ts', mode: 'add', why: 'runs rollback_pod.sh via its unit' },
  { path: 'server/src/jobs/revertToStock.ts', mode: 'add', why: 'runs switch-to-upstream.sh via its unit' },
  { path: 'server/src/routes/update/update.ts', mode: 'add', why: 'POST /api/update and the rollback availability read' },
  { path: 'server/src/routes/update/updateSchema.ts', mode: 'add', why: 'validates the update target' },
  { path: 'server/src/routes/update/inUseText.ts', mode: 'add', why: 'says why an update waits while the bed may be in use' },
  { path: 'server/src/serverInfo.json', mode: 'copy', why: 'identifies the build: version, branch, fork, upstream base' },
  {
    path: 'server/package.json',
    mode: 'patch',
    why: 'needs the test script added, since stock has no test runner entry; a copy would drag in every dependency of this tree',
  },
  { path: 'server/src/setup/routes.ts', mode: 'patch', why: 'aggregates every route in the tree, so a copy imports routes stock does not have' },

  // Tests travel with the code they cover.
  { path: 'server/src/updaterScripts.test.ts', mode: 'add', why: 'pins update.sh invariants' },
  { path: 'server/src/rollbackScript.test.ts', mode: 'add', why: 'pins rollback_pod.sh invariants' },
  { path: 'server/src/switchToUpstreamScript.test.ts', mode: 'add', why: 'pins switch-to-upstream.sh invariants' },
];
