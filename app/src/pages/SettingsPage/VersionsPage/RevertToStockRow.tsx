import { Link } from 'react-router-dom';
import { useState, useId } from 'react';
import {
  Alert, ButtonBase, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Stack, Typography,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useReleases, selectSwitchTarget } from '@api/releases.ts';
import type { UpstreamSwitchRecord } from '@api/updateSchema.ts';
import { postSwitchToUpstream } from '@api/update.ts';
import { useUpdateProgress } from '@api/useUpdateProgress.ts';
import InUseConfirm from '../../../components/InUseConfirm';
import RhythmsLeaveNote from './RhythmsLeaveNote';

type Props = {
  runningVersion: string | undefined;
};

export default function RevertToStockRow({ runningVersion }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState<UpstreamSwitchRecord>();
  const [legacyFallback, setLegacyFallback] = useState(false);
  const titleId = useId();
  const { phase, error, inUse, recordedOutcome, start, reset } = useUpdateProgress(runningVersion, undefined, 'switch');
  const { data: manifest, isLoading, isError } = useReleases();
  const target = selectSwitchTarget(manifest);
  const targetUnchanged = confirmed !== undefined && selectSwitchTarget(manifest, confirmed) !== undefined;

  const manifestFailed = isError && manifest === undefined;
  const canRevert = targetUnchanged || (legacyFallback && manifestFailed);

  const revert = () => {
    if (!canRevert) return;
    return start(confirmInUse => postSwitchToUpstream({
      ...(confirmed ? { target: confirmed } : {}), ...(confirmInUse ? { confirmInUse } : {}),
    }));
  };

  return (
    // The dialog is a sibling of the row, not a child of it. A portalled
    // dialog still bubbles its clicks up the React tree, so nesting it inside
    // the row would feed every click back into the row's own open handler.
    <>
      <ButtonBase
        disabled={ isLoading }
        onClick={ () => {
          setConfirmed(target ? { ...target } : undefined);
          setLegacyFallback(manifestFailed);
          setOpen(true);
        } }
        sx={ {
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          textAlign: 'left',
          justifyContent: 'flex-start',
          width: '100%',
          minHeight: 44,
          px: 0,
          py: 1.5,
          borderRadius: 1,
        } }
      >
        <WarningAmberIcon sx={ { color: 'text.secondary' } }/>
        <Typography sx={ { fontSize: '1rem' } }>
          Switch to upstream free-sleep
        </Typography>
      </ButtonBase>

      <Dialog aria-labelledby={ titleId } open={ open } onClose={ () => { if (phase !== 'updating') { reset(); setOpen(false); } } }>
        <DialogTitle id={ titleId }>
          { phase === 'idle' && 'Switch to upstream free-sleep?' }
          { phase === 'updating' && 'Switching to upstream...' }
          { phase === 'failed' && (recordedOutcome ? 'Switch did not finish' : 'Request failed') }
          { phase === 'timed_out' && 'Still not done' }
        </DialogTitle>
        <DialogContent>
          { phase === 'failed' && <Alert severity="error">{ error }</Alert> }
          { phase === 'idle' && <InUseConfirm reasons={ inUse }/> }
          { phase === 'idle' && (
            <DialogContentText component="div">
              <Typography variant="body2" sx={ { mb: 2 } }>
                Replace the app with upstream free-sleep. Settings and sleep data remain on the Pod.
                Schedules and alarms pause during restart.
              </Typography>
              <Typography variant="body2" sx={ { mb: 2 } }>
                { legacyFallback
                  ? "Installs upstream free-sleep's newest code, which this switch has not been checked with."
                  : confirmed && 'version' in confirmed
                    ? `Installs upstream free-sleep ${confirmed.version}, commit ${confirmed.commit}, validated ${confirmed.date}.`
                    : `Switch to upstream installs the pinned pre-3.0 commit ${confirmed?.commit ?? 'ca7dc543'}, not upstream 3.0.3.`
                    + ' The full switch has not been tested on hardware. Support for switching to 3.0.x is being prepared.' }
              </Typography>
              { !canRevert && <Alert severity="warning" sx={ { mb: 2 } }>
                { confirmed || legacyFallback ? 'The upstream target changed. Close this dialog and review the target again.'
                  : 'No validated target is available for the new switch.' }
              </Alert> }
              <Typography variant="body2" sx={ { mb: 2 } }>
                A copy of the original code and settings is saved under /persistent/free-sleep-backups/
                in a timestamped prerevert-to-stock directory. A consistent sleep database backup is saved
                separately under /persistent/free-sleep-database-backups/.
              </Typography>
              <Typography variant="body2" sx={ { mb: 2 } }>
                Upstream keeps only the first enabled alarm per day, limits vibration to 180 seconds,
                and does not run one-time alarms. Level temperatures become Fahrenheit, and
                base-control and set-temperature taps become alarm-dismiss actions. The original settings remain in the backup.
              </Typography>
              <Typography variant="body2" sx={ { mb: 2 } }>
                This does not remove everything Nightstand installed. Systemd units, disabled timers,
                drop-ins, sudoers rules, firewall rules, the watchdog setting, raw-archive/ and backups
                may remain outside the app directory. The archive timer is stopped and disabled;
                the switch log reports the retained archive size so you can decide whether to delete it.
              </Typography>
              <Alert severity="warning" sx={ { mb: 2 } }>
                Upstream's first update may print "reset, all data will be lost". Do not follow that
                reset instruction: the existing data is intact. Its installer can also lose recent
                sleep records from the database WAL. Keep the backup before running upstream updates.
                Remote access through Tailscale ends at upstream's first update; arrange local or SSH access first.
              </Alert>
              <Typography variant="body2">
                Returning to Nightstand requires the migration tool from a computer with SSH access.
                If installation checks fail, Nightstand tries to go back. Recovery may require SSH.
              </Typography>
            </DialogContentText>
          ) }
          { phase === 'idle' && <RhythmsLeaveNote/> }
          { phase === 'updating' && (
            <Stack spacing={ 2 } alignItems="center" sx={ { py: 2 } }>
              <CircularProgress/>
              <Typography variant="body2" color="text.secondary">
                Switching to upstream free-sleep. This page reloads by itself when done.
              </Typography>
            </Stack>
          ) }
          { phase === 'timed_out' && (
            <Stack spacing={ 1.5 }>
              <DialogContentText>
                  Switching to upstream free-sleep is not confirmed after 10 minutes.
                  Check the logs and current status before trying again.
              </DialogContentText>
              <Typography variant="body2">
                Last reported running version: { runningVersion ? `v${runningVersion}` : 'unavailable' }.
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" spacing={ 1 }>
                <Button component={ Link } to="/settings/logs?file=free-sleep-revert.log">Open update logs</Button>
                <Button component={ Link } to="/settings/system">System status</Button>
              </Stack>
            </Stack>
          ) }
        </DialogContent>
        <DialogActions
          sx={ { flexDirection: { xs: 'column', sm: 'row' }, gap: 1, px: 3, pb: 3,
            '& > :not(style) ~ :not(style)': { ml: 0 }, '& .MuiButton-root': { width: { xs: '100%', sm: 'auto' } } } }>
          { phase === 'idle' && (
            <>
              <Button autoFocus={ inUse !== undefined } onClick={ () => { reset(); setOpen(false); } }>Cancel</Button>
              <Button color="error" variant="contained" disabled={ !canRevert } onClick={ revert }>
                { inUse ? 'Continue anyway' : 'Switch to upstream free-sleep' }
              </Button>
            </>
          ) }
          { (phase === 'timed_out' || phase === 'failed') && (
            <Button onClick={ () => { reset(); setOpen(false); } }>Close</Button>
          ) }
        </DialogActions>
      </Dialog>
    </>
  );
}
