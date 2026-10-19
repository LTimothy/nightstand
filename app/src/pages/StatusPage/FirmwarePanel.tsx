import { Alert, Paper, Stack, Typography } from '@mui/material';
import { useSettings } from '@api/settings';
import { useFirmware } from '@api/firmware';
import TapDiagnostics from './TapDiagnostics';
import FirmwareReadout from './FirmwareReadout';

export default function FirmwarePanel() {
  const { data: settings } = useSettings();
  const enabled = settings?.features?.firmwareTargetReadout === true || settings?.features?.firmwareHealth === true
    || settings?.features?.tapDiagnostics === true || settings?.features?.coolingWarning === true;
  const query = useFirmware(enabled);
  if (!enabled) return null;
  if (query.isError) return <Alert severity="info">Firmware telemetry unavailable</Alert>;
  if (!query.data) return null;
  // Older Pods send neither reading, so these two cards stay hidden there.
  const { target, health } = query.data.reported;
  return <Stack spacing={ 2 }>
    { settings?.features.coolingWarning && target && health && <Paper variant="outlined" sx={ { p: 2 } }>
      <Typography variant="h6">Cooling warning</Typography>
      { query.data.availability === 'Monitoring unavailable' ? <Typography>Monitoring unavailable</Typography>
        : (['left', 'right'] as const).map(side => <Alert severity={ query.data!.cooling[side].active ? 'warning' : 'info' } key={ side }>
          { side === 'left' ? 'Left' : 'Right' }: { query.data!.cooling[side].active ? query.data!.cooling[side].message
            : query.data!.cooling[side].state === 'unavailable' ? 'Waiting for fresh cooling data.'
              : query.data!.cooling[side].state === 'collecting' ? 'Collecting an hour of cooling history.' : 'No cooling warning.' }
        </Alert>) }
    </Paper> }
    { settings?.features.tapDiagnostics && <TapDiagnostics data={ query.data } /> }
    { settings?.features.firmwareTargetReadout && target && <FirmwareReadout data={ query.data } format={ settings.temperatureFormat } /> }
    { settings?.features.firmwareHealth && query.data.availability !== 'Monitoring unavailable' && <Paper variant="outlined" sx={ { p: 2 } }>
      <Typography variant="h6">Firmware health details</Typography>
      <Typography>{ query.data.sensorFresh ? 'Recent sensor readings received.' : 'No recent readings' }</Typography>
      { query.data.incidents.map(item => <Stack key={ `${item.code}-${item.side}` } sx={ { mt: 1 } }>
        <Typography>{ item.side ? `${item.side === 'left' ? 'Left' : 'Right'}: ` : '' }{ item.message } ({ item.count })</Typography>
        <Typography variant="body2" color="text.secondary">
          { item.freshness }, first { new Date(item.firstSeen * 1000).toLocaleString() },
          last { new Date(item.lastSeen * 1000).toLocaleString() }
          { item.recoveredAt ? `, pump running observed at ${new Date(item.recoveredAt * 1000).toLocaleString()}` : '' }
        </Typography>
        { Object.entries(item.details).length > 0 && <Typography variant="body2">
          { Object.entries(item.details).map(([key, value]) => `${key}: ${value}`).join(', ') }
        </Typography> }
      </Stack>) }
    </Paper> }
  </Stack>;
}
