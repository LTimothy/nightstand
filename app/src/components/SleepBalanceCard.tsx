import moment from 'moment-timezone';
import { Box, Typography } from '@mui/material';
import type { SleepRecord } from '@api/sleepSchema';
import GlassCard from '@design/GlassCard';
import { typography } from '@design/tokens';
import {
  formatSleepDuration, nightDuration, recordForNight, summarizeDurations,
} from '../pages/DataPage/SleepPage/sleepContext';
import WeeklyScheduleBars from '../pages/DataPage/SleepPage/WeeklyScheduleBars';

type Props = { records: SleepRecord[]; weekStart: moment.Moment; timeZone: string; onSelectDay?: (date: string) => void };

export default function SleepBalanceCard({ records, weekStart, timeZone, onSelectDay }: Props) {
  const recorded = Array.from({ length: 7 }, (_, index) => recordForNight(
    records, weekStart.clone().add(index, 'days').format('YYYY-MM-DD'), timeZone,
  )).filter((record): record is SleepRecord => !!record);
  const summary = summarizeDurations(recorded.map(record => nightDuration(record.sleep_period_seconds)));
  return (
    <GlassCard label="Weekly time in bed">
      <Typography>{ recorded.length } of 7 nights recorded</Typography>
      { summary && (
        <Box sx={ { my: 1 } }>
          <Typography sx={ typography.metricValue }>
            { formatSleepDuration(summary.average) } average on recorded nights
          </Typography>
        </Box>
      ) }
      <WeeklyScheduleBars records={ recorded } weekStart={ weekStart } timeZone={ timeZone } onSelectDay={ onSelectDay }/>
    </GlassCard>
  );
}
