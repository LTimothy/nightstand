import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Slider,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import moment from 'moment-timezone';

import { friendlyTimeZone } from '@lib/timeZone';
import { palette } from '@design/tokens';
import { postSettings, useSettings } from '@api/settings.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { RISE_PATTERN_NOTE, supportsRisePattern } from '@api/alarmPattern.ts';
import { useAppStore } from '@state/appStore.tsx';

const PATTERNS = ['rise', 'double'] as const;
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
  const { data: settings, refetch } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  const risePattern = supportsRisePattern(deviceStatus?.hubVersion, deviceStatus?.coverVersion);

  const [enabled, setEnabled] = useState(false);
  const [fireAtLocal, setFireAtLocal] = useState('');
  const [intensity, setIntensity] = useState(100);
  const [pattern, setPattern] = useState<Pattern>('rise');
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
    setPattern(o.vibrationPattern as Pattern);
    setDuration(o.duration);
  }, [settings, side]);

  if (!settings) return null;

  const fireAtIso = localInputToIso(fireAtLocal, settings.timeZone ?? 'UTC');
  const fireAtMoment = fireAtIso ? moment(fireAtIso) : null;
  const isInPast = !!fireAtMoment && fireAtMoment.isBefore(moment());

  const durations = [...new Set([duration, ...Array.from({ length: 18 }, (_, index) => (index + 1) * 10)])]
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 180)
    .sort((first, second) => first - second);
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

  return (
    <Box>
      { saveError && <Alert severity="error">{ saveError }</Alert> }
      { saved && <Typography role="status" variant="body2">
        One-time alarm saved for <bdi>{ settings[side]?.name || `${side} side` }</bdi>.
      </Typography> }
      <Typography variant="body2" color="text.secondary" sx={ { mb: 2 } }>
        Rings once for <bdi>{ settings[side]?.name || `${side} side` }</bdi>, then turns off. Rings only if this side is on at that time.
        { ' ' }Saved separately from this schedule.
      </Typography>

      <Box sx={ { display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 } }>
        <Typography sx={ { color: palette.text.primary } }>Enabled</Typography>
        <Switch
          slotProps={ { input: { 'aria-label': 'Enable one-time alarm' } } }
          checked={ enabled }
          onChange={ (e) => setEnabled(e.target.checked) } />
      </Box>

      { enabled && (
        <>
          <Box sx={ { mb: 2 } }>
            <TextField
              type="datetime-local"
              label="Ring at"
              fullWidth
              variant="standard"
              value={ fireAtLocal }
              onChange={ (e) => setFireAtLocal(e.target.value) }
              InputLabelProps={ { shrink: true } }
              inputProps={ { min: minLocal } }
              error={ isInPast }
              helperText={ isInPast ? 'Time is in the past' : `Timezone: ${friendlyTimeZone(settings.timeZone ?? 'UTC')}` }
            />
          </Box>

          <Box sx={ { display: 'flex', gap: 2, mb: 2 } }>
            <TextField
              select
              label="Length"
              variant="standard"
              value={ duration }
              onChange={ (e) => setDuration(Number(e.target.value)) }
              sx={ { flex: 1 } }>
              { durations.map(value => <MenuItem key={ value } value={ value }>{ value % 60 === 0 && value > 0
                ? `${value / 60} ${value === 60 ? 'minute' : 'minutes'}` : `${value} seconds` }</MenuItem>) }
            </TextField>
            <TextField
              select
              label="Pattern"
              variant="standard"
              value={ risePattern ? pattern : 'double' }
              onChange={ (e) => setPattern(e.target.value as Pattern) }
              sx={ { flex: 1 } }>
              { PATTERNS.map((p) => (
                <MenuItem key={ p } value={ p } disabled={ p === 'rise' && !risePattern }>
                  { p === 'rise' ? 'Builds up' : 'Double pulse' }
                </MenuItem>
              )) }
            </TextField>
          </Box>
          { !risePattern && <Typography variant="caption" component="p" color="text.secondary" sx={ { mt: -1, mb: 2 } }>
            { RISE_PATTERN_NOTE }
          </Typography> }

          <Box sx={ { mb: 1 } }>
            <Typography id="one-time-alarm-strength" variant="body2" sx={ { color: palette.text.secondary, mb: 1 } }>
              Strength { intensity } of 100
            </Typography>
            <Slider
              aria-labelledby="one-time-alarm-strength"
              value={ intensity }
              onChange={ (_e, v) => setIntensity(Array.isArray(v) ? v[0] : v) }
              min={ 1 }
              max={ 100 }
              step={ 1 }
            />
          </Box>
        </>
      ) }

      <Box sx={ { display: 'flex', justifyContent: 'flex-end', mt: 1 } }>
        <Button
          variant="contained"
          onClick={ handleSave }
          disabled={ !canSave }
        >
          { saving ? <CircularProgress size={ 18 } /> : 'Save one-time alarm' }
        </Button>
      </Box>
    </Box>
  );
}
