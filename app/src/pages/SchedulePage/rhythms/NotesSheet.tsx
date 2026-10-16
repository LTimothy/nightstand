/* eslint-disable react/no-multi-comp */
// A night's row is private to the notes sheet.
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, ToggleButton, Typography } from '@mui/material';
import Check from '@mui/icons-material/Check';
import { postNightExclude } from '@api/rhythms';
import type { NightLog, Rhythm, SuggestionsResponse } from '@api/rhythmsSchema';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { palette, weight } from '@design/tokens';
import { SCROLL_SHEET } from './sheetStyles';
import {
  AWAY_LINE, EXCLUDE_ERROR, howSuggestionsWork, noteLines, notesCountLine, notesTitle, oneOffName, whatCounts,
} from './suggestionsCopy';

type Props = {
  side: 'left' | 'right';
  rhythms: Rhythm[];
  forRhythm?: string;
  data: SuggestionsResponse;
  away: boolean;
  format: TemperatureFormat;
  timeZone: string;
  onClose: () => void;
};

type RowProps = { night: NightLog; excluded: boolean; format: TemperatureFormat; timeZone: string; onToggle: () => void };

const nightKey = (night: NightLog) => `${night.rhythmId}|${night.date}`;
const subheading = { fontSize: 16, fontWeight: weight.heading } as const;

function NightRow({ night, excluded, format, timeZone, onToggle }: RowProps) {
  const lines = noteLines(night, format, timeZone);
  return <Box component="li" sx={ { display: 'flex', alignItems: 'center', gap: 1, py: 0.5 } }>
    <Box sx={ { flex: 1, minWidth: 0, color: excluded ? palette.text.secondary : palette.text.primary } }>
      { lines.map((line, index) => <Typography key={ index } variant="body2" sx={ { color: 'inherit', overflowWrap: 'anywhere' } }>
        { line }{ excluded && index === lines.length - 1 ? ' (not counted)' : '' }
      </Typography>) }
    </Box>
    { !night.tonight && <ToggleButton
      value="one-off"
      selected={ excluded }
      aria-label={ oneOffName(night) }
      onChange={ onToggle }
      size="small"
      sx={ {
        minHeight: 44, minWidth: 44, gap: 0.5, flexShrink: 0,
        '&.Mui-selected, &.Mui-selected:hover': { bgcolor: palette.accent, borderColor: palette.accent, color: palette.bg.base },
      } }>
      { excluded && <Check aria-hidden sx={ { fontSize: 16 } }/> }
      One-off
    </ToggleButton> }
  </Box>;
}

export default function NotesSheet({ side, rhythms, forRhythm, data, away, format, timeZone, onClose }: Props) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const shown = forRhythm ? rhythms.filter(rhythm => rhythm.id === forRhythm) : rhythms;
  const toggle = async (night: NightLog) => {
    const key = nightKey(night);
    const excluded = !(pending[key] ?? night.excluded);
    setError('');
    setPending(current => ({ ...current, [key]: excluded }));
    try {
      await postNightExclude({ side, rhythmId: night.rhythmId, date: night.date, excluded });
      await queryClient.invalidateQueries({ queryKey: ['useSuggestions'] });
    } catch {
      setPending(current => Object.fromEntries(Object.entries(current).filter(([other]) => other !== key)));
      setError(EXCLUDE_ERROR);
    }
  };
  return <Dialog open onClose={ onClose } aria-labelledby={ titleId } fullWidth maxWidth="sm" scroll="paper" sx={ SCROLL_SHEET }>
    <DialogTitle id={ titleId }>{ notesTitle(forRhythm ? shown[0]?.name : undefined) }</DialogTitle>
    <DialogContent dividers>
      { away && <Typography variant="body2" sx={ { mb: 2 } }>{ AWAY_LINE }</Typography> }
      { shown.map(rhythm => <Box component="section" key={ rhythm.id } sx={ { mb: 3 } }>
        { !forRhythm && <Typography component="h3" sx={ subheading }><bdi>{ rhythm.name }</bdi></Typography> }
        <Typography variant="body2" color="text.secondary" sx={ { mt: 0.5 } }>
          { notesCountLine(rhythm.name, data.nights[rhythm.id]?.counted ?? 0) }
        </Typography>
        <Stack component="ul" sx={ { listStyle: 'none', p: 0, m: 0, mt: 1 } }>
          { data.log.filter(night => night.rhythmId === rhythm.id).map(night => <NightRow
            key={ night.date }
            night={ night }
            excluded={ pending[nightKey(night)] ?? night.excluded }
            format={ format }
            timeZone={ timeZone }
            onToggle={ () => void toggle(night) }/>) }
        </Stack>
      </Box>) }
      <Typography component="h3" sx={ subheading }>How suggestions work</Typography>
      <Typography variant="body2" sx={ { mt: 0.5, mb: 2 } }>{ howSuggestionsWork() }</Typography>
      <Typography component="h3" sx={ subheading }>What counts</Typography>
      <Typography variant="body2" sx={ { mt: 0.5 } }>{ whatCounts() }</Typography>
    </DialogContent>
    { error && <Alert severity="error" sx={ { mx: 2, mt: 1 } }>{ error }</Alert> }
    <DialogActions>
      <Button onClick={ onClose } sx={ { minHeight: 44 } }>Close</Button>
    </DialogActions>
  </Dialog>;
}
