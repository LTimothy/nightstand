import { useId, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { DayOfWeek } from '@api/schedulesSchema';
import { describeDays, WEEK_DAYS } from '@api/rhythmDays';
import { palette, radius } from '@design/tokens';
import { dayName } from './rhythmsModel';
import { BOTTOM_SHEET } from './sheetStyles';

type Props = { name: string; onUse: (days: DayOfWeek[]) => void; onClose: () => void };

// The next step for a rhythm nobody uses yet: pick the weekdays it runs on.
export default function UseRhythmSheet({ name, onUse, onClose }: Props) {
  const titleId = useId();
  const [days, setDays] = useState<DayOfWeek[]>([]);
  return <Dialog
    open
    onClose={ onClose }
    aria-labelledby={ titleId }
    fullWidth
    maxWidth="sm"
    sx={ BOTTOM_SHEET }>
    <DialogTitle id={ titleId }>Use <bdi>{ name }</bdi> on</DialogTitle>
    <DialogContent>
      <ToggleButtonGroup
        aria-labelledby={ titleId }
        value={ days }
        onChange={ (_event, next: DayOfWeek[]) => setDays(WEEK_DAYS.filter(day => next.includes(day))) }
        sx={ { flexWrap: 'wrap', gap: 0.5,
          '& .MuiToggleButtonGroup-grouped': { border: 1, borderColor: 'divider', borderRadius: `${radius.base}px !important`, m: 0 },
          '& .MuiToggleButtonGroup-grouped.Mui-selected, & .MuiToggleButtonGroup-grouped.Mui-selected:hover': {
            bgcolor: palette.accent, borderColor: palette.accent, color: palette.bg.base } } }>
        { WEEK_DAYS.map(day => <ToggleButton
          key={ day }
          value={ day }
          aria-label={ dayName(day) }
          sx={ { minWidth: 44, minHeight: 44, px: 1 } }>
          { dayName(day).slice(0, 3) }
        </ToggleButton>) }
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary" sx={ { mt: 1.5 } }>
        Those days stop using their current rhythm. You can undo this.
      </Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={ onClose }>Cancel</Button>
      <Button variant="contained" disabled={ !days.length } onClick={ () => onUse(days) }>
        { days.length ? `Use on ${describeDays(days)}` : 'Choose days' }
      </Button>
    </DialogActions>
  </Dialog>;
}
