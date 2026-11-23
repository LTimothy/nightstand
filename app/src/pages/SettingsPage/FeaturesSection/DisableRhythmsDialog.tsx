import { useMemo, useState } from 'react';
import moment from 'moment-timezone';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControl,
  FormControlLabel, FormLabel, Radio, RadioGroup, Stack, Typography,
} from '@mui/material';
import { useDeviceStatus } from '@api/deviceStatus';
import { disableRhythms, refreshRhythms, useResolvedSleeps } from '@api/rhythms';
import { useSchedules } from '@api/schedules';
import { useSettings } from '@api/settings';
import type { Settings } from '@api/settingsSchema';
import { serverMessage } from '@lib/requestError';
import { handoffFailed, handoffSummary, keepOnLabel, previewLines, runningSides, turnOffPreview, turnOffWindow } from './turnOffPreview';

type Props = { onClose: () => void; onDone: (message: string, severity: 'success' | 'warning') => void };

export default function DisableRhythmsDialog({ onClose, onDone }: Props) {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { data: schedules } = useSchedules();
  const deviceStatus = useDeviceStatus();
  const range = useMemo(() => turnOffWindow(new Date()), []);
  const left = useResolvedSleeps('left', range.from, range.to);
  const right = useResolvedSleeps('right', range.from, range.to);
  const [keepOn, setKeepOn] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  // The Pod leaves a side that is off as it is; a status it cannot read counts as on.
  const statusSettled = !!deviceStatus.data || deviceStatus.isError;
  const isOn = { left: deviceStatus.data?.left?.isOn, right: deviceStatus.data?.right?.isOn };
  const preview = settings && schedules && left.data && right.data && statusSettled
    ? turnOffPreview({ settings, schedules, sleeps: { left: left.data, right: right.data }, now: new Date(), isOn }) : undefined;
  const running = preview ? runningSides(preview) : [];
  const midSleep = running.length > 0;
  // Turning off now stops every side in a rhythm sleep, covered by the weekly schedule or not.
  const sleeping = preview?.filter(side => side.inSleepUntil).length ?? 0;
  const paused = !!preview?.some(side => side.paused);
  const now = moment.tz(settings?.timeZone ?? moment.tz.guess());

  const confirm = async () => {
    if (!settings) return;
    setWorking(true);
    setError('');
    try {
      const report = await disableRhythms({ powerOffNow: midSleep && !keepOn });
      await refreshRhythms(queryClient);
      await queryClient.invalidateQueries({ queryKey: ['useDeviceStatus'] });
      onDone(handoffSummary(report, settings), handoffFailed(report) ? 'warning' : 'success');
      onClose();
    } catch (caught) {
      // A request that timed out may still have gone through, so read the flag again before saying it is on.
      await refreshRhythms(queryClient);
      if (queryClient.getQueryData<Settings>(['useSettings'])?.features?.rhythms === false) {
        onDone('Rhythms is off, but the Pod did not confirm what each side did. Check the Bed page.', 'warning');
        onClose();
        return;
      }
      const message = serverMessage(caught);
      setError(message ? `Could not turn off Rhythms. ${message} Rhythms is still on.`
        : 'Could not turn off Rhythms. Rhythms is still on. Try again.');
    } finally {
      setWorking(false);
    }
  };

  return <Dialog open onClose={ () => { if (!working) onClose(); } } aria-labelledby="turn-off-rhythms-title" fullWidth maxWidth="sm">
    <DialogTitle id="turn-off-rhythms-title">Turn off Rhythms?</DialogTitle>
    <DialogContent>
      <DialogContentText>The weekly schedule comes back exactly as it was. Your rhythms are kept for next time.</DialogContentText>
      { !preview && !left.isError && !right.isError && <CircularProgress aria-label="Loading what happens next" sx={ { mt: 2 } }/> }
      { (left.isError || right.isError) && <Alert severity="warning" sx={ { mt: 2 } }>
        Could not load what happens next. You can still turn Rhythms off.
      </Alert> }
      { preview?.map(side => <Stack key={ side.side } spacing={ 0.5 } sx={ { mt: 2 } }>
        <Typography component="h3" variant="h4"><bdi>{ side.name }</bdi></Typography>
        { previewLines(side, now, keepOn).map(line => <Typography key={ line } variant="body2" color="text.secondary">{ line }</Typography>) }
      </Stack>) }
      { paused && <DialogContentText sx={ { mt: 2 } }>
        A pause stays on here, but older versions of Nightstand do not carry it over.
      </DialogContentText> }
      { midSleep && <FormControl sx={ { mt: 2 } }>
        <FormLabel id="turn-off-sleep-label">
          { running.length === 1 ? `${running[0].name}'s rhythm sleep is in progress` : 'Both sides are in a rhythm sleep' }
        </FormLabel>
        <RadioGroup
          aria-labelledby="turn-off-sleep-label"
          value={ keepOn ? 'keep' : 'off' }
          onChange={ event => setKeepOn(event.target.value === 'keep') }>
          <FormControlLabel
            value="keep"
            control={ <Radio/> }
            label={ running.length === 1 ? keepOnLabel(running[0]) : 'Keep both sides on until their sleeps end' }/>
          <FormControlLabel value="off" control={ <Radio/> } label={ sleeping > 1 ? 'Turn off both sides now' : 'Turn off now' }/>
        </RadioGroup>
      </FormControl> }
      { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
    </DialogContent>
    <DialogActions>
      <Button onClick={ onClose } disabled={ working }>Cancel</Button>
      <Button variant="contained" onClick={ () => void confirm() } disabled={ working || !settings }>Turn off Rhythms</Button>
    </DialogActions>
  </Dialog>;
}
