import { FormControl, InputLabel, MenuItem, Select, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';

import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';

const OPTIONS: Array<{ days: number; label: string }> = [
  { days: 2, label: '2 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
];

type RawArchiveRetentionProps = {
  settings?: Settings;
  updateSettings: (settings: DeepPartial<Settings>) => void;
}

export default function RawArchiveRetention({ settings, updateSettings }: RawArchiveRetentionProps) {
  const { isUpdating } = useAppStore();

  return (
    <>
      <FormControl fullWidth>
        <InputLabel id="raw-retention-label">Keep raw sensor recordings</InputLabel>
        <Select
          labelId="raw-retention-label"
          label="Keep raw sensor recordings"
          value={ settings?.rawArchiveRetentionDays ?? 14 }
          disabled={ isUpdating || settings?.rawArchiveRetentionDays === undefined }
          onChange={ (event) => updateSettings({ rawArchiveRetentionDays: Number(event.target.value) }) }
        >
          { OPTIONS.map(({ days, label }) => <MenuItem key={ days } value={ days }>{ label }</MenuItem>) }
        </Select>
      </FormControl>
      <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>
        Sleep analysis reads these. About 0.4 GB a day. Oldest removed first if storage runs low.
      </Typography>
    </>
  );
}
