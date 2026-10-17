/* eslint-disable react/no-multi-comp */
// A night's row is private to the notes sheet.
import { useCallback, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, ToggleButton, Typography } from '@mui/material';
import Check from '@mui/icons-material/Check';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { postNightExclude, postSuggestionRestore } from '@api/rhythms';
import type { Dismissed, NightLog, Rhythm, SuggestionsResponse } from '@api/rhythmsSchema';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { palette, weight } from '@design/tokens';
import { SCROLL_SHEET } from './sheetStyles';
import {
  AWAY_LINE, EXCLUDE_ERROR, HIDDEN_HEADING, hiddenIntro, hiddenRow, HOW_THIS_WORKS, HOW_TITLE, howSuggestionsWork, LEAVE_OUT, LEAVE_OUT_HINT,
  leaveOutName, nightLabel, noteLines, notesCountLine, notesTitle, SHOW_AGAIN, SHOW_AGAIN_ERROR, showAgainName, WHAT_COUNTS_TITLE, whatCounts,
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

// The date and the toggle share one 44 px line, so the changes below get the full width at 320 px.
function NightRow({ night, excluded, format, timeZone, onToggle }: RowProps) {
  const lines = noteLines(night, format, timeZone);
  if (night.tonight) {
    return <Box component="li" sx={ { py: 0.5 } }>
      { lines.map((line, index) => <Typography key={ index } variant="body2" sx={ { pl: index ? 1.5 : 0, overflowWrap: 'anywhere' } }>
        { line }
      </Typography>) }
    </Box>;
  }
  return <Box component="li" sx={ { py: 0.5, color: excluded ? palette.text.secondary : palette.text.primary } }>
    <Box sx={ { display: 'flex', alignItems: 'center', gap: 1 } }>
      <Typography variant="body2" sx={ { flex: 1, minWidth: 0, color: 'inherit' } }>{ nightLabel(night, excluded) }</Typography>
      <ToggleButton
        value="leave-out"
        selected={ excluded }
        aria-label={ leaveOutName(night) }
        onChange={ onToggle }
        size="small"
        sx={ {
          minHeight: 44, minWidth: 44, gap: 0.5, flexShrink: 0,
          '&.Mui-selected, &.Mui-selected:hover': { bgcolor: palette.accent, borderColor: palette.accent, color: palette.bg.base },
        } }>
        { excluded && <Check aria-hidden sx={ { fontSize: 16 } }/> }
        { LEAVE_OUT }
      </ToggleButton>
    </Box>
    { lines.map((line, index) => <Typography key={ index } variant="body2" sx={ { pl: 1.5, color: 'inherit', overflowWrap: 'anywhere' } }>
      { line }
    </Typography>) }
  </Box>;
}

export default function NotesSheet({ side, rhythms, forRhythm, data, away, format, timeZone, onClose }: Props) {
  const focusHeading = useCallback((node: HTMLHeadingElement | null) => node?.focus(), []);
  const titleId = useId();
  const rulesId = useId();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);
  const shown = forRhythm ? rhythms.filter(rhythm => rhythm.id === forRhythm) : rhythms;
  // Said once per sheet, under the first list that has a Leave out toggle.
  const hintFor = shown.find(rhythm => data.log.some(night => night.rhythmId === rhythm.id && !night.tonight))?.id;
  const hidden = (rhythmId: string) => data.dismissed.filter(entry => entry.rhythmId === rhythmId);
  const smart = shown.some(rhythm => rhythm.temperatureMode === 'smart');
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
  const showAgain = async (entry: Dismissed) => {
    setError('');
    try {
      await postSuggestionRestore({ side, ids: [entry.id] });
      await queryClient.invalidateQueries({ queryKey: ['useSuggestions'] });
    } catch {
      setError(SHOW_AGAIN_ERROR);
    }
  };
  return <Dialog
    open
    onClose={ onClose }
    disableAutoFocus
    aria-labelledby={ titleId }
    fullWidth
    maxWidth="sm"
    scroll="paper"
    sx={ SCROLL_SHEET }>
    <DialogTitle id={ titleId } ref={ focusHeading } tabIndex={ -1 } sx={ { outline: 'none' } }>
      { notesTitle(forRhythm ? shown[0]?.name : undefined) }
    </DialogTitle>
    <DialogContent dividers>
      { away && <Typography variant="body2" sx={ { mb: 2 } }>{ AWAY_LINE }</Typography> }
      { shown.map(rhythm => <Box component="section" key={ rhythm.id } sx={ { mb: 3 } }>
        { !forRhythm && <Typography component="h3" sx={ subheading }><bdi>{ rhythm.name }</bdi></Typography> }
        <Typography variant="body2" color="text.secondary" sx={ { mt: 0.5 } }>
          { notesCountLine(rhythm.name, data.nights[rhythm.id]?.counted ?? 0, data.nights[rhythm.id]?.earlier ?? false) }
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
        { rhythm.id === hintFor && <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>{ LEAVE_OUT_HINT }</Typography> }
        { hidden(rhythm.id).length > 0 && <>
          <Typography component={ forRhythm ? 'h3' : 'h4' } sx={ { ...subheading, fontSize: 14, mt: 2 } }>{ HIDDEN_HEADING }</Typography>
          { hidden(rhythm.id).some(entry => entry.scope === 'plan') && <Typography
            variant="body2"
            color="text.secondary"
            sx={ { mt: 0.5 } }>
            { hiddenIntro(rhythm.name) }
          </Typography> }
          <Stack component="ul" sx={ { listStyle: 'none', p: 0, m: 0 } }>
            { hidden(rhythm.id).map(entry => <Box component="li" key={ entry.id } sx={ { display: 'flex', alignItems: 'center', gap: 1 } }>
              <Typography variant="body2" sx={ { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }>{ hiddenRow(entry) }</Typography>
              <Button aria-label={ showAgainName(entry) } onClick={ () => void showAgain(entry) } sx={ { minHeight: 44, flexShrink: 0 } }>
                { SHOW_AGAIN }
              </Button>
            </Box>) }
          </Stack>
        </> }
      </Box>) }
      <Button
        aria-expanded={ rulesOpen }
        aria-controls={ rulesId }
        endIcon={ <ExpandMore sx={ { transform: rulesOpen ? 'rotate(180deg)' : undefined } }/> }
        onClick={ () => setRulesOpen(value => !value) }
        sx={ { px: 0, minHeight: 44 } }>
        { HOW_THIS_WORKS }
      </Button>
      { rulesOpen && <Box id={ rulesId }>
        <Typography component="h3" sx={ { ...subheading, mt: 1 } }>{ HOW_TITLE }</Typography>
        <Typography variant="body2" sx={ { mt: 0.5, mb: 2 } }>{ howSuggestionsWork() }</Typography>
        <Typography component="h3" sx={ subheading }>{ WHAT_COUNTS_TITLE }</Typography>
        <Typography variant="body2" sx={ { mt: 0.5 } }>{ whatCounts(smart) }</Typography>
      </Box> }
    </DialogContent>
    { error && <Alert severity="error" sx={ { mx: 2, mt: 1 } }>{ error }</Alert> }
    <DialogActions>
      <Button onClick={ onClose } sx={ { minHeight: 44 } }>Close</Button>
    </DialogActions>
  </Dialog>;
}
