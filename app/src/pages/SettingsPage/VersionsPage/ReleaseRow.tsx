import { useState, useId } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Stack, Typography,
} from '@mui/material';
import semver from 'semver';
import { postUpdate } from '@api/update.ts';
import { migrationsApplied, useUpdateProgress } from '@api/useUpdateProgress.ts';
import type { Release } from '@api/releases.ts';
import { summary } from '@api/releaseSummary.ts';
import { downgradeWarnings } from './downgradeWarnings';
import InUseConfirm from '../../../components/InUseConfirm';
import RhythmsLeaveNote from './RhythmsLeaveNote';
import { palette, weight } from '@design/tokens';

type Props = {
  release: Release;
  runningVersion: string | undefined;
  body: string | undefined;
  // The database has migrations this version ships but never applied. A
  // reinstall of the running version is the one thing that finishes them.
  offerReinstall?: boolean;
};

export default function ReleaseRow({ release, runningVersion, body, offerReinstall = false }: Props) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const notes = body ? summary(body) : undefined;
  const isRunning = release.version === runningVersion;
  const isReinstall = isRunning && offerReinstall;
  // A reinstall never changes the running version, so it is done when the
  // database is, not when the version moves.
  const { phase, error, inUse, recordedOutcome, start, reset } = useUpdateProgress(runningVersion, isReinstall ? migrationsApplied : undefined);

  const isDowngrade = !!runningVersion && !!semver.valid(runningVersion) && semver.lt(release.version, runningVersion);

  const warnings = downgradeWarnings(release, runningVersion);

  const install = () => start(confirmInUse => postUpdate({
    targetVersion: release.version, allowDowngrade: isDowngrade, ...(confirmInUse && { confirmInUse }),
  }));

  return (
    <Box sx={ { py: 1.5, borderBottom: `1px solid ${palette.border.subtle}` } }>
      <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 } }>
        <Typography sx={ { fontWeight: weight.heading } }>v{ release.version }</Typography>
        <Typography variant="caption" color="text.secondary">{ release.date }</Typography>
        <Chip label={ release.channel === 'beta' ? 'Beta' : 'Stable' } size="small" variant="outlined"/>
        { isRunning && <Chip label="Running" size="small" variant="outlined"/> }
        <Box sx={ { flex: 1 } }/>
        { (!isRunning || isReinstall) && (
          <Button variant="outlined" onClick={ () => setOpen(true) }>
            { isReinstall ? 'Reinstall' : isDowngrade ? 'Install (downgrade)' : 'Install' }
          </Button>
        ) }
      </Box>
      { notes && <Typography variant="body2" color="text.secondary" sx={ { overflowWrap: 'anywhere' } }>{ notes }</Typography> }

      <Dialog
        maxWidth="sm"
        aria-labelledby={ titleId }
        open={ open }
        onClose={ () => { if (phase !== 'updating') { reset(); setOpen(false); } } }>
        <DialogTitle id={ titleId }>
          { phase === 'idle' && `${isReinstall ? 'Reinstall' : 'Install'} v${release.version}?` }
          { phase === 'updating' && 'Installing...' }
          { phase === 'failed' && (recordedOutcome ? 'Update did not finish' : 'Request failed') }
          { phase === 'timed_out' && 'Still not done' }
        </DialogTitle>
        <DialogContent>
          { phase === 'failed' && <Alert severity="error">{ error }</Alert> }
          { phase === 'idle' && <InUseConfirm reasons={ inUse }/> }
          { phase === 'idle' && release.channel === 'beta' && (
            <Alert severity="info" sx={ { mb: 2 } }>
              { `v${release.version} is a beta release. It has had less testing than stable.` }
            </Alert>
          ) }
          { phase === 'idle' && (
            <DialogContentText>
              { isReinstall
                ? `This reinstalls v${release.version} to finish database changes an earlier update left ` +
                  'undone. Your data is kept, and the new updater applies what is missing.'
                : isDowngrade
                  ? `This downgrades from v${runningVersion} to v${release.version}. Your data is kept. ` +
                  'Database migrations are not reversed. The running installation becomes the rollback slot.'
                  : `Nightstand will download v${release.version}, back itself up, install, and check its own ` +
                  'health. If the new version fails those checks, it tries to go back to the previous one.' }
              { ' ' }The app, schedules, and alarms pause during restart. Recovery may require SSH.
            </DialogContentText>
          ) }
          { phase === 'idle' && warnings.length > 0 && <Alert severity="warning" sx={ { mt: 2 } }>
            <Box component="ul" sx={ { m: 0, pl: 2 } }>{ warnings.map(warning => <li key={ warning }>{ warning }</li>) }</Box>
          </Alert> }
          { phase === 'idle' && isDowngrade && <RhythmsLeaveNote targetVersion={ release.version }/> }
          { phase === 'updating' && (
            <Stack spacing={ 2 } alignItems="flex-start" sx={ { py: 2 } }>
              <CircularProgress/>
              <Typography variant="body2" color="text.secondary">
                Installing v{ release.version }. This page reloads by itself when Nightstand comes back.
              </Typography>
            </Stack>
          ) }
          { phase === 'timed_out' && (
            <Stack spacing={ 1.5 }>
              <DialogContentText>
                { isReinstall ? `Reinstallation and database changes for v${release.version} are not confirmed`
                  : `Installation of v${release.version} is not confirmed` }
                { ' ' }after 10 minutes. Nightstand may still be working or may have gone back to the previous version.
              </DialogContentText>
              <Typography variant="body2">
                Last reported running version: { runningVersion ? `v${runningVersion}` : 'unavailable' }.
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" spacing={ 1 }>
                <Button component={ Link } to="/settings/logs?file=free-sleep-update.log">Open update logs</Button>
                <Button component={ Link } to="/settings/system">System status</Button>
              </Stack>
            </Stack>
          ) }
        </DialogContent>
        { phase !== 'updating' && <DialogActions>
          { phase === 'idle' && (
            <>
              <Button autoFocus={ inUse !== undefined } onClick={ () => { reset(); setOpen(false); } }>Cancel</Button>
              <Button variant="contained" onClick={ install }>
                { inUse ? 'Continue anyway' : isReinstall ? 'Reinstall now' : 'Install now' }
              </Button>
            </>
          ) }
          { (phase === 'timed_out' || phase === 'failed') && (
            <Button onClick={ () => { reset(); setOpen(false); } }>Close</Button>
          ) }
        </DialogActions> }
      </Dialog>
    </Box>
  );
}
