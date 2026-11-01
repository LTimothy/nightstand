import { useCallback, useId, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Typography } from '@mui/material';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import type { NightLog, Rhythm, RhythmSuggestion, SuggestionRow } from '@api/rhythmsSchema';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { weight } from '@design/tokens';
import { NightRow, useNightExclude } from './NotesSheet';
import OverlayChart from './OverlayChart';
import SmartCurveChart from './SmartCurveChart';
import { suggestionStart, withRows } from './rhythmsModel';
import { INACTIVE, SCROLL_SHEET } from './sheetStyles';
import { suggestionOverlay, unusualDates } from './suggestionOverlay';
import {
  addLabel, dontSuggestLabel, evidenceSentence, holdsLine, NIGHTS_HEADING, provenance, questionHeading, sheetHeading, sheetOverline,
  showNightsLabel, startsLine, THOSE_NIGHTS, typicalLine, uncheckedNote, UNUSUAL, votesSentence, WITH_CHANGE_HEADING, withChangeRows,
} from './suggestionsCopy';

type Props = {
  entry: RhythmSuggestion;
  rhythm: Rhythm;
  side: 'left' | 'right';
  counted: number;
  log: NightLog[];
  sleeps: ResolvedSleepResponse[];
  today: string;
  timeZone: string;
  format: TemperatureFormat;
  trackingOn: boolean;
  error: string;
  busy: boolean;
  pausedUntil?: Date | null;
  onAdd: (rows: SuggestionRow[]) => void;
  onDontSuggest: (rows: SuggestionRow[]) => void;
  onShowNights: () => void;
  onClose: () => void;
};

// Keyed on its rows, so a refetch that changes them starts the checks over instead of leaving them on the wrong rows.
export const sheetKey = ({ rhythmId, rows }: RhythmSuggestion) =>
  `${rhythmId}|${rows.map(row => `${row.key}@${row.kind === 'step' ? row.time : ''}`).join(',')}`;

const subheading = { fontSize: 16, fontWeight: weight.heading, mt: 3 } as const;

// One sheet per rhythm, for a card or a near miss. Add writes only the checked rows, in one save.
export default function SuggestionSheet(props: Props) {
  const { entry, rhythm, side, counted, log, sleeps, today, timeZone, format, trackingOn, error, busy, pausedUntil } = props;
  const titleId = useId();
  const [checked, setChecked] = useState(() => entry.rows.map(() => true));
  // Starts on the heading, never on Add, so an Enter carried over from Review cannot add anything. A ref, since the
  // dialog's portal mounts its content after this component's effects run.
  const heading = useCallback((node: HTMLHeadingElement | null) => node?.focus(), []);
  const rows = entry.rows.filter((_, index) => checked[index]);
  const none = rows.length === 0;
  const after = withRows(rhythm, rows);
  const start = suggestionStart(sleeps, rhythm, rows, new Date(), today, timeZone, pausedUntil);
  const unchecked = entry.rows.length - rows.length;
  const smart = entry.rows.some(row => row.kind === 'base');
  const step = entry.rows.length === 1 && entry.rows[0].kind === 'step' ? entry.rows[0] : null;
  // The votes sentence under the chart replaces the evidence sentence above it.
  const voted = step?.votes?.length ? step : null;
  const exclude = useNightExclude(side);
  // Supporting nights only, the far-off ones first so they are the first to check.
  const unusual = rows.flatMap(row => (row.kind === 'base' ? [] : unusualDates(row.votes ?? [])));
  const thoseNights = smart ? [] : [...new Set(rows.flatMap(row => row.supportingDates))]
    .flatMap(date => log.filter(night => night.date === date && night.rhythmId === entry.rhythmId))
    .sort((a, b) => Number(unusual.includes(b.date)) - Number(unusual.includes(a.date)) || a.date.localeCompare(b.date));
  const listId = useId();
  const guard = (run: () => void, blocked = false) => () => {
    if (!busy && !blocked) run();
  };
  const toggle = (index: number) => guard(() => setChecked(current => current.map((value, at) => (at === index ? !value : value))));
  return <Dialog
    open
    onClose={ props.onClose }
    aria-labelledby={ titleId }
    fullWidth
    maxWidth="sm"
    scroll="paper"
    disableAutoFocus
    sx={ SCROLL_SHEET }>
    <DialogTitle component="div" id={ `${titleId}-frame` }>
      <Typography variant="caption" color="text.secondary" component="p">{ sheetOverline(rhythm.name, side) }</Typography>
      <Typography
        id={ titleId }
        ref={ heading }
        component="h2"
        tabIndex={ -1 }
        sx={ { fontSize: 18, fontWeight: weight.heading, outline: 'none' } }>
        { step ? questionHeading(step, format) : sheetHeading(entry.rows) }
      </Typography>
      { step && <Typography variant="body2" color="text.secondary">{ holdsLine(step, format) }</Typography> }
    </DialogTitle>
    <DialogContent dividers>
      { entry.rows.length === 1 ? !voted && <Typography variant="body2">{ evidenceSentence(entry.rows[0], counted, format) }</Typography> : <>
        { entry.rows.map((row, index) => <FormControlLabel
          key={ `${row.key}-${index}` }
          sx={ { display: 'flex', alignItems: 'flex-start', minHeight: 44, mr: 0 } }
          control={ <Checkbox
            checked={ checked[index] }
            onChange={ toggle(index) }
            slotProps={ { input: { 'aria-disabled': busy } } }
            sx={ INACTIVE }/> }
          label={ <Typography variant="body2" sx={ { pt: 1.1 } }>{ evidenceSentence(row, counted, format) }</Typography> }/>) }
        { unchecked > 0 && <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>{ uncheckedNote(unchecked) }</Typography> }
      </> }
      <Typography component="h3" sx={ subheading }>{ NIGHTS_HEADING }</Typography>
      { smart ? <SmartCurveChart
        night={ rhythm.night }
        wake={ rhythm.wake }
        smart={ after.smart }
        before={ rhythm.smart }
        date={ start.kind === 'date' ? start.date : today }
        timeZone={ timeZone }
        format={ format }
        trackingOn={ trackingOn }/> : <Box
        role="figure"
        aria-label={ voted ? votesSentence(voted, counted, rhythm.night.power.on, format)
          : rows.map(row => evidenceSentence(row, counted, format)).join(' ') }>
        <Box aria-hidden>
          <OverlayChart { ...suggestionOverlay(rhythm, rows, format) } on={ rhythm.night.power.on } format={ format }/>
        </Box>
      </Box> }
      { voted && <Typography variant="body2" sx={ { mt: 1 } }>
        { votesSentence(voted, counted, rhythm.night.power.on, format) }
      </Typography> }
      { thoseNights.length > 0 && <>
        <Typography component="h3" id={ listId } sx={ subheading }>{ THOSE_NIGHTS }</Typography>
        <Box component="ul" aria-labelledby={ listId } sx={ { listStyle: 'none', p: 0, m: 0, mt: 0.5 } }>
          { thoseNights.map(night => <NightRow
            key={ night.date }
            night={ night }
            excluded={ exclude.excludedOf(night) }
            format={ format }
            timeZone={ timeZone }
            note={ unusual.includes(night.date) ? UNUSUAL : undefined }
            onToggle={ () => void exclude.toggle(night) }/>) }
        </Box>
      </> }
      <Button onClick={ props.onShowNights } sx={ { minHeight: 44, px: 0 } }>{ showNightsLabel(counted) }</Button>
      <Typography component="h3" sx={ subheading }>{ WITH_CHANGE_HEADING }</Typography>
      <Box component="ul" sx={ { listStyle: 'none', p: 0, m: 0, mt: 0.5 } }>
        { withChangeRows(rhythm, after, format).map((line, index) => <Typography key={ index } component="li" variant="body2">
          { line }
        </Typography>) }
      </Box>
      <Typography variant="body2" color="text.secondary" sx={ { mt: 2 } }>
        { step ? typicalLine(step, format) : provenance(rhythm.name) }
      </Typography>
      <Typography variant="body2" sx={ { mt: 1 } }>{ startsLine(start, rhythm.name) }</Typography>
    </DialogContent>
    { (error || exclude.error) && <Alert severity="error" sx={ { mx: 2, mt: 1 } }>{ error || exclude.error }</Alert> }
    <DialogActions sx={ { flexWrap: 'wrap', gap: 1, px: 2, '& > :not(style) ~ :not(style)': { ml: 0 } } }>
      <Button
        variant="contained"
        aria-disabled={ busy || none }
        onClick={ guard(() => props.onAdd(rows), none) }
        sx={ { minHeight: 44, flexBasis: { xs: '100%', sm: 'auto' }, ...INACTIVE } }>
        { addLabel(rhythm.name, rows.length, entry.rows.length) }
      </Button>
      <Button aria-disabled={ busy || none } onClick={ guard(() => props.onDontSuggest(rows), none) } sx={ { minHeight: 44, ...INACTIVE } }>
        { dontSuggestLabel(rows.length, entry.rows.length) }
      </Button>
      <Button onClick={ props.onClose } sx={ { minHeight: 44 } }>Close</Button>
    </DialogActions>
  </Dialog>;
}
