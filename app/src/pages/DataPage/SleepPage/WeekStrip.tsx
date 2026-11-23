/* eslint-disable react/no-multi-comp */
import { Box, Button, Typography } from '@mui/material';
import moment from 'moment-timezone';
import type { SleepRecord } from '@api/sleepSchema';
import { palette, radius, weight } from '@design/tokens';
import { formatSleepDuration, nightDuration, nightMarkHeight, recordForNight } from './sleepContext';
import type { MissingNightState } from './MissingNightCard';

type Props = {
  weekStart: moment.Moment;
  selectedDate?: string;
  timeZone: string;
  records: SleepRecord[];
  currentNightState?: MissingNightState;
  onSelectDay: (date: string) => void;
};

function NightButton({ day, selected, record, disabled, onSelect, missingState }: {
  day: moment.Moment; selected: boolean; record?: SleepRecord; disabled: boolean; onSelect: () => void;
  missingState?: MissingNightState;
}) {
  const result = record ? nightDuration(record.sleep_period_seconds) : undefined;
  const duration = result?.seconds;
  const description = disabled ? 'upcoming' : result ? `recorded, ${formatSleepDuration(result.seconds)} ${result.kind}` : 'no recording';
  const pending = missingState === 'pending' || missingState === 'analyzing';
  const statusText = missingState === 'failed' ? ', analysis failed' : pending ? ', analysis pending' : '';
  return (
    <Button
      aria-label={ `${day.format('dddd, MMMM D')}: ${description}${statusText}` }
      aria-pressed={ selected }
      disabled={ disabled }
      onClick={ onSelect }
      variant="text"
      sx={ {
        flex: 1, minWidth: 0, minHeight: 84, px: 0, py: '6px', flexDirection: 'column',
        border: '1px solid', borderColor: selected ? palette.accent : 'transparent',
        color: selected ? palette.text.primary : palette.text.secondary, fontWeight: weight.regular,
      } }>
      <Typography component="span" variant="caption" sx={ { lineHeight: 1.2 } }>{ day.format('ddd') }</Typography>
      <Typography component="span" sx={ { fontWeight: 'inherit', lineHeight: 1.2 } }>{ day.date() }</Typography>
      <Box component="span" aria-hidden sx={ { height: 40, display: 'flex', alignItems: 'flex-end', mt: 0.5 } }>
        { !disabled && <Box
          component="span"
          sx={ {
            height: duration === undefined ? 6 : nightMarkHeight(duration),
            width: 12, borderRadius: `${radius.mark}px`, border: `1px ${pending ? 'dashed' : 'solid'}`,
            borderColor: missingState === 'failed' ? palette.status.error : 'currentColor',
            bgcolor: duration === undefined || duration === 0 ? 'transparent' : palette.lamp,
          } }/> }
      </Box>
    </Button>
  );
}

export default function WeekStrip({ weekStart, selectedDate, timeZone, records, onSelectDay, currentNightState }: Props) {
  const today = moment.tz(timeZone).startOf('day');
  return (
    <Box
      role="group"
      aria-label="Nights in selected week"
      sx={ {
        display: 'flex', width: '100%', gap: 0,
        // At 320 px the days would be 41 px wide; borrow the page gutter to reach 44.
        '@media (max-width: 359.95px)': { width: 'calc(100% + 24px)', mx: -1.5 },
      } }>
      { Array.from({ length: 7 }, (_, index) => {
        const day = weekStart.clone().add(index, 'days');
        const date = day.format('YYYY-MM-DD');
        const record = recordForNight(records, date, timeZone);
        return <NightButton
          key={ date }
          day={ day }
          selected={ date === selectedDate }
          record={ record }
          missingState={ !record && day.isSame(today, 'day') ? currentNightState : undefined }
          disabled={ day.isAfter(today, 'day') }
          onSelect={ () => onSelectDay(date) }/>;
      }) }
    </Box>
  );
}
