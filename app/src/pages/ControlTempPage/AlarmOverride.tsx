import type { ReactNode } from 'react';
import { Dispatch, SetStateAction, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import moment from 'moment-timezone';
import { postSettings, useSettings } from '@api/settings.ts';
import { useAppStore } from '@state/appStore.tsx';

interface AlarmOverrideProps {
  open: boolean;
  alarmTimeLocalOverride: string;
  scheduledAlarmTimeHhMm: string;
  nightStart: string;
  nightEnd: string;
  scope: ReactNode;
  setAlarmTimeLocalOverride: Dispatch<SetStateAction<string>>;
  setOverrideOpen: Dispatch<SetStateAction<boolean>>;
}

export default function AlarmOverride({ open, setOverrideOpen, alarmTimeLocalOverride, scheduledAlarmTimeHhMm,
  setAlarmTimeLocalOverride, nightStart, nightEnd, scope }: AlarmOverrideProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const { data: settings, refetch } = useSettings();
  const side = useAppStore(state => state.side);
  const time = alarmTimeLocalOverride || scheduledAlarmTimeHhMm;
  const start = moment.tz(nightStart, settings?.timeZone || 'UTC');
  const [hour, minute] = time.split(':').map(Number);
  const replacement = start.clone().hour(hour).minute(minute).second(0).millisecond(0);
  if (time < start.format('HH:mm')) replacement.add(1, 'day');
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && replacement.isAfter(moment())
    && replacement.isBetween(start, moment(nightEnd), undefined, '[]');
  // The scheduled time can itself sit on the night's edge, so only an edit is judged.
  const showError = !valid && !!alarmTimeLocalOverride;
  const handleCancel = () => { setAlarmTimeLocalOverride(''); setOverrideOpen(false); };
  const handleSave = async () => {
    if (!settings || !valid) return;
    setIsSaving(true);
    setError('');
    try {
      await postSettings({ [side]: { scheduleOverrides: { alarm: {
        disabled: false, timeOverride: time, expiresAt: nightEnd,
      } } } });
      await refetch();
      handleCancel();
    } catch {
      setError('Could not save the alarm change. Try again.');
    } finally { setIsSaving(false); }
  };
  return <Dialog open={ open } onClose={ () => !isSaving && handleCancel() } fullWidth maxWidth="xs" aria-labelledby="alarm-override-title">
    <DialogTitle id="alarm-override-title">Change this night's recurring alarms</DialogTitle>
    <DialogContent>
      <Typography variant="body2" sx={ { mb: 1 } }>{ scope }</Typography>
      <Typography variant="body2" sx={ { mb: 2 } }>
        Replaces all recurring alarms still to come this night with one alarm. One-time alarms are unchanged.
      </Typography>
      <TextField
        label="Alarm"
        type="time"
        value={ time }
        onChange={ event => setAlarmTimeLocalOverride(event.target.value) }
        disabled={ isSaving }
        error={ showError }
        helperText={ valid ? replacement.format('ddd, MMM D · h:mm A')
          : showError ? 'Already past or too late.' : undefined }
        fullWidth />
      { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
    </DialogContent>
    <DialogActions>
      <Button onClick={ handleCancel } disabled={ isSaving }>Cancel</Button>
      <Button
        variant="contained"
        disabled={ isSaving || !valid || !alarmTimeLocalOverride || time === scheduledAlarmTimeHhMm }
        onClick={ () => void handleSave() }>
        { isSaving ? 'Saving...' : 'Save' }
      </Button>
    </DialogActions>
  </Dialog>;
}
