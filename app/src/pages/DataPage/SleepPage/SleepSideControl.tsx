import moment from 'moment-timezone';
import SideControl from '@components/SideControl';
import { useSleepRecords } from '@api/sleep';
import type { SleepRecord } from '@api/sleepSchema';
import { useAppStore } from '@state/appStore.tsx';
import { formatSleepDuration, nightDuration, recordForNight, withoutFutureRecords } from './sleepContext';

function nightCaption(record: SleepRecord | undefined) {
  if (!record) return 'No recording';
  const duration = nightDuration(record.sleep_period_seconds);
  return `${formatSleepDuration(duration.seconds)} ${duration.kind}`;
}

export default function SleepSideControl({ selectedDate, timeZone, displayedRecord }: {
  selectedDate: string; timeZone: string; displayedRecord?: SleepRecord;
}) {
  // The shown night is the selected tab's; after a side swap its record may carry the other physical side.
  const { side: selected } = useAppStore();
  const shown = (side: 'left' | 'right') => (displayedRecord && selected === side ? displayedRecord : undefined);
  const start = moment.tz(selectedDate, timeZone).startOf('day');
  const range = { startTime: start.toISOString(), endTime: start.clone().add(1, 'day').toISOString() };
  const left = useSleepRecords({ side: 'left', ...range });
  const right = useSleepRecords({ side: 'right', ...range });
  const nightFor = (records: SleepRecord[] | undefined) =>
    recordForNight(withoutFutureRecords(records ?? [], moment().valueOf()), selectedDate, timeZone);
  const leftCaption = nightCaption(shown('left') ?? nightFor(left.data));
  const rightCaption = nightCaption(shown('right') ?? nightFor(right.data));
  return <SideControl
    mergeAwaySides={ false }
    captions={ {
      left: shown('left') ? leftCaption
        : left.isError ? 'Recording unavailable' : left.isPending ? 'Loading recording' : leftCaption,
      right: shown('right') ? rightCaption
        : right.isError ? 'Recording unavailable' : right.isPending ? 'Loading recording' : rightCaption,
    } }/>;
}
