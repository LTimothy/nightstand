import { useState } from 'react';
import moment from 'moment-timezone';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import {
  enableRhythms, postRhythms, refreshRhythms, rhythmsQuery, rhythmsSaveMessage, useRhythms, type RhythmsUpdate,
} from '@api/rhythms';
import type { RhythmsDB, SideRhythms } from '@api/rhythmsSchema';
import { supportsRisePattern } from '@api/alarmPattern';
import { useDeviceStatus } from '@api/deviceStatus';
import { useSettings } from '@api/settings';
import type { Settings } from '@api/settingsSchema';
import { serverMessage } from '@lib/requestError';
import { formatTemperature } from '@lib/temperatureConversions';
import { conversionDifference, describeDays, MAX_NAME_LENGTH, rhythmUsage } from '../../SchedulePage/rhythms/rhythmsModel';
import useTemperatureFormat from '@lib/useTemperatureFormat';

type Side = 'left' | 'right';
const SIDES: Side[] = ['left', 'right'];
const namesOf = (side: SideRhythms) => Object.fromEntries(Object.values(side.rhythms).map(rhythm => [rhythm.id, rhythm.name]));
const nameProblem = (value: string) => !value.trim() ? 'Enter a name.'
  : value.trim().length > MAX_NAME_LENGTH ? `Use ${MAX_NAME_LENGTH} characters or fewer.` : '';

const BACK_ON = 'Rhythms is on. Your saved rhythms are back on the Schedule tab.';

export default function EnableRhythmsDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const format = useTemperatureFormat();
  const { data: deviceStatus } = useDeviceStatus();
  // Turning on again keeps the saved rhythms, so the text depends on whether there are any.
  const saved = useRhythms();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [db, setDb] = useState<RhythmsDB>();
  const [names, setNames] = useState<Record<Side, Record<string, string>>>({ left: {}, right: {} });
  const today = moment.tz(settings?.timeZone ?? moment.tz.guess()).format('YYYY-MM-DD');
  const invalid = SIDES.some(side => Object.values(names[side]).some(value => !!nameProblem(value)));

  const turnOn = async () => {
    setWorking(true);
    setError('');
    try {
      const { converted } = await enableRhythms();
      await refreshRhythms(queryClient);
      const response = converted ? await queryClient.fetchQuery(rhythmsQuery) : undefined;
      if (!response?.data) {
        onDone(BACK_ON);
        onClose();
        return;
      }
      setDb(response.data);
      setNames({ left: namesOf(response.data.left), right: namesOf(response.data.right) });
    } catch (caught) {
      // A request that timed out may still have turned Rhythms on; the switch then shows it.
      await refreshRhythms(queryClient);
      if (queryClient.getQueryData<Settings>(['useSettings'])?.features?.rhythms) {
        onDone('Rhythms is on. Find it on the Schedule tab.');
        onClose();
        return;
      }
      // 409: a newer, unreadable or unconvertible file; the server says which.
      const message = serverMessage(caught);
      setError(message ? `Could not turn on Rhythms. ${message} Your weekly schedule is unchanged.`
        : 'Could not turn on Rhythms. Your weekly schedule is unchanged. Try again.');
    } finally {
      setWorking(false);
    }
  };

  const saveAndOpen = async () => {
    if (!db || invalid) return;
    const body: RhythmsUpdate = {};
    for (const side of SIDES) {
      const rhythms = Object.values(db[side].rhythms);
      if (rhythms.every(rhythm => names[side][rhythm.id].trim() === rhythm.name)) continue;
      const renamed = rhythms.map(rhythm => [rhythm.id, { ...rhythm, name: names[side][rhythm.id].trim() }]);
      body[side] = { ...db[side], rhythms: Object.fromEntries(renamed) };
    }
    setWorking(true);
    setError('');
    try {
      if (body.left || body.right) {
        await postRhythms(body);
        await refreshRhythms(queryClient);
      }
      onClose();
      navigate('/schedules', { state: { focus: 'week-heading' } });
    } catch (caught) {
      setError(rhythmsSaveMessage(caught, today));
    } finally {
      setWorking(false);
    }
  };

  return <Dialog open onClose={ () => { if (!working) onClose(); } } aria-labelledby="rhythms-on-title" fullWidth maxWidth="sm">
    { db ? <>
      <DialogTitle id="rhythms-on-title">Rhythms is on</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Your weekly schedule is now a set of rhythms, named after the days that use them. Days with the same night share one rhythm.
          Rename them here or later on the Schedule tab.
        </DialogContentText>
        { SIDES.map((side, sideIndex) => {
          const rhythms = Object.values(db[side].rhythms);
          return <Stack key={ side } spacing={ 1.5 } sx={ { mt: 2 } }>
            <Typography component="h3" variant="h4">
              <bdi>{ settings?.[side]?.name || (side === 'left' ? 'Left side' : 'Right side') }</bdi>
            </Typography>
            { rhythms.length === 0 && <Typography variant="body2" color="text.secondary">No nights were scheduled.</Typography> }
            { rhythms.map((rhythm, index) => {
              const value = names[side][rhythm.id] ?? rhythm.name;
              const problem = nameProblem(value);
              const days = describeDays(rhythmUsage(db[side], rhythm.id, today).days);
              const differs = conversionDifference(rhythm, rhythms.filter(other => other.id !== rhythm.id),
                fahrenheit => formatTemperature(fahrenheit, format),
                supportsRisePattern(deviceStatus?.hubVersion, deviceStatus?.coverVersion));
              return <TextField
                key={ rhythm.id }
                autoFocus={ index === 0 && sideIndex === SIDES.findIndex(item => Object.keys(db[item].rhythms).length > 0) }
                label={ `Name for ${days}` }
                value={ value }
                error={ !!problem }
                helperText={ problem || differs }
                onChange={ event => setNames(previous => ({ ...previous, [side]: { ...previous[side], [rhythm.id]: event.target.value } })) }/>;
            }) }
          </Stack>;
        }) }
        { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
      </DialogContent>
      <DialogActions>
        <Button onClick={ onClose } disabled={ working }>Close</Button>
        <Button variant="contained" onClick={ () => void saveAndOpen() } disabled={ working || invalid }>Open Schedule</Button>
      </DialogActions>
    </> : <>
      <DialogTitle id="rhythms-on-title">Turn on Rhythms?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          { saved.data?.data ? 'Your saved rhythms come back. Changes to the weekly schedule since then are not added. '
            : saved.data ? 'Rhythms copies your weekly schedule into named rhythms. ' : '' }
          You choose a rhythm for each day of the week and can change single dates.
          A rhythm can set its temperatures by hand or with Smart Schedule.
        </DialogContentText>
        <DialogContentText sx={ { mt: 2 } }>
          Your weekly schedule is kept as it is and comes back if you turn Rhythms off. Rhythms is in beta.
        </DialogContentText>
        { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
      </DialogContent>
      <DialogActions>
        <Button onClick={ onClose } disabled={ working }>Cancel</Button>
        <Button variant="contained" onClick={ () => void turnOn() } disabled={ working || saved.isPending }>Turn on Rhythms</Button>
      </DialogActions>
    </> }
  </Dialog>;
}
