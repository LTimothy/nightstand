import type { ReactNode } from 'react';
import { Dispatch, SetStateAction, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { postSettings, useSettings } from '@api/settings.ts';
import { useAppStore } from '@state/appStore.tsx';

interface AlarmDisabledDialogProps {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  nightEnd: string;
  scope: ReactNode;
  alarmDisabled: boolean;
}

export default function AlarmDisabledDialog({ open, setOpen, nightEnd, scope, alarmDisabled }: AlarmDisabledDialogProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const { refetch } = useSettings();
  const side = useAppStore(state => state.side);
  const handleSave = async () => {
    setIsSaving(true);
    setError('');
    try {
      await postSettings({ [side]: { scheduleOverrides: { alarm: {
        disabled: !alarmDisabled, timeOverride: '', expiresAt: alarmDisabled ? '' : nightEnd,
      } } } });
      await refetch();
      setOpen(false);
    } catch {
      setError('Could not save the alarm change. Try again.');
    } finally {
      setIsSaving(false);
    }
  };
  return <Dialog open={ open } onClose={ () => !isSaving && setOpen(false) } fullWidth maxWidth="xs" aria-labelledby="alarm-disable-title">
    <DialogTitle id="alarm-disable-title">{ alarmDisabled ? 'Restore recurring alarms?' : 'Skip recurring alarms for this night?' }</DialogTitle>
    <DialogContent>
      <Typography variant="body2" sx={ { mb: 1 } }>{ scope }</Typography>
      <Typography variant="body2">Applies to all remaining recurring alarms for this night. One-time alarms are unchanged.</Typography>
      { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
    </DialogContent>
    <DialogActions>
      <Button onClick={ () => setOpen(false) } disabled={ isSaving }>Cancel</Button>
      <Button variant="contained" disabled={ isSaving } onClick={ () => void handleSave() }>
        { isSaving ? 'Saving...' : alarmDisabled ? 'Restore' : 'Skip' }
      </Button>
    </DialogActions>
  </Dialog>;
}
