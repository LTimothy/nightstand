import { Link } from 'react-router-dom';
import { Alert, Button, CircularProgress, Stack, Typography } from '@mui/material';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Slide from '@mui/material/Slide';
import { TransitionProps } from '@mui/material/transitions';
import { useEffect, useState, useId, useRef, forwardRef, type ReactElement, type Ref } from 'react';
import InUseConfirm from '../../../components/InUseConfirm';
import { postUpdate } from '@api/update.ts';
import { useLatestVersion } from '@api/useLatestVersion.ts';
import { useReleases } from '@api/releases.ts';
import { useUpdateProgress } from '@api/useUpdateProgress.ts';
import { UpdateOutcome } from '@state/updateAttentionStore';
import semver from 'semver';

const Transition = forwardRef(function Transition(
  props: TransitionProps & {
    children: ReactElement<any, any>;
  },
  ref: Ref<unknown>,
) {
  return <Slide direction="up" ref={ ref } { ...props } />;
});

// Triggers the Pod's self-updater (scripts/update.sh via
// free-sleep-update.service) to install the latest published build. The pod
// downloads it, backs itself up, swaps, health-checks, and rolls back on its
// own if the new build fails.
// eslint-disable-next-line react/no-multi-comp
export default function UpdateFreeSleepButton({ runningVersion, onProblem, onStart, retry = false }: {
  runningVersion: string; onProblem?: (outcome: UpdateOutcome, startVersion: string) => void; onStart?: () => void; retry?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const startVersion = useRef(runningVersion);
  const latestVersion = useLatestVersion();
  const { data: manifest } = useReleases();
  const [targetVersion, setTargetVersion] = useState<string>();
  const targetIsBeta = manifest?.releases.find(release => release.version === targetVersion)?.channel === 'beta';
  const { phase, error, inUse, recordedOutcome, start, reset } = useUpdateProgress(runningVersion);

  // The notice is for a refused request, a timeout, or an update that ran and
  // failed (reported as unfinished). An update that stopped or went back
  // changed nothing, and the dialog already says why, so it leaves no notice.
  useEffect(() => {
    if (phase === 'timed_out') onProblem?.('timed_out', startVersion.current);
    else if (phase === 'failed' && !recordedOutcome) onProblem?.('failed', startVersion.current);
    else if (phase === 'failed' && recordedOutcome === 'failed') onProblem?.('timed_out', startVersion.current);
  }, [phase, recordedOutcome, onProblem]);

  const isNewer = (target?: string) => !!target && !!semver.valid(target) && !!semver.valid(runningVersion)
    && semver.gt(target, runningVersion);
  const startUpdate = () => {
    if (targetVersion && isNewer(targetVersion)) {
      startVersion.current = runningVersion;
      onStart?.();
      void start(confirmInUse => postUpdate({ targetVersion, ...(confirmInUse && { confirmInUse }) }));
    }
  };

  return (
    <>
      <Button
        variant="contained"
        disabled={ !isNewer(latestVersion) }
        onClick={ () => { reset(); setTargetVersion(latestVersion); setOpen(true); } }
        sx={ { width: '100%' } }
      >
        { retry ? 'Try again' : `Update${latestVersion ? ` to v${latestVersion}` : ''}` }
      </Button>
      <Dialog
        open={ open }
        maxWidth="sm"
        aria-labelledby={ titleId }
        slots={ {
          transition: Transition,
        } }
        onClose={ () => { if (phase !== 'updating') { reset(); setOpen(false); } } }
      >
        <DialogTitle id={ titleId }>
          { phase === 'idle' && (targetVersion ? `Update to v${targetVersion}?` : 'Update Nightstand?') }
          { phase === 'updating' && 'Updating...' }
          { phase === 'failed' && (recordedOutcome ? 'Update did not finish' : 'Request failed') }
          { phase === 'timed_out' && 'Still not done' }
        </DialogTitle>
        <DialogContent>
          { phase === 'failed' && <Alert severity="error">
            { !recordedOutcome && 'Nightstand did not accept the update request. Nothing was installed.' }
            { error && <Typography variant="body2">{ error }</Typography> }
          </Alert> }
          { phase === 'idle' && (
            <>
              <InUseConfirm reasons={ inUse }/>
              { targetIsBeta && (
                <Alert severity="info" sx={ { mb: 2 } }>
                  { `v${targetVersion} is a beta release. It has had less testing than stable.` }
                </Alert>
              ) }
              <DialogContentText>
                Nightstand restarts to finish, and schedules and alarms pause for up to five minutes.
              </DialogContentText>
              <DialogContentText sx={ { mt: 2, mb: 2 } }>
                If the checks fail, Nightstand tries to go back to v{ runningVersion } on its own. Recovery may require SSH.
              </DialogContentText>
            </>
          ) }
          { phase === 'updating' && (
            <Stack spacing={ 2 } alignItems="flex-start" sx={ { py: 2 } }>
              <CircularProgress/>
              <Typography variant="body2" color="text.secondary">
                Installing v{ targetVersion }. This page reloads by itself
                when Nightstand comes back on the new version.
              </Typography>
            </Stack>
          ) }
          { phase === 'timed_out' && (
            <Stack spacing={ 1.5 }>
              <DialogContentText>
                  Installation of v{ targetVersion } is not confirmed after 10 minutes. Nightstand may
                  still be updating or may have gone back to the previous version. Check its logs and current status.
              </DialogContentText>
              <DialogContentText>Until this page loads again, schedules and alarms are not running.</DialogContentText>
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
              <Button variant="contained" disabled={ !isNewer(targetVersion) } onClick={ startUpdate }>
                { inUse ? 'Continue anyway' : 'Update now' }
              </Button>
            </>
          ) }
          { phase === 'failed' && recordedOutcome !== 'failed' && <Button onClick={ startUpdate }>Try again</Button> }
          { (phase === 'timed_out' || phase === 'failed') && (
            <Button onClick={ () => { reset(); setOpen(false); } }>Close</Button>
          ) }
        </DialogActions> }
      </Dialog>
    </>
  );
}
