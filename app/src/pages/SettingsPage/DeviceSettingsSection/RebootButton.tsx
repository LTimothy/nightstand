import { useState } from 'react';
import { isAxiosError } from 'axios';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { postJobs } from '@api/jobs.ts';

export default function RebootButton() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restart = async () => {
    setPending(true);
    setError(null);
    try {
      await postJobs(['reboot']);
      setRequested(true);
    } catch (failure) {
      const data = isAxiosError(failure) ? failure.response?.data : undefined;
      const message = [data?.message, data?.error].find(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      setError(message ?? 'Could not confirm the restart. Check System status before retrying.');
    } finally {
      setPending(false);
    }
  };
  return <>
    <Button variant="outlined" onClick={ () => { setOpen(true); setError(null); setRequested(false); } }>Restart Pod</Button>
    <Dialog open={ open } onClose={ () => !pending && setOpen(false) } aria-labelledby="restart-title">
      <DialogTitle id="restart-title">Restart Pod?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          The app, schedules and alarms pause while the Pod restarts. Takes about a minute.
          Wait for it to reconnect before sending more commands.
        </DialogContentText>
        { requested && <Typography role="status" sx={ { mt: 2 } }>Restart requested. Completion has not been confirmed.</Typography> }
        { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
        { (requested || error) && <Button component={ Link } to="/settings/system" sx={ { ml: -1, mt: 1 } }>System status</Button> }
      </DialogContent>
      <DialogActions>
        <Button disabled={ pending } onClick={ () => setOpen(false) }>{ requested ? 'Close' : 'Cancel' }</Button>
        { !requested && <Button variant="contained" disabled={ pending } onClick={ () => void restart() }>
          { pending ? 'Requesting restart...' : 'Restart Pod' }
        </Button> }
      </DialogActions>
    </Dialog>
  </>;
}
