import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { swapSides } from '@api/swapSides';
import { serverMessage } from '@lib/requestError';
import { useAppStore } from '@state/appStore.tsx';

export default function SwapSidesButton() {
  const queryClient = useQueryClient();
  const { side, setSide } = useAppStore();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    setOpen(false);
    setError('');
  };
  const swap = async () => {
    setWorking(true);
    setError('');
    try {
      await swapSides(queryClient);
      // This device keeps showing the same person.
      setSide(side === 'left' ? 'right' : 'left');
      close();
    } catch (caught) {
      setError(serverMessage(caught) ?? 'Could not swap the sides. Try again.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <Button variant="outlined" onClick={ () => setOpen(true) } sx={ { mt: 2, alignSelf: 'flex-start' } }>Swap sides</Button>
      <Dialog open={ open } onClose={ working ? undefined : close }>
        <DialogTitle>Swap sides?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Names, schedules, rhythms, alarms, tap and button settings move to the other side. Past nights follow each
            person on the Sleep page. Sensor calibration stays with each side.
          </DialogContentText>
          { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
        </DialogContent>
        <DialogActions>
          <Button onClick={ close } disabled={ working }>Cancel</Button>
          <Button onClick={ () => void swap() } disabled={ working } variant="contained">Swap</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
