import { useEffect, useState } from 'react';
import {
  Alert,
  Dialog,
  DialogContent,
  DialogTitle,
  Button,
} from '@mui/material';
import { useAppStore } from '@state/appStore.tsx';
import AlarmIcon from '@mui/icons-material/Alarm';
import { keyframes } from '@mui/system';
import { postDeviceStatus } from '@api/deviceStatus.ts';
import { useControlTempStore } from './controlTempStore.tsx';


type AlarmDismissalProps = {
  refetch: () => Promise<unknown>;
}

const pulse = keyframes`
    0% { transform: scale(1) translateX(0); }
    10% { transform: scale(1.1) translateX(-3px); }
    20% { transform: scale(1.1) translateX(3px); }
    30% { transform: scale(1.1) translateX(-3px); }
    40% { transform: scale(1.1) translateX(3px); }
    50% { transform: scale(1.2) translateX(0); }
    100% { transform: scale(1) translateX(0); }
`;


export default function AlarmDismissal({ refetch }: AlarmDismissalProps) {
  const { side, setIsUpdating, isUpdating } = useAppStore();
  const deviceStatus = useControlTempStore(state => state.deviceStatus);

  const [dismissed, setDismissed] = useState({ left: false, right: false });
  const [error, setError] = useState('');
  const isAlarmVibrating = deviceStatus?.[side]?.isAlarmVibrating || false;
  const leftRinging = deviceStatus?.left?.isAlarmVibrating || false;
  const rightRinging = deviceStatus?.right?.isAlarmVibrating || false;

  // Reset each side when its alarm stops, including the side not being viewed.
  useEffect(() => {
    setDismissed(current => ({
      left: leftRinging && current.left,
      right: rightRinging && current.right,
    }));
  }, [leftRinging, rightRinging]);


  const handleDismiss = () => {
    setError('');
    setIsUpdating(true);
    postDeviceStatus({
      [side]: {
        isAlarmVibrating: false,
      }
    })
      .then(() => {
        // Wait 1 second before refreshing the device status
        return new Promise((resolve) => setTimeout(resolve, 1_000));
      })
      .then(() => refetch())
      .then(() => {
        // Only hide the dialog once the dismiss actually succeeded. Marking it
        // dismissed unconditionally would close it on a failed dismiss while
        // the pod may still be vibrating.
        const stillRinging = useControlTempStore.getState().deviceStatus?.[side]?.isAlarmVibrating || false;
        setDismissed(current => ({ ...current, [side]: stillRinging }));
      })
      .catch(error => {
        console.error(error);
        setError('Could not dismiss the alarm. Try again.');
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  return (
    <Dialog
      open={ dismissed[side] ? false : isAlarmVibrating }
      aria-labelledby="active-alarm-title"
    >
      <DialogTitle id="active-alarm-title" sx={ { textAlign: 'center' } }>{ side === 'left' ? 'Left' : 'Right' } side alarm</DialogTitle>
      <DialogContent sx={ { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } }>
        <AlarmIcon
          fontSize="large"
          sx={ {
            animation: `${pulse} 2s infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          } }/>
        { error && <Alert severity="error">{ error }</Alert> }
        <Button
          onClick={ handleDismiss }
          disabled={ isUpdating }
          color="error"
          variant="contained"
        >
          Dismiss alarm
        </Button>
      </DialogContent>
    </Dialog>
  );
}
