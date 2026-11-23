import { useState, type ReactNode } from 'react';
import moment from 'moment-timezone';
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText, Stack, TextField,
} from '@mui/material';
import type { SideRhythms } from '@api/rhythmsSchema';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import { palette, radius } from '@design/tokens';
import { BOTTOM_SHEET, INACTIVE } from '@design/sheetStyles';
import MultiDateSheet from './MultiDateSheet';
import RhythmPicker from './RhythmPicker';
import {
  changeFor, dayLabel, effectiveRhythmId, formatDate, MAX_CHANGE_DAYS_AHEAD, NO_SLEEP, rhythmOptions, rhythmTimes,
  sleepDetail, weekLabel, type DateChoice, type PickerOption,
} from './rhythmsModel';

type Props = {
  sideData: SideRhythms;
  sleeps: ResolvedSleepResponse[];
  dates: string[];
  today: string;
  timeZone: string;
  disabled: boolean;
  onChoose: (date: string, choice: DateChoice) => void;
  onChooseMany: (dates: string[], choice: DateChoice) => void;
  onSheetOpen?: () => void;
  // Set while this side is paused: when the pause ends, or null until it is resumed.
  pausedUntil?: Date | null;
  more?: ReactNode;
};

export default function ComingUp({
  sideData, sleeps, dates, today, timeZone, disabled, onChoose, onChooseMany, onSheetOpen, pausedUntil, more,
}: Props) {
  const [pickerDate, setPickerDate] = useState<string>();
  const [severalOpen, setSeveralOpen] = useState(false);
  const [several, setSeveral] = useState<string[]>();
  const [askDate, setAskDate] = useState(false);
  const [laterDate, setLaterDate] = useState('');
  const maxDate = moment(today, 'YYYY-MM-DD').add(MAX_CHANGE_DAYS_AHEAD, 'days').format('YYYY-MM-DD');
  const laterValid = /^\d{4}-\d{2}-\d{2}$/.test(laterDate) && laterDate >= today && laterDate <= maxDate;
  const laterError = !!laterDate && !laterValid;
  const range = `Pick a date from today to ${formatDate(maxDate)}`;
  const now = Date.now();
  // A sleep still running from yesterday can change too; its picker says it is the one in progress.
  const runningDate = sleeps.find(sleep => Date.parse(sleep.start) <= now && now < Date.parse(sleep.end))?.date;
  const closeLater = () => {
    setAskDate(false);
    setLaterDate('');
  };
  const openPicker = (date: string) => {
    onSheetOpen?.();
    setPickerDate(date);
  };
  const describe = (date: string) => {
    const id = effectiveRhythmId(sideData, date);
    const rhythm = id ? sideData.rhythms[id] : undefined;
    if (!rhythm) return NO_SLEEP;
    const sleep = sleeps.find(item => item.date === date);
    return `${rhythm.name} · ${sleep ? sleepDetail(sleep, timeZone) : rhythmTimes(rhythm.night)}`;
  };
  const options = (date: string): PickerOption[] => [
    ...rhythmOptions(sideData),
    ...(changeFor(sideData, date)
      ? [{ choice: { kind: 'weekly' as const }, label: `Back to ${weekLabel(sideData, date)}` }]
      : []),
  ];
  const selected = (date: string): DateChoice => {
    const id = effectiveRhythmId(sideData, date);
    return id && sideData.rhythms[id] ? { kind: 'rhythm', id } : { kind: 'none' };
  };
  return <>
    <Box
      sx={ { width: '100%', border: `1px solid ${palette.border.subtle}`, borderRadius: `${radius.base}px`,
        bgcolor: palette.bg.elevated, overflow: 'hidden' } }>
      <List disablePadding>
        { dates.map(date => {
          const changed = !!changeFor(sideData, date);
          const label = dayLabel(date, today);
          const text = describe(date);
          const sleep = sleeps.find(item => item.date === date);
          const running = !!sleep && Date.parse(sleep.start) <= now && now < Date.parse(sleep.end);
          // A sleep that starts before the pause ends is marked paused.
          const paused = !!sleep && pausedUntil !== undefined && (pausedUntil === null || Date.parse(sleep.start) < pausedUntil.getTime());
          const marks = [running && 'now', paused && 'paused', changed && 'changed'].filter(Boolean).join(', ');
          // Focusable while a save runs, like the Week lines, so focus comes back here after a pick.
          return <ListItemButton
            key={ date }
            divider
            data-coming-up={ date }
            aria-disabled={ disabled || undefined }
            aria-label={ `${label}: ${text}${marks ? `, ${marks}` : ''}` }
            onClick={ () => { if (!disabled) openPicker(date); } }
            sx={ { gap: 1, ...INACTIVE } }>
            <ListItemText
              primary={ label }
              secondary={ text }
              slotProps={ { secondary: { sx: { overflowWrap: 'anywhere' } } } }/>
            <Box sx={ { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.5, flexShrink: 0 } }>
              { running && <Chip label="Now" size="small" sx={ { bgcolor: palette.lamp, color: palette.bg.base } }/> }
              { paused && <Chip label="Paused" size="small" variant="outlined"/> }
              { changed && <Chip label="Changed" size="small" variant="outlined"/> }
            </Box>
          </ListItemButton>;
        }) }
      </List>
    </Box>
    <Stack sx={ { alignItems: 'flex-start' } }>
      { more }
      <Button
        onClick={ () => {
          if (disabled) return;
          onSheetOpen?.();
          setAskDate(true);
        } }
        aria-disabled={ disabled || undefined }
        sx={ { px: 0, ...INACTIVE } }>Change a later date</Button>
      <Button
        onClick={ () => {
          if (disabled) return;
          onSheetOpen?.();
          setSeveralOpen(true);
        } }
        aria-disabled={ disabled || undefined }
        sx={ { px: 0, ...INACTIVE } }>Change several dates</Button>
    </Stack>
    { severalOpen && <MultiDateSheet
      sideData={ sideData }
      today={ today }
      onClose={ () => setSeveralOpen(false) }
      onNext={ picked => {
        setSeveralOpen(false);
        setSeveral(picked);
      } }/> }
    { several && <RhythmPicker
      title={ `${several.length} ${several.length === 1 ? 'date' : 'dates'}` }
      subtitle="For the sleeps that start on these dates"
      options={ [
        ...rhythmOptions(sideData),
        ...(several.some(date => changeFor(sideData, date)) ? [{ choice: { kind: 'weekly' as const }, label: 'Back to Week' }] : []),
      ] }
      onClose={ () => setSeveral(undefined) }
      onPick={ choice => {
        onChooseMany(several, choice);
        setSeveral(undefined);
      } }/> }
    <Dialog
      open={ askDate }
      onClose={ closeLater }
      aria-labelledby="later-date-title"
      fullWidth
      maxWidth="sm"
      sx={ BOTTOM_SHEET }>
      <DialogTitle id="later-date-title">Pick a date</DialogTitle>
      <DialogContent>
        <TextField
          type="date"
          label="Date"
          value={ laterDate }
          error={ laterError }
          helperText={ laterError ? range : `Up to ${MAX_CHANGE_DAYS_AHEAD} days ahead` }
          sx={ { mt: 1 } }
          slotProps={ { inputLabel: { shrink: true }, htmlInput: { min: today, max: maxDate } } }
          onChange={ event => setLaterDate(event.target.value) }/>
      </DialogContent>
      <DialogActions>
        <Button onClick={ closeLater }>Cancel</Button>
        <Button
          variant="contained"
          disabled={ !laterValid }
          onClick={ () => {
            closeLater();
            setPickerDate(laterDate);
          } }>Choose a rhythm</Button>
      </DialogActions>
    </Dialog>
    { pickerDate && <RhythmPicker
      title={ dayLabel(pickerDate, today) }
      subtitle={ pickerDate === runningDate ? 'For the sleep in progress now' : 'For the sleep that starts on this date' }
      options={ options(pickerDate) }
      selected={ selected(pickerDate) }
      onClose={ () => setPickerDate(undefined) }
      onPick={ choice => {
        onChoose(pickerDate, choice);
        setPickerDate(undefined);
      } }/> }
  </>;
}
