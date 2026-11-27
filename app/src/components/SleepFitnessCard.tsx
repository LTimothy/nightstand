import SectionHeading from '@components/SectionHeading';
import moment from 'moment-timezone';
import { Box, Typography } from '@mui/material';
import type { SleepRecord } from '@api/sleepSchema';
import { useSettings } from '@api/settings';
import GlassCard from '@design/GlassCard';
import { typography } from '@design/tokens';
import { formatSleepDuration } from '../pages/DataPage/SleepPage/sleepContext';

type Props = { sleepRecord: SleepRecord; timeZone?: string; title?: string; timeZoneLabel?: string };

export default function SleepFitnessCard({ sleepRecord, timeZone, title, timeZoneLabel }: Props) {
  const { data: settings } = useSettings();
  const zone = timeZone ?? settings?.timeZone ?? 'UTC';

  return (
    <GlassCard aria-label="Night summary">
      { title && <SectionHeading sx={ { mb: 1.5 } }>{ title }</SectionHeading> }
      { timeZoneLabel && <Typography variant="body2" color="text.secondary" sx={ { mb: 1 } }>{ timeZoneLabel }</Typography> }
      <Typography sx={ typography.metricValue }>
        { formatSleepDuration(sleepRecord.sleep_period_seconds) }
      </Typography>
      <Typography variant="body2" color="text.secondary">In bed</Typography>
      <Typography variant="body2" color="text.secondary" sx={ { mt: 0.5 } }>
        <Box component="span">{ moment.tz(sleepRecord.entered_bed_at, zone).format('h:mm A') }</Box>
        { ' to ' }
        <Box component="span">{ moment.tz(sleepRecord.left_bed_at, zone).format('h:mm A') }</Box>
      </Typography>
      <Box sx={ { display: 'flex', justifyContent: 'space-between', gap: 1, mt: 2 } }>
        <Typography variant="body2">Trips out of bed</Typography>
        <Typography variant="body2" color="text.secondary">{ sleepRecord.times_exited_bed }</Typography>
      </Box>
    </GlassCard>
  );
}
