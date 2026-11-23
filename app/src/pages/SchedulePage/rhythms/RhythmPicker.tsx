import { useId } from 'react';
import {
  Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText, ToggleButton, ToggleButtonGroup,
  Typography,
} from '@mui/material';
import Check from '@mui/icons-material/Check';
import type { DayOfWeek } from '@api/schedulesSchema';
import { palette, radius } from '@design/tokens';
import { describeDays } from '@api/rhythmDays';
import { choiceKey, dayName, type DateChoice, type PickerOption } from './rhythmsModel';
import { BOTTOM_SHEET } from '@design/sheetStyles';

// Lets a grouped week line change some of its days, not only all of them.
export type DayChoice = { days: DayOfWeek[]; chosen: DayOfWeek[]; onChange: (chosen: DayOfWeek[]) => void };

type Props = {
  title: string;
  subtitle?: string;
  options: PickerOption[];
  selected?: DateChoice;
  dayChoice?: DayChoice;
  onPick: (choice: DateChoice) => void;
  onClose: () => void;
};

export default function RhythmPicker({ title, subtitle, options, selected, dayChoice, onPick, onClose }: Props) {
  const titleId = useId();
  const daysId = useId();
  const listId = useId();
  const noDays = !!dayChoice && dayChoice.chosen.length === 0;
  return <Dialog
    open
    onClose={ onClose }
    aria-labelledby={ titleId }
    fullWidth
    maxWidth="sm"
    sx={ BOTTOM_SHEET }>
    <DialogTitle id={ titleId }>{ title }</DialogTitle>
    <DialogContent sx={ { px: 1, pb: 0 } }>
      { subtitle && <Typography variant="body2" color="text.secondary" sx={ { px: 2, mb: 1 } }>{ subtitle }</Typography> }
      { dayChoice && <>
        <Typography id={ daysId } variant="body2" sx={ { px: 2, mb: 1 } }>Days to change</Typography>
        <ToggleButtonGroup
          aria-labelledby={ daysId }
          color="primary"
          value={ dayChoice.chosen }
          onChange={ (_event, next: DayOfWeek[]) => dayChoice.onChange(dayChoice.days.filter(day => next.includes(day))) }
          sx={ { px: 2, mb: 1.5, flexWrap: 'wrap', gap: 0.5,
            '& .MuiToggleButtonGroup-grouped': { border: 1, borderColor: 'divider', borderRadius: `${radius.base}px !important`, m: 0 },
            '& .MuiToggleButtonGroup-grouped.Mui-selected, & .MuiToggleButtonGroup-grouped.Mui-selected:hover': {
              bgcolor: palette.accent, borderColor: palette.accent, color: palette.bg.base } } }>
          { dayChoice.days.map(day => <ToggleButton
            key={ day }
            value={ day }
            aria-label={ dayName(day) }
            sx={ { minWidth: 44, minHeight: 44, px: 1 } }>
            { dayName(day).slice(0, 3) }
          </ToggleButton>) }
        </ToggleButtonGroup>
        { noDays && <Typography variant="body2" color="text.secondary" role="status" sx={ { px: 2, mb: 1 } }>
          Choose at least one day.
        </Typography> }
      </> }
      { dayChoice && !noDays && <Typography id={ listId } variant="body2" sx={ { px: 2, mb: 0.5 } }>
        Use for { describeDays(dayChoice.chosen) }
      </Typography> }
      <List disablePadding aria-labelledby={ dayChoice && !noDays ? listId : undefined }>
        { options.map(option => {
          const active = !!selected && choiceKey(option.choice) === choiceKey(selected);
          return <ListItemButton
            key={ choiceKey(option.choice) }
            selected={ active }
            disabled={ noDays }
            aria-current={ active ? 'true' : undefined }
            onClick={ () => onPick(option.choice) }
            sx={ { borderRadius: `${radius.base}px`, gap: 1, minHeight: 44 } }>
            <ListItemText primary={ option.label } secondary={ option.detail }/>
            { active && <Check aria-hidden sx={ { color: palette.accent } }/> }
          </ListItemButton>;
        }) }
      </List>
    </DialogContent>
    <DialogActions>
      <Button onClick={ onClose }>Cancel</Button>
    </DialogActions>
  </Dialog>;
}
