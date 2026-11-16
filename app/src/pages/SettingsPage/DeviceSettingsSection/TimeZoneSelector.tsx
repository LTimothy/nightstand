import { friendlyTimeZone } from '../../../lib/timeZone';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select, { SelectChangeEvent } from '@mui/material/Select';
import { DeepPartial } from 'ts-essentials';

import { TIME_ZONES } from '@api/timeZones.ts';
import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';


type TimeZoneSelectorProps = {
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
}

export default function TimeZoneSelector({ settings, updateSettings }: TimeZoneSelectorProps) {
  const { isUpdating } = useAppStore();

  const handleChange = (event: SelectChangeEvent) => {
    updateSettings({
      timeZone: event.target.value as Settings['timeZone']
    });
  };

  return (
    <Box sx={ { minWidth: 0, width: '100%', maxWidth: '100%' } }>
      <FormControl fullWidth>
        <InputLabel id="time-zone-label">Time zone</InputLabel>
        <Select
          labelId="time-zone-label"
          error={ settings?.timeZone === null }
          disabled={ isUpdating || !settings }
          value={ settings?.timeZone || '' }
          label="Time zone"
          renderValue={ friendlyTimeZone }
          onChange={ handleChange }
        >
          {
            // A stored zone outside the list still needs an option, or the select shows blank.
            [...(settings?.timeZone && !TIME_ZONES.includes(settings.timeZone) ? [settings.timeZone] : []), ...TIME_ZONES].map(zone => (
              <MenuItem value={ zone } key={ zone } sx={ { whiteSpace: 'normal' } }>
                <ListItemText
                  primary={ friendlyTimeZone(zone) }
                  secondary={ friendlyTimeZone(zone) === zone ? undefined : zone }
                  slotProps={ { secondary: { sx: { fontFamily: 'monospace', fontSize: 12 } } } }
                />
              </MenuItem>
            ))
          }
        </Select>
      </FormControl>
    </Box>
  );
}
