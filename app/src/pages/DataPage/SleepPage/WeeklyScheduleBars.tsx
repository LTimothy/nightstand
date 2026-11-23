import moment from 'moment-timezone';
import { Box, ButtonBase, Typography } from '@mui/material';
import type { SleepRecord } from '@api/sleepSchema';
import { palette, radius } from '@design/tokens';
import { recordForNight } from './sleepContext';

type Props = { records: SleepRecord[]; weekStart: moment.Moment; timeZone: string; onSelectDay?: (date: string) => void };

export default function WeeklyScheduleBars({ records, weekStart, timeZone, onSelectDay }: Props) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = weekStart.clone().add(index, 'days');
    const record = recordForNight(records, day.format('YYYY-MM-DD'), timeZone);
    const anchor = day.clone().subtract(1, 'day').hour(12);
    return {
      day, record,
      start: record ? moment(record.entered_bed_at).diff(anchor, 'minutes') : 0,
      end: record ? moment(record.left_bed_at).diff(anchor, 'minutes') : 0,
    };
  });
  const minimum = Math.min(0, ...days.filter(day => day.record).map(day => day.start));
  const maximum = Math.max(1440, ...days.map(day => day.end));
  return (
    <Box aria-label="Time in bed by night">
      { days.map(({ day, record, start, end }) => {
        const future = day.isAfter(moment.tz(timeZone), 'day');
        const times = record
          ? `${moment.tz(record.entered_bed_at, timeZone).format('h:mm A')} to ${moment.tz(record.left_bed_at, timeZone).format('h:mm A')}`
          : future ? 'Upcoming' : 'No recording';
        return (
          <ButtonBase
            key={ day.format('YYYY-MM-DD') }
            disabled={ future || !onSelectDay }
            onClick={ () => onSelectDay?.(day.format('YYYY-MM-DD')) }
            sx={ {
              width: '100%', display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', alignItems: 'start', gap: 1,
              textAlign: 'left', py: 1, minHeight: 44, borderTop: `1px solid ${palette.border.subtle}`,
              '&.Mui-focusVisible': { outline: `2px solid ${palette.accent}` },
            } }>
            <Typography variant="body2" sx={ { whiteSpace: 'nowrap' } }>{ day.format('ddd D') }</Typography>
            <Box sx={ { width: '100%', minWidth: 0 } }>
              <Typography variant="body2" color="text.secondary">{ times }</Typography>
              { record && <Box
                aria-hidden
                sx={ {
                  mt: 0.5, height: 8, borderRadius: `${radius.mark}px`, bgcolor: palette.lamp,
                  ml: `${(start - minimum) / (maximum - minimum) * 100}%`,
                  width: `${(end - start) / (maximum - minimum) * 100}%`,
                } }/> }
            </Box>
          </ButtonBase>
        );
      }) }
    </Box>
  );
}
