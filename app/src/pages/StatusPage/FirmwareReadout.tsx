import { Paper, Stack, Typography } from '@mui/material';
import SectionHeading from '@components/SectionHeading';
import type { FirmwareSnapshot } from '@api/firmware';
import { unitOf, type TemperatureFormat } from '@lib/temperatureConversions';

export default function FirmwareReadout({ data, format }: { data: FirmwareSnapshot; format: TemperatureFormat }) {
  const celsius = unitOf(format) === 'celsius';
  const degrees = (valueC: number) => `${(celsius ? valueC : valueC * 9 / 5 + 32).toFixed(1)}°${celsius ? 'C' : 'F'}`;
  return <Paper variant="outlined" sx={ { p: 2 } }>
    <Stack spacing={ 1 }>
      <SectionHeading sx={ { pb: 0.5 } }>Firmware target</SectionHeading>
      { data.availability === 'Monitoring unavailable' && <Typography>Monitoring unavailable</Typography> }
      { (['left', 'right'] as const).map(side => {
        const sample = data.targets[side];
        const finite = Number.isFinite(sample.targetC);
        const target = finite ? `${(celsius ? sample.targetC! : sample.targetC! * 9 / 5 + 32).toFixed(1)}°${
          celsius ? 'C' : 'F'}` : 'Unavailable';
        const value = sample.state === 'disabled' ? 'Off' : sample.state === 'unavailable' ? 'Unavailable'
          : `${target}${sample.state === 'stale' ? ' (stale)' : ''}`;
        return <Typography key={ side }>{ side === 'left' ? 'Left' : 'Right' } firmware target: { value }</Typography>;
      }) }
      { (['left', 'right'] as const).map(side => {
        const reading = data.water?.[side];
        const value = !reading || reading.state === 'unavailable' || !Number.isFinite(reading.waterC) ? 'Unavailable'
          : `${degrees(reading.waterC!)}${reading.state === 'stale' ? ' (stale)' : ''}`;
        return <Typography key={ `water-${side}` }>{ side === 'left' ? 'Left' : 'Right' } water now: { value }</Typography>;
      }) }
    </Stack>
  </Paper>;
}

