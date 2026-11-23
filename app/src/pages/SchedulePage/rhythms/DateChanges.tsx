import { useId, useState } from 'react';
import { Box, Button, List, ListItem, ListItemText } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import type { SideRhythms } from '@api/rhythmsSchema';
import { palette, radius } from '@design/tokens';
import { dayLabel, rhythmName, upcomingChanges, weekLabel, type DateChoice } from './rhythmsModel';
import { INACTIVE } from './sheetStyles';

type Props = {
  sideData: SideRhythms;
  from: string;
  today: string;
  disabled: boolean;
  onChoose: (date: string, choice: DateChoice) => void;
};

// Every change from today on, so one made weeks ahead can still be found and taken back.
export default function DateChanges({ sideData, from, today, disabled, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const changes = upcomingChanges(sideData, from);
  if (!changes.length) return null;
  return <>
    <Button
      aria-expanded={ open }
      aria-controls={ listId }
      endIcon={ <ExpandMore sx={ { transform: open ? 'rotate(180deg)' : undefined } }/> }
      onClick={ () => setOpen(value => !value) }
      sx={ { alignSelf: 'flex-start', px: 0, minHeight: 44 } }>
      Date changes ({ changes.length })
    </Button>
    { open && <Box
      id={ listId }
      sx={ { width: '100%', border: `1px solid ${palette.border.subtle}`, borderRadius: `${radius.base}px`, bgcolor: palette.bg.elevated,
        overflow: 'hidden' } }>
      <List disablePadding>
        { changes.map((change, index) => {
          const label = dayLabel(change.date, today);
          return <ListItem
            key={ change.date }
            divider={ index < changes.length - 1 }
            data-date-change={ change.date }
            sx={ { gap: 1, flexWrap: 'wrap' } }>
            <ListItemText
              primary={ label }
              secondary={ rhythmName(sideData, change.rhythmId) }
              sx={ { minWidth: 0 } }
              slotProps={ { secondary: { sx: { overflowWrap: 'anywhere' } } } }/>
            <Button
              aria-label={ `${label}: back to ${weekLabel(sideData, change.date)}` }
              aria-disabled={ disabled || undefined }
              onClick={ () => { if (!disabled) onChoose(change.date, { kind: 'weekly' }); } }
              sx={ { minHeight: 44, flexShrink: 0, mr: -1, ...INACTIVE } }>
              Back to Week
            </Button>
          </ListItem>;
        }) }
      </List>
    </Box> }
  </>;
}
