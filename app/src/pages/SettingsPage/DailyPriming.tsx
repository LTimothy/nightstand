import { Box, TextField } from '@mui/material';
import { Settings } from '@api/settingsSchema.ts';
import { DeepPartial } from 'ts-essentials';
import { useAppStore } from '@state/appStore.tsx';
import ToggleRow from '@components/ToggleRow';

type PrimePodScheduleProps = {
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
};

export default function DailyPriming({ settings, updateSettings }: PrimePodScheduleProps) {
  const { isUpdating } = useAppStore();
  return <Box sx={ { display: 'flex', flexDirection: 'column', gap: 2, mb: 2 } }>
    <ToggleRow
      label="Prime daily"
      disabled={ isUpdating || !settings }
      checked={ settings?.primePodDaily?.enabled ?? false }
      onChange={ next => updateSettings({ primePodDaily: { enabled: next } }) }
    />
    <TextField
      label="Prime time"
      type="time"
      value={ settings ? settings.primePodDaily?.time || '12:00' : '' }
      onChange={ event => updateSettings({ primePodDaily: { time: event.target.value } }) }
      disabled={ isUpdating || !settings || settings.primePodDaily?.enabled === false }
      slotProps={ { inputLabel: { shrink: true } } }
      fullWidth
    />
    <ToggleRow
      label="Restart the Pod an hour before priming"
      disabled={ isUpdating || settings?.rebootDaily === undefined || settings?.primePodDaily?.enabled === false }
      checked={ settings ? settings.rebootDaily ?? true : false }
      onChange={ next => updateSettings({ rebootDaily: next }) }
    />
  </Box>;
}
