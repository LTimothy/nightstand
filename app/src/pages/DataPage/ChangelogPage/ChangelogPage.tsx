import semver from 'semver';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, Accordion, AccordionDetails, AccordionSummary, Box, Chip, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { SubpageShell } from '../Header.tsx';
import MarkdownBody from '@components/MarkdownBody.tsx';
import { useChangelog, useRemoteChangelog, entriesNewerThan } from '@api/changelog.ts';
import type { ChangelogEntry } from '@api/changelogSchema';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useReleases } from '@api/releases.ts';
import { summary } from '@api/releaseSummary.ts';
import { useLatestVersion } from '@api/useLatestVersion.ts';
import { palette, weight } from '@design/tokens';

export default function ChangelogPage() {
  const { data: localEntries, isError, isPending, refetch } = useChangelog();
  const { data: remoteEntries } = useRemoteChangelog();
  const { data: deviceStatus } = useDeviceStatus();
  const latest = useLatestVersion();
  const { data: releases } = useReleases();
  const channelOf = new Map((releases?.releases ?? []).map(release => [release.version, release.channel]));
  const running = deviceStatus?.freeSleep?.version;
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, localEntries, remoteEntries]);
  const byVersion = new Map<string, ChangelogEntry>();
  for (const entry of [...(localEntries ?? []), ...entriesNewerThan(remoteEntries, running)]) {
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, entry);
  }
  const entries = [...byVersion.values()]
    .sort((left, right) => semver.valid(left.version) && semver.valid(right.version)
      ? semver.rcompare(left.version, right.version)
      : semver.valid(left.version) ? 1 : semver.valid(right.version) ? -1 : left.version.localeCompare(right.version));

  return (
    <SubpageShell title="Release notes" backTo="/settings/versions" backLabel="Back to Software">
      <Stack spacing={ 2 } useFlexGap sx={ { width: '100%' } }>
        { isError && <Alert severity="error" action={ <Button onClick={ () => void refetch() }>Retry</Button> }>
          Release notes could not be loaded.
        </Alert> }
        { isPending && <Typography role="status">Loading release notes...</Typography> }
        { !isError && !isPending && entries.length === 0 &&
          <Typography variant="body2" color="text.secondary">No changelog entries available.</Typography> }
        { entries.map(entry => (
          <Accordion
            key={ entry.version }
            id={ `release-v${entry.version}` }
            defaultExpanded={ hash === `#release-v${entry.version}` }
            disableGutters
            slotProps={ { transition: { unmountOnExit: true }, heading: { component: 'h2' } } }
            sx={ { backgroundColor: palette.bg.elevated, scrollMarginTop: 24 } }
          >
            <AccordionSummary expandIcon={ <ExpandMoreIcon/> } sx={ { '&.Mui-expanded .release-summary': { display: 'none' } } }>
              <Box sx={ { minWidth: 0 } }>
                <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 } }>
                  <Typography component="span" variant="subtitle1" sx={ { fontWeight: weight.heading } }>v{ entry.version }</Typography>
                  <Typography variant="caption" color="text.secondary">{ entry.date }</Typography>
                  { channelOf.has(entry.version) && <Chip
                    label={ channelOf.get(entry.version) === 'beta' ? 'Beta' : 'Stable' }
                    size="small"
                    variant="outlined"/> }
                  { entry.version === running && <Chip label="Running" size="small" variant="outlined"/> }
                  { entry.version === latest && <Chip
                    label="Latest"
                    size="small"
                    variant="outlined"/> }
                </Box>
                <Typography
                  className="release-summary"
                  variant="body2"
                  color="text.secondary"
                  sx={ { mt: 0.5, overflowWrap: 'anywhere', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }>
                  { summary(entry.body) ?? 'Release notes' }
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails><MarkdownBody markdown={ entry.body }/></AccordionDetails>
          </Accordion>
        )) }
      </Stack>
    </SubpageShell>
  );
}
