import SectionHeading from '@components/SectionHeading';
import { useCallback, useRef, useState } from 'react';
import { useUpdateAttentionStore, type UpdateOutcome } from '@state/updateAttentionStore';
import {
  Accordion, AccordionDetails, AccordionSummary,
  Alert, Box, Button, Dialog, DialogContent, DialogTitle, FormControlLabel, Link as MuiLink, List, ListItem, ListItemButton, ListItemText,
  Radio, RadioGroup, Typography,
} from '@mui/material';
import semver from 'semver';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Link } from 'react-router-dom';
import moment from 'moment-timezone';
import { BOTTOM_SHEET } from '@design/sheetStyles';
import { SubpageShell } from '../../DataPage/Header.tsx';
import Section from '../Section.tsx';
import MarkdownBody from '@components/MarkdownBody.tsx';
import UpdateFreeSleepButton from '../DeviceSettingsSection/UpdateFreeSleepButton.tsx';
import BetaOnStableNotice from './BetaOnStableNotice.tsx';
import ReleaseRow from './ReleaseRow.tsx';
import RollbackRow from './RollbackRow.tsx';
import RevertToStockRow from './RevertToStockRow.tsx';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useSettings, postSettings } from '@api/settings.ts';
import { useLatestVersion } from '@api/useLatestVersion.ts';
import { useReleases, releasesForChannel } from '@api/releases.ts';
import { useRemoteChangelog, entriesNewerThan } from '@api/changelog.ts';
import { useRollbackInfo } from '@api/update.ts';
import { useServerStatus } from '@api/serverStatus.ts';
import { UPDATE_CHANNELS, UpdateChannelType } from '@api/settingsSchema.ts';
import currentServerInfo from '../../../../../server/src/serverInfo.json';
import { weight } from '@design/tokens';

// First release that understands update-target.json. Older update.sh
// ignores the file and always installs the branch tip instead, which is
// harmless but means the picker and rollback wouldn't do what they say.
// Reads deviceStatus (the live running version), not the served bundle, so
// a stale cached page can't show a picker that won't work. 3.0.0 is this
// stream's first release and ships both the target protocol and the rollback
// service, so it is the floor. Keep it in step with FLOOR_VERSION in
// scripts/update.sh, which gates the same picker from the Pod side.
const CAPABLE_FLOOR = '3.0.0';
const RECENT_RELEASES = 5;
const EIGHT_SLEEP_STEPS_URL = 'https://github.com/LTimothy/nightstand/blob/main/INSTALLATION.md#going-back-to-the-eight-sleep-app';

export default function VersionsPage() {
  const { data: deviceStatus } = useDeviceStatus();
  const { data: settings, isError: settingsError, refetch: refetchSettings } = useSettings();
  const { data: releases, isError: releasesFailed, refetch: checkReleases, dataUpdatedAt, isFetching } = useReleases();
  const [channelOpen, setChannelOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const channelRow = useRef<HTMLDivElement>(null);
  const updateProblem = useUpdateAttentionStore(state => state.updateAttention);
  const setUpdateProblem = useUpdateAttentionStore(state => state.setUpdateAttention);
  const updateOutcome = useUpdateAttentionStore(state => state.updateOutcome);
  const reportProblem = useCallback((outcome: UpdateOutcome, startVersion: string) =>
    setUpdateProblem(true, outcome, startVersion), [setUpdateProblem]);
  const clearProblem = useCallback(() => setUpdateProblem(false), [setUpdateProblem]);
  const [channelError, setChannelError] = useState<string>();
  const [savingChannel, setSavingChannel] = useState(false);
  const { data: remoteChangelog } = useRemoteChangelog();
  const { data: rollbackInfo } = useRollbackInfo();
  // Only the running row acts on this: it offers a reinstall to finish
  // migrations an earlier update could not apply.
  const { data: serverStatus } = useServerStatus();
  const offerReinstall = !!serverStatus?.database?.unappliedMigrations?.length;
  const latestVersion = useLatestVersion();

  const running = deviceStatus?.freeSleep?.version;
  // Releases fall back to stable while settings are missing, but the row and
  // the radios never present that fallback as the Pod's actual channel.
  const savedChannel = settings?.updateChannel;
  const channel: UpdateChannelType = savedChannel ?? 'stable';
  const channelLabel = savedChannel === undefined
    ? (settings || settingsError ? 'Unavailable' : 'Loading...')
    : savedChannel === 'stable' ? 'Stable' : 'Beta';
  const capable = !!running && semver.valid(running) && semver.gte(running, CAPABLE_FLOOR);

  const eligibleReleases = releasesForChannel(releases, channel);
  const eligibleVersions = new Set(eligibleReleases
    .map(release => release.version));
  const whatsNew = entriesNewerThan(remoteChangelog, running)
    .filter(entry => eligibleVersions.has(entry.version));

  const updateAvailable =
    !!latestVersion && !!running && !!semver.valid(running) && !!semver.valid(latestVersion) &&
    semver.gt(latestVersion, running);

  return (
    <SubpageShell title="Software">

      { savedChannel !== undefined && (
        <BetaOnStableNotice
          running={ running }
          releases={ releases?.releases }
          saved={ savedChannel }
          onSwitched={ () => channelRow.current?.focus() }/>
      ) }
      { releasesFailed && <Alert severity="warning">Release information is unavailable. Try checking again.</Alert> }
      { updateAvailable && (
        <Section title={ `Version ${latestVersion} is ready` }>
          <Typography variant="body2" sx={ { mb: 1 } }>
            This Pod is running v{ running }.
          </Typography>
          { whatsNew.length > 0 && (
            <Accordion
              disableGutters
              square
              sx={ { background: 'transparent', boxShadow: 'none', border: 0, '&:before': { display: 'none' } } }
            >
              <AccordionSummary expandIcon={ <ExpandMoreIcon/> } sx={ { px: 0, minHeight: 44 } }>
                <Typography variant="body2">What's new</Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={ { px: 0, maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5 } }
              >
                { whatsNew.map(entry => (
                  <Box key={ entry.version }>
                    <Typography variant="body2" sx={ { fontWeight: weight.heading } }>
                      v{ entry.version }, { entry.date }
                    </Typography>
                    <MarkdownBody markdown={ entry.body }/>
                  </Box>
                )) }
              </AccordionDetails>
            </Accordion>
          ) }
          <UpdateFreeSleepButton
            runningVersion={ running ?? currentServerInfo.version }
            onProblem={ reportProblem }
            onStart={ clearProblem }
            retry={ updateProblem && updateOutcome === 'failed' }
          />
          <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>
            Up to five minutes. Schedules and alarms pause while Nightstand restarts.
          </Typography>
        </Section>
      ) }

      { !updateAvailable && latestVersion && running && semver.valid(running) && !releasesFailed && <Section>
        <Typography>Nightstand v{ running } is up to date.</Typography>
        { dataUpdatedAt > 0 && <Typography variant="body2" color="text.secondary">
          Checked { moment(dataUpdatedAt).format('h:mm A') }
        </Typography> }
        <Button disabled={ isFetching } sx={ { ml: -1 } } onClick={ () => void checkReleases() }>Check again</Button>
      </Section> }
      { updateProblem && <Alert severity="warning">
        { updateOutcome === 'failed' ? 'Nightstand did not accept the update request. Nothing was installed.'
          : 'The last update did not finish. Check its progress before trying recovery.' }
        <Button onClick={ () => setUpdateProblem(false) }>Dismiss update notice</Button>
        <Button component={ Link } to="/settings/logs?file=free-sleep-update.log">Open update logs</Button>
        { updateOutcome !== 'failed' && capable && rollbackInfo?.available && rollbackInfo.version && (
          <RollbackRow runningVersion={ running } rollbackVersion={ rollbackInfo.version }/>
        ) }
      </Alert> }
      <List disablePadding sx={ { bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' } }>
        <ListItemButton
          ref={ channelRow }
          onClick={ () => setChannelOpen(true) }
          sx={ { py: 1.5, borderBottom: 1, borderColor: 'divider' } }>
          <ListItemText primary="Update channel" secondary={ channelLabel } />
          <ChevronRightIcon color="action" />
        </ListItemButton>
        <ListItemButton component={ Link } to="/changelog" sx={ { py: 1.5 } }>
          <ListItemText primary="Release notes" /><ChevronRightIcon color="action" />
        </ListItemButton>
        <Dialog
          open={ channelOpen }
          onClose={ () => setChannelOpen(false) }
          fullWidth
          maxWidth="sm"
          sx={ BOTTOM_SHEET }
          aria-labelledby="update-channel-title">
          <DialogTitle id="update-channel-title">Update channel</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={ { mb: 2 } }>
            Stable gets a release after it has been used for a while without problems. Beta gets each release
            right away, with less testing.
            </Typography>
            <RadioGroup
              aria-label="Update channel"
              value={ savedChannel ?? '' }
              onChange={ (_event, value) => {
                setChannelError(undefined);
                setSavingChannel(true);
                postSettings({ updateChannel: value as UpdateChannelType })
                  .then(() => refetchSettings()).then(() => setChannelOpen(false))
                  .catch(() => setChannelError('Could not save the update channel. Try selecting it again.'))
                  .finally(() => setSavingChannel(false));
              } }>
              { UPDATE_CHANNELS.map(value => <FormControlLabel
                key={ value }
                value={ value }
                disabled={ savingChannel || settings?.updateChannel === undefined }
                control={ <Radio/> }
                label={ value === 'stable' ? 'Stable' : 'Beta' }
                sx={ { minHeight: 44 } }
              />) }
            </RadioGroup>
            { channelError && <Alert severity="error">{ channelError }</Alert> }
          </DialogContent>
        </Dialog>
        <Accordion
          disableGutters
          sx={ { border: 0, borderTop: 1, borderColor: 'divider', borderRadius: '0 !important' } }
          slotProps={ { transition: { unmountOnExit: true } } }>
          <AccordionSummary expandIcon={ <ExpandMoreIcon/> } sx={ { fontWeight: weight.regular, lineHeight: 1.5 } }>Recovery</AccordionSummary>
          <AccordionDetails sx={ { display: 'flex', flexDirection: 'column', gap: 2 } }>
            { !capable && (
              <Typography variant="body2" color="text.secondary">
          Update to v{ CAPABLE_FLOOR } or later to unlock picking a specific version and instant
          rollback.
              </Typography>
            ) }

            { capable && rollbackInfo?.available && rollbackInfo.version && (
              <Box>
                <SectionHeading sx={ { mb: 1.5 } }>Previous installation</SectionHeading>
                <RollbackRow runningVersion={ running } rollbackVersion={ rollbackInfo.version }/>
              </Box>
            ) }

            { capable && releases && (
              <Box>
                <SectionHeading sx={ { mb: 1.5 } }>Install a specific version</SectionHeading>
                <Typography variant="body2" color="text.secondary" sx={ { mb: 1 } }>
            Installing any version replaces the rollback slot above.
                </Typography>
                { (showAll ? eligibleReleases : eligibleReleases.slice(0, RECENT_RELEASES)).map(release => (
                  <ReleaseRow
                    key={ release.version }
                    release={ release }
                    runningVersion={ running }
                    offerReinstall={ offerReinstall }
                  />
                )) }
                { !showAll && eligibleReleases.length > RECENT_RELEASES && (
                  <Button sx={ { ml: -1, mt: 1 } } onClick={ () => setShowAll(true) }>Show all { eligibleReleases.length } versions</Button>
                ) }
              </Box>
            ) }

            <RevertToStockRow runningVersion={ running }/>

            <ListItem component="div" disableGutters sx={ { display: 'block', py: 0 } }>
              <ListItemText
                primary="Go back to Eight Sleep"
                secondary={ 'Nightstand cannot restore Eight Sleep\'s software from here. On Pod 3 and Pod 4 this needs a '
                  + 'firmware reset. On Pod 5 no reset procedure has been checked yet.' }
              />
              <MuiLink
                href={ EIGHT_SLEEP_STEPS_URL }
                target="_blank"
                rel="noopener noreferrer"
                variant="body2"
                sx={ { display: 'inline-flex', alignItems: 'center', minHeight: 44 } }>
                Read the steps
              </MuiLink>
            </ListItem>
          </AccordionDetails>
        </Accordion>
      </List>
    </SubpageShell>
  );
}
