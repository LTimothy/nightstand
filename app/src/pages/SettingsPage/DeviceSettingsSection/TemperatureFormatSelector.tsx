import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';

import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';

type TemperatureFormatSelectorProps = {
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
}

export default function TemperatureFormatSelector({ settings, updateSettings }: TemperatureFormatSelectorProps) {
  const { isUpdating } = useAppStore();
  const format = settings ? settings.temperatureFormat ?? 'fahrenheit' : null;

  return (
    <Box>
      <Typography variant="body2">Temperature display</Typography>
      <ToggleButtonGroup
        sx={ { flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButton-root': { minHeight: 44 } } }
        color="primary"
        exclusive
        value={ format }
        disabled={ isUpdating || !settings }
        onChange={ (_event, next) => {
          if (next) updateSettings({ temperatureFormat: next });
        } }
      >
        <ToggleButton value="fahrenheit">Fahrenheit</ToggleButton>
        <ToggleButton value="celsius">Celsius</ToggleButton>
        <ToggleButton value="level">Level</ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}
