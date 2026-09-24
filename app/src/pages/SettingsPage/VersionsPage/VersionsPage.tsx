import { useMemo } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary,
  Alert, AlertTitle, Box, Chip, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import semver from 'semver';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PageContainer from '../../PageContainer.tsx';
import Header from '../../DataPage/Header.tsx';
import Section from '../Section.tsx';
import MarkdownBody from '@components/MarkdownBody.tsx';
import UpdateFreeSleepButton from '../DeviceSettingsSection/UpdateFreeSleepButton.tsx';
import ReleaseRow from './ReleaseRow.tsx';
import RollbackRow from './RollbackRow.tsx';
import RevertToStockRow from './RevertToStockRow.tsx';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useSettings, postSettings } from '@api/settings.ts';
import { useLatestVersion } from '@api/useLatestVersion.ts';
import { useReleases } from '@api/releases.ts';
import { useChangelog, useRemoteChangelog, entriesNewerThan } from '@api/changelog.ts';
import { useRollbackInfo } from '@api/update.ts';
import { useServerStatus } from '@api/serverStatus.ts';
import { UPDATE_CHANNELS, UpdateChannelType } from '@api/settingsSchema.ts';
import currentServerInfo from '../../../../../server/src/serverInfo.json';

// First release that understands update-target.json. Older update.sh
// ignores the file and always installs the branch tip instead, which is
// harmless but means the picker and rollback wouldn't do what they say.
// Reads deviceStatus (the live running version), not the served bundle, so
// a stale cached page can't show a picker that won't work. 3.0.0 is this
// stream's first release and ships both the target protocol and the rollback
// service, so it is the floor. Keep it in step with FLOOR_VERSION in
// scripts/update.sh, which gates the same picker from the pod side.
const CAPABLE_FLOOR = '3.0.0';

export default function VersionsPage() {
  const { data: deviceStatus } = useDeviceStatus();
  const { data: settings, refetch: refetchSettings } = useSettings();
  const { data: releases } = useReleases();
  const { data: localChangelog } = useChangelog();
  const { data: remoteChangelog } = useRemoteChangelog();
  const { data: rollbackInfo } = useRollbackInfo();
  // Only the running row acts on this: it offers a reinstall to finish
  // migrations an earlier update could not apply.
  const { data: serverStatus } = useServerStatus();
  const offerReinstall = !!serverStatus?.database?.unappliedMigrations?.length;
  const latestVersion = useLatestVersion();

  const running = deviceStatus?.freeSleep?.version;
  const branch = deviceStatus?.freeSleep?.branch;
  const channel: UpdateChannelType = settings?.updateChannel ?? 'stable';
  const capable = !!running && semver.valid(running) && semver.gte(running, CAPABLE_FLOOR);

  const whatsNew = entriesNewerThan(remoteChangelog, running);

  let updateAvailable =
    !!latestVersion && !!running && !!semver.valid(running) && !!semver.valid(latestVersion) &&
    semver.gt(latestVersion, running);
  // Demo builds always show the alert so visitors see the flow, but if the
  // real releases.json fetch (from GitHub) doesn't actually have anything
  // newer than the mock's running version, showing its real (older) version
  // number would read as a bug ("latest is v3.2.0" while running v3.2.0).
  // Synthesize a plausible next version for display only in that case.
  let displayLatestVersion = latestVersion;
  if (import.meta.env.VITE_ENV === 'demo' && !updateAvailable) {
    updateAvailable = true;
    displayLatestVersion = (running && semver.valid(running) && semver.inc(running, 'minor')) || latestVersion;
  }

  const bodyByVersion = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of remoteChangelog ?? []) map.set(entry.version, entry.body);
    for (const entry of localChangelog ?? []) map.set(entry.version, entry.body);
    return map;
  }, [remoteChangelog, localChangelog]);

  return (
    <PageContainer sx={ { mb: 15, pt: 3, gap: 2, alignItems: 'stretch' } }>
      <Header title="Software & updates" icon={ <SystemUpdateAltIcon/> }/>

      <Box sx={ { display: 'flex', gap: 1, alignItems: 'center' } }>
        <Typography variant="body2">Nightstand</Typography>
        { running && <Chip label={ `v${running}` } size="small"/> }
        { branch && <Chip label={ branch } size="small"/> }
        {
          latestVersion && !updateAvailable && (
            <Chip icon={ <CheckCircleIcon/> } label="Up to date" color="success" variant="filled" size="small"/>
          )
        }
      </Box>

      { updateAvailable && (
        <Alert severity="info">
          <AlertTitle>Update available</AlertTitle>
          <Typography variant="body2" sx={ { mb: 1 } }>
            This pod is running v{ running }. The latest build on your channel is v{ displayLatestVersion }.
          </Typography>
          { whatsNew.length > 0 && (
            <Accordion
              disableGutters
              square
              sx={ { background: 'transparent', boxShadow: 'none', mb: 1, '&:before': { display: 'none' } } }
            >
              <AccordionSummary expandIcon={ <ExpandMoreIcon/> } sx={ { px: 0, minHeight: 0 } }>
                <Typography variant="body2">What's new</Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={ { px: 0, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5 } }
              >
                { whatsNew.map(entry => (
                  <Box key={ entry.version }>
                    <Typography variant="caption" sx={ { fontWeight: 600 } }>
                      v{ entry.version }, { entry.date }
                    </Typography>
                    <MarkdownBody markdown={ entry.body }/>
                  </Box>
                )) }
              </AccordionDetails>
            </Accordion>
          ) }
          <UpdateFreeSleepButton runningVersion={ running ?? currentServerInfo.version }/>
        </Alert>
      ) }

      <Section title="Update channel">
        <ToggleButtonGroup
          value={ channel }
          exclusive
          size="small"
          onChange={ (_e, value: UpdateChannelType | null) => {
            if (!value) return;
            postSettings({ updateChannel: value }).then(() => refetchSettings());
          } }
        >
          { UPDATE_CHANNELS.map(c => (
            <ToggleButton key={ c } value={ c }>{ c }</ToggleButton>
          )) }
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mt: 1 } }>
          Beta sees every release as soon as it ships. Stable only sees releases that have been
          promoted after a few days' soak.
        </Typography>
      </Section>

      { !capable && (
        <Alert severity="warning">
          Update to v{ CAPABLE_FLOOR } or later to unlock picking a specific version and instant
          rollback.
        </Alert>
      ) }

      { capable && rollbackInfo?.available && rollbackInfo.version && (
        <Section title="Instant rollback">
          <RollbackRow runningVersion={ running } rollbackVersion={ rollbackInfo.version }/>
        </Section>
      ) }

      { capable && releases && (
        <Section title="All releases">
          <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1 } }>
            Downgrading keeps your data (databases aren't rewritten). Installing any version
            replaces the instant-rollback slot above. Versions below v{ CAPABLE_FLOOR } can't be
            installed from here.
          </Typography>
          { releases.releases.map(release => (
            <ReleaseRow
              key={ release.version }
              release={ release }
              runningVersion={ running }
              body={ bodyByVersion.get(release.version) }
              offerReinstall={ offerReinstall }
            />
          )) }
        </Section>
      ) }

      <Section title="Danger zone">
        <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mb: 1 } }>
          Undo Nightstand entirely and go back to plain upstream free-sleep.
        </Typography>
        <RevertToStockRow runningVersion={ running }/>
      </Section>
    </PageContainer>
  );
}
