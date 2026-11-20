import { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import moment from 'moment-timezone';

import { friendlyTimeZone } from '@lib/timeZone';
import { postSettings, useSettings } from '@api/settings.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { supportsRisePattern } from '@api/alarmPattern.ts';
import { useAppStore } from '@state/appStore.tsx';
import WakeVibration from './AlarmSection/WakeVibrationSheet';

type Pattern = 'rise' | 'double';

// HTML <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" with no offset.
// We treat that string as wall-clock time in the user's timezone.
function isoToLocalInput(iso: string, tz: string): string {
  if (!iso) return '';
  const m = moment.tz(iso, tz);
  return m.isValid() ? m.format('YYYY-MM-DDTHH:mm') : '';
}

function localInputToIso(localStr: string, tz: string): string {
  if (!localStr) return '';
  const m = moment.tz(localStr, 'YYYY-MM-DDTHH:mm', tz);
  return m.isValid() ? m.format() : '';
}

export default function OneOffAlarmSection() {
  const { side } = useAppStore();
  const isUpdating = useAppStore(state => state.isUpdating);
  const { data: settings, refetch } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  const risePattern = supportsRisePattern(deviceStatus?.hubVersion, deviceStatus?.coverVersion);

  const [enabled, setEnabled] = useState(false);
  const [fireAtLocal, setFireAtLocal] = useState('');
  const [intensity, setIntensity] = useState(100);
  const [pattern, setPattern] = useState<Pattern>('double');
  const [duration, setDuration] = useState(30);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setSaved(false); }, [enabled, fireAtLocal, intensity, pattern, duration, side]);

  // Sync from server when settings load or side changes.
  useEffect(() => {
    if (!settings) return;
    const o = settings[side]?.oneOffAlarm;
    if (!o) return;
    setEnabled(o.enabled);
    setFireAtLocal(isoToLocalInput(o.fireAt, settings.timeZone ?? 'UTC'));
    setIntensity(o.vibrationIntensity);
    // An empty fireAt means no one-time alarm was ever saved, so its stored pattern is an old default.
    setPattern(o.fireAt ? o.vibrationPattern as Pattern : 'double');
    setDuration(o.duration);
  }, [settings, side]);

  if (!settings) return null;

  const fireAtIso = localInputToIso(fireAtLocal, settings.timeZone ?? 'UTC');
  const fireAtMoment = fireAtIso ? moment(fireAtIso) : null;
  const isInPast = !!fireAtMoment && fireAtMoment.isBefore(moment());

  // Switching a saved alarm off is a change to save; an alarm that is off and stays off has nothing to save.
  const hasChange = enabled || !!settings[side]?.oneOffAlarm?.enabled;
  const canSave =
    !saving && hasChange && Number.isInteger(duration) && duration >= 0 && duration <= 180 &&
    (!enabled || (!!fireAtLocal && !isInPast));

  const handleSave = async () => {
    if (!canSave) return;
    setSaveError('');
    setSaved(false);
    setSaving(true);
    try {
      await postSettings({
        [side]: {
          oneOffAlarm: {
            enabled,
            fireAt: fireAtIso,
            vibrationIntensity: intensity,
            vibrationPattern: pattern,
            duration,
          },
        },
      });
      await refetch();
      setSaved(true);
    } catch (err) {
      console.error(err);
      setSaveError('Could not save the one-time alarm. Your changes are still here. Try again.');
    } finally {
      setSaving(false);
    }
  };

  // Defaulting the picker to "tomorrow at the recurring alarm's time" would be
  // nicer, but a sane min is enough to prevent picking past times.
  const minLocal = moment.tz(settings.timeZone ?? 'UTC').add(1, 'minute').format('YYYY-MM-DDTHH:mm');

  const name = settings[side]?.name || `${side} side`;
  return (
    <Stack spacing={ 2 }>
      { saveError && <Alert severity="error">{ saveError }</Alert> }
      { saved && <Typography role="status" variant="body2">
        One-time alarm saved for <bdi>{ name }</bdi>.
      </Typography> }
      <Typography variant="body2" color="text.secondary">
        Rings once for <bdi>{ name }</bdi>, then turns off.
        { settings.features?.alarmsWhenOff ? '' : ' Rings only if this side is on at that time.' }
        { ' ' }Saved separately from this schedule.
      </Typography>

      <FormControlLabel
        label="One-time alarm"
        labelPlacement="start"
        sx={ { m: 0, width: '100%', justifyContent: 'space-between' } }
        control={ <Switch
          slotProps={ { input: { 'aria-label': 'Enable one-time alarm' } } }
          checked={ enabled }
          disabled={ saving || isUpdating }
          onChange={ (e) => setEnabled(e.target.checked) }/> }/>

      { enabled && <>
        <TextField
          type="datetime-local"
          label="Ring at"
          size="small"
          fullWidth
          value={ fireAtLocal }
          disabled={ saving || isUpdating }
          onChange={ (e) => setFireAtLocal(e.target.value) }
          InputLabelProps={ { shrink: true } }
          inputProps={ { min: minLocal } }
          error={ isInPast }
          helperText={ isInPast ? 'Time is in the past' : `Timezone: ${friendlyTimeZone(settings.timeZone ?? 'UTC')}` }/>
        <WakeVibration
          alarm={ { vibrationIntensity: intensity, vibrationPattern: pattern, duration } }
          maxDuration={ 180 }
          risePattern={ risePattern }
          disabled={ saving || isUpdating }
          onChange={ patch => {
            if (patch.vibrationIntensity !== undefined) setIntensity(patch.vibrationIntensity);
            if (patch.vibrationPattern !== undefined) setPattern(patch.vibrationPattern);
            if (patch.duration !== undefined) setDuration(patch.duration);
          } }/>
      </> }

      <Box sx={ { display: 'flex', justifyContent: 'flex-end' } }>
        <Button
          variant="contained"
          onClick={ handleSave }
          disabled={ !canSave }
        >
          { saving ? <CircularProgress size={ 18 } /> : 'Save one-time alarm' }
        </Button>
      </Box>
    </Stack>
  );
}
