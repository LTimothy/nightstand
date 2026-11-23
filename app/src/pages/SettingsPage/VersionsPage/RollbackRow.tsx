import { Link } from 'react-router-dom';
import { useState, useId } from 'react';
import {
  Alert, ButtonBase, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Stack, Typography,
} from '@mui/material';
import RestorePageIcon from '@mui/icons-material/RestorePage';
import { postRollback } from '@api/update.ts';
import { useUpdateProgress } from '@api/useUpdateProgress.ts';
import InUseConfirm from '../../../components/InUseConfirm';
import RhythmsLeaveNote from './RhythmsLeaveNote';

type Props = {
  runningVersion: string | undefined;
  rollbackVersion: string;
};

export default function RollbackRow({ runningVersion, rollbackVersion }: Props) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { phase, error, inUse, recordedOutcome, start, reset } = useUpdateProgress(runningVersion, undefined, 'rollback');

  const rollback = () => start(confirmInUse => postRollback(confirmInUse ? { confirmInUse } : undefined));

  return (
    // The dialog is a sibling of the row, not a child of it. A portalled
    // dialog still bubbles its clicks up the React tree, so nesting it inside
    // the row would feed every click back into the row's own open handler.
    <>
      <ButtonBase
        onClick={ () => setOpen(true) }
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
          '&:hover': { backgroundColor: 'action.hover' },
        } }
      >
        <RestorePageIcon sx={ { color: 'text.secondary' } }/>
        <Stack>
          <Typography>Go back to v{ rollbackVersion }</Typography>
          <Typography variant="body2" color="text.secondary">Instant, no download</Typography>
        </Stack>
      </ButtonBase>

      <Dialog
        maxWidth="sm"
        aria-labelledby={ titleId }
        open={ open }
        onClose={ () => { if (phase !== 'updating') { reset(); setOpen(false); } } }>
        <DialogTitle id={ titleId }>
          { phase === 'idle' && `Go back to v${rollbackVersion}?` }
          { phase === 'updating' && 'Rolling back...' }
          { phase === 'failed' && (recordedOutcome ? 'Rollback did not finish' : 'Request failed') }
          { phase === 'timed_out' && 'Still not done' }
        </DialogTitle>
        <DialogContent>
          { phase === 'failed' && <Alert severity="error">{ error }</Alert> }
          { phase === 'idle' && <InUseConfirm reasons={ inUse }/> }
          { phase === 'idle' && (
            <DialogContentText>
              Nightstand switches back to the version it kept. Settings and sleep data stay.
              Schedules and alarms pause for about 2 minutes.
            </DialogContentText>
          ) }
          { phase === 'idle' && <RhythmsLeaveNote targetVersion={ rollbackVersion }/> }
          { phase === 'updating' && (
            <Stack spacing={ 2 } alignItems="flex-start" sx={ { py: 2 } }>
              <CircularProgress/>
              <Typography variant="body2" color="text.secondary">
                Rolling back to v{ rollbackVersion }. This page reloads by itself when done.
              </Typography>
            </Stack>
          ) }
          { phase === 'timed_out' && (
            <Stack spacing={ 1.5 }>
              <DialogContentText>
                  Rollback to v{ rollbackVersion } is not confirmed after 10 minutes.
                  Check the logs and current status before trying again.
              </DialogContentText>
              <Typography variant="body2">
                Last reported running version: { runningVersion ? `v${runningVersion}` : 'unavailable' }.
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" spacing={ 1 }>
                <Button component={ Link } to="/settings/logs?file=free-sleep-rollback.log">Open update logs</Button>
                <Button component={ Link } to="/settings/system">System status</Button>
              </Stack>
            </Stack>
          ) }
        </DialogContent>
        { phase !== 'updating' && <DialogActions>
          { phase === 'idle' && (
            <>
              <Button autoFocus={ inUse !== undefined } onClick={ () => { reset(); setOpen(false); } }>Cancel</Button>
              <Button variant="contained" onClick={ rollback }>{ inUse ? 'Continue anyway' : 'Go back now' }</Button>
            </>
          ) }
          { (phase === 'timed_out' || phase === 'failed') && (
            <Button onClick={ () => { reset(); setOpen(false); } }>Close</Button>
          ) }
        </DialogActions> }
      </Dialog>
    </>
  );
}
