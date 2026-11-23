import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Slider, Stack, TextField, Typography } from '@mui/material';
import ChevronRight from '@mui/icons-material/ChevronRight';
import type { Alarm } from '@api/schedulesSchema';
import AlarmTest from './AlarmTest';
import { RISE_PATTERN_NOTE } from '@api/alarmPattern.ts';
import { BOTTOM_SHEET } from '@design/sheetStyles';

// The summary button for an alarm's vibration and the sheet it opens, shared by every alarm kind.
export default function WakeVibration({ alarm, onChange, risePattern, maxDuration = 300, disabled }: {
  alarm: Alarm;
  onChange: (patch: Partial<Alarm>) => void;
  // Whether this Pod rings the rising pattern; other Pods always get double.
  risePattern: boolean;
  maxDuration?: number;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pattern = risePattern && alarm.vibrationPattern === 'rise' ? 'Builds up' : 'Double pulse';
  const durations = [...new Set([alarm.duration, ...Array.from({ length: maxDuration / 10 }, (_, index) => (index + 1) * 10)])]
    .sort((first, second) => first - second);
  const close = () => setOpen(false);
  return <>
    <Button
      fullWidth
      disabled={ disabled }
      aria-label={ `Vibrate: ${pattern}, strength ${alarm.vibrationIntensity}, ${alarm.duration} seconds` }
      endIcon={ <ChevronRight/> }
      sx={ { justifyContent: 'space-between', textAlign: 'left', minHeight: 44, mt: 1, px: 0, textTransform: 'none' } }
      onClick={ () => setOpen(true) }>
      <Typography component="span" variant="body2" color="text.secondary">
        { pattern }, strength { alarm.vibrationIntensity },
        { ' ' }<Box component="span" sx={ { whiteSpace: 'nowrap' } }>{ alarm.duration } s</Box>
      </Typography>
    </Button>
    <Dialog
      open={ open }
      onClose={ close }
      aria-labelledby="wake-vibration-title"
      fullWidth
      maxWidth="sm"
      sx={ BOTTOM_SHEET }>
      <DialogTitle id="wake-vibration-title">Alarm vibration</DialogTitle>
      <DialogContent><Stack spacing={ 2 } sx={ { pt: 1 } }>
        <TextField
          select
          label="Pattern"
          value={ risePattern ? alarm.vibrationPattern : 'double' }
          disabled={ disabled }
          helperText={ risePattern ? undefined : RISE_PATTERN_NOTE }
          onChange={ event => onChange({ vibrationPattern: event.target.value as 'rise' | 'double' }) }>
          <MenuItem value="rise" disabled={ !risePattern }>Builds up</MenuItem><MenuItem value="double">Double pulse</MenuItem>
        </TextField>
        <Box><Typography id="vibration-strength">Strength { alarm.vibrationIntensity } of 100</Typography>
          <Slider
            aria-labelledby="vibration-strength"
            min={ 1 }
            max={ 100 }
            value={ alarm.vibrationIntensity }
            disabled={ disabled }
            onChange={ (_, value) => onChange({ vibrationIntensity: value as number }) }/></Box>
        <TextField
          select
          label="Length"
          value={ alarm.duration }
          disabled={ disabled }
          onChange={ event => onChange({ duration: Number(event.target.value) }) }>
          { durations.map(duration => <MenuItem key={ duration } value={ duration }>{ duration % 60 === 0 && duration > 0
            ? `${duration / 60} ${duration === 60 ? 'minute' : 'minutes'}` : `${duration} seconds` }</MenuItem>) }
        </TextField>
        <AlarmTest vibrationIntensity={ alarm.vibrationIntensity } vibrationPattern={ alarm.vibrationPattern }/>
      </Stack></DialogContent>
      <DialogActions><Button onClick={ close }>Done</Button></DialogActions>
    </Dialog>
  </>;
}
