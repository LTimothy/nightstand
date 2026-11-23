import { useState } from 'react';
import { Box, List, ListItemButton, ListItemText } from '@mui/material';
import type { DayOfWeek } from '@api/schedulesSchema';
import type { SideRhythms } from '@api/rhythmsSchema';
import { palette, radius, weight } from '@design/tokens';
import RhythmPicker from './RhythmPicker';
import { describeDays, rhythmName, rhythmOptions, weekRuns, type DateChoice } from './rhythmsModel';
import { INACTIVE } from '@design/sheetStyles';

type Props = {
  sideData: SideRhythms;
  disabled: boolean;
  onPick: (days: DayOfWeek[], rhythmId: string | null) => void;
  onSheetOpen?: () => void;
};

// One line per run of days that share a rhythm, so names never truncate.
export default function WeekList({ sideData, disabled, onPick, onSheetOpen }: Props) {
  const [open, setOpen] = useState<{ days: DayOfWeek[]; chosen: DayOfWeek[] }>();
  const runs = weekRuns(sideData);
  const selected = (days: DayOfWeek[]): DateChoice | undefined => {
    const ids = new Set(days.map(day => {
      const id = sideData.week[day];
      return id && sideData.rhythms[id] ? id : null;
    }));
    if (ids.size !== 1) return undefined;
    const [id] = [...ids];
    return id ? { kind: 'rhythm', id } : { kind: 'none' };
  };
  return <>
    <Box
      sx={ { width: '100%', border: `1px solid ${palette.border.subtle}`, borderRadius: `${radius.base}px`,
        bgcolor: palette.bg.elevated, overflow: 'hidden' } }>
      <List disablePadding>
        { runs.map((run, index) => {
          const label = describeDays(run.days);
          const name = rhythmName(sideData, run.id);
          // aria-disabled, not disabled, while a save runs: the closing picker hands focus back here, and a
          // disabled button would drop it to the page body.
          return <ListItemButton
            key={ run.days.join('-') }
            divider={ index < runs.length - 1 }
            data-week-days={ run.days.join(' ') }
            aria-disabled={ disabled || undefined }
            aria-label={ `${label}: ${name}` }
            onClick={ () => {
              if (disabled) return;
              onSheetOpen?.();
              setOpen({ days: run.days, chosen: run.days });
            } }
            sx={ { gap: 2, minHeight: 48, ...INACTIVE } }>
            <ListItemText
              primary={ label }
              sx={ { flex: '0 0 auto', my: 0 } }
              slotProps={ { primary: { sx: { fontWeight: weight.medium, whiteSpace: 'nowrap' } } } }/>
            <ListItemText
              primary={ <bdi>{ name }</bdi> }
              sx={ { textAlign: 'right', my: 0, minWidth: 0 } }
              slotProps={ { primary: { sx: { color: run.id ? 'text.primary' : 'text.secondary', overflowWrap: 'anywhere' } } } }/>
          </ListItemButton>;
        }) }
      </List>
    </Box>
    { open && <RhythmPicker
      title={ describeDays(open.chosen.length ? open.chosen : open.days) }
      subtitle={ open.days.length === 1 ? `For sleeps that start on a ${describeDays(open.days)}` : 'For sleeps that start on these days' }
      options={ rhythmOptions(sideData) }
      selected={ selected(open.chosen) }
      dayChoice={ open.days.length > 1 ? { days: open.days, chosen: open.chosen, onChange: chosen => setOpen({ ...open, chosen }) } : undefined }
      onClose={ () => setOpen(undefined) }
      onPick={ choice => {
        onPick(open.chosen, choice.kind === 'rhythm' ? choice.id : null);
        setOpen(undefined);
      } }/> }
  </>;
}
