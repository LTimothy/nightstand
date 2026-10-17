import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import moment from 'moment-timezone';
import { isAxiosError } from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, Stack, Typography } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import PageHeader from '@components/PageHeader';
import SectionHeading from '@components/SectionHeading';
import SideControl from '@components/SideControl';
import {
  postRhythms, postSuggestionDismiss, postSuggestionRestore, refreshRhythms, rhythmsSaveMessage, useResolvedSleeps, useSuggestions,
} from '@api/rhythms';
import type { DayOfWeek } from '@api/schedulesSchema';
import type { RhythmsDB, SideRhythms, SuggestionRow } from '@api/rhythmsSchema';
import { isSchedulePaused, pauseEndsAt } from '@api/schedulePause';
import { useServices } from '@api/services';
import { useSettings } from '@api/settings';
import { useAppStore } from '@state/appStore';
import PageContainer from '../../PageContainer';
import OneOffAlarmSection from '../OneOffAlarmSection';
import SchedulePauseNotice from '../../ControlTempPage/SchedulePauseNotice';
import ComingUp from './ComingUp';
import DateChanges from './DateChanges';
import NotesSheet from './NotesSheet';
import RhythmEditor from './RhythmEditor';
import RhythmList from './RhythmList';
import SuggestionCard from './SuggestionCard';
import SuggestionSheet from './SuggestionSheet';
import SuggestionsSection from './SuggestionsSection';
import UndoBar from './UndoBar';
import UseRhythmSheet from './UseRhythmSheet';
import WeekList from './WeekList';
import { HIDE_ERROR, undoAddMessage, undoHideMessage } from './suggestionsCopy';
import {
  applySuggestion, comingUpDates, datePickMessage, datesPickMessage, deleteMessage, deleteRhythm, firstComingUpDate, hasOwn,
  MAX_RHYTHMS_PER_SIDE, restoreDate, restoreDeleted, restoreRhythm, restoreWeekDays, restoreDates, setDateChange, setDateChanges,
  setWeekDays, weekPickMessage, type DateChoice,
} from './rhythmsModel';

const SHORT_COMING_UP = 7;
const LONG_COMING_UP = 14;

// `refused` explains an undo that would change nothing, such as a deleted rhythm whose place was taken.
// `restore` undoes a hide, which changes no rhythm.
type Undo = { message: string; focus: () => HTMLElement | null } & (
  | { revert: (current: SideRhythms) => SideRhythms; refused?: (current: SideRhythms) => string }
  | { restore: () => Promise<boolean> }
);

export default function RhythmsPage({ db }: { db: RhythmsDB }) {
  const { side, isUpdating, setIsUpdating } = useAppStore();
  const { data: settings } = useSettings();
  const { data: services } = useServices();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id: string | null }>();
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Undo>();
  const [showAllDates, setShowAllDates] = useState(false);
  const [using, setUsing] = useState<string>();
  const [notes, setNotes] = useState<{ rhythmId?: string }>();
  const [review, setReview] = useState<string>();
  const [headingFocus, setHeadingFocus] = useState(0);
  const closedEditor = useRef<{ id: string | null; created: boolean } | undefined>(undefined);
  const location = useLocation();
  const navigate = useNavigate();
  // Arriving from turning Rhythms on: start keyboard users at the week.
  useEffect(() => {
    if ((location.state as { focus?: string } | null)?.focus !== 'week-heading') return;
    document.getElementById('week-heading')?.focus({ preventScroll: true });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  useEffect(() => {
    closedEditor.current = undefined;
    setEditing(undefined);
    setError('');
    setUndo(undefined);
    setNotes(undefined);
    setReview(undefined);
  }, [side]);
  // The editor unmounts on close, so focus would fall to the page body. Return
  // it to the rhythm, or to "Use on some days" for one just created, unless the
  // user already moved on. A new rhythm's card appears once the refetch lands.
  useEffect(() => {
    const closed = closedEditor.current;
    if (editing || !closed || (closed.id && !db[side].rhythms[closed.id])) return;
    closedEditor.current = undefined;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next = closed.created ? document.querySelector<HTMLElement>(`[data-use-rhythm="${closed.id}"]`) : null;
    const card = closed.id ? next ?? document.querySelector<HTMLElement>(`[data-rhythm-id="${closed.id}"]`) : null;
    (card ?? document.getElementById('rhythms-heading'))?.focus({ preventScroll: true });
  }, [editing, db, side]);
  // Runs after the commit that shows the list, so the heading exists whatever the browser's frame timing.
  useEffect(() => {
    if (headingFocus) document.getElementById('rhythms-heading')?.focus({ preventScroll: true });
  }, [headingFocus]);
  const timeZone = settings?.timeZone ?? moment.tz.guess();
  const format = settings?.temperatureFormat ?? 'fahrenheit';
  const today = moment.tz(timeZone).format('YYYY-MM-DD');
  const from = moment.tz(today, timeZone).subtract(1, 'day');
  const { data: resolved = [] } = useResolvedSleeps(side, from.toISOString(), from.clone().add(15, 'days').toISOString());
  // For a side that is away the server sends the present side's sleeps; this side shows only its own.
  const sleeps = resolved.filter(sleep => sleep.side === side);
  const sideData = db[side];
  const dates = comingUpDates(firstComingUpDate(sleeps, new Date(), today), showAllDates ? LONG_COMING_UP : SHORT_COMING_UP);
  const sideLabel = settings?.[side]?.name || (side === 'left' ? 'Left side' : 'Right side');
  const paused = !!settings && isSchedulePaused(settings, side, new Date());
  const pausedUntil = !settings || !paused ? undefined : pauseEndsAt(settings, side);
  const suggestionsOn = !!settings?.features?.rhythmSuggestions;
  const suggestions = useSuggestions(side, suggestionsOn);
  const away = !!settings?.[side]?.awayMode;
  const cards = suggestionsOn && suggestions.data?.enabled
    ? suggestions.data.suggestions.filter(entry => !entry.near && hasOwn(sideData.rhythms, entry.rhythmId)) : [];
  const reviewEntry = review ? suggestions.data?.suggestions.find(entry => entry.rhythmId === review) : undefined;
  const reviewRhythm = reviewEntry && hasOwn(sideData.rhythms, reviewEntry.rhythmId) ? sideData.rhythms[reviewEntry.rhythmId] : undefined;

  const save = async (next: SideRhythms) => {
    setError('');
    setIsUpdating(true);
    try {
      await postRhythms({ [side]: next });
      await refreshRhythms(queryClient);
      return true;
    } catch (caught) {
      setError(rhythmsSaveMessage(caught, today));
      // A timed-out save may have landed, and a 409 means Rhythms changed elsewhere; show what the Pod has.
      if (isAxiosError(caught) && (!caught.response || caught.response.status === 409)) void refreshRhythms(queryClient);
      return false;
    } finally {
      setIsUpdating(false);
    }
  };

  // The line or date that was picked may be regrouped by the save; keep keyboard focus nearby.
  const refocus = (target: () => HTMLElement | null) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    target()?.focus({ preventScroll: true });
  });
  const weekLine = (day: DayOfWeek) => () => document.querySelector<HTMLElement>(`[data-week-days~="${day}"]`)
    ?? document.getElementById('week-heading');
  const dateLine = (date: string) => () => document.querySelector<HTMLElement>(`[data-coming-up="${date}"]`)
    ?? document.querySelector<HTMLElement>(`[data-date-change="${date}"] button`) ?? document.getElementById('coming-up-heading');

  const pickWeek = async (days: DayOfWeek[], id: string | null) => {
    if (!days.length || days.every(day => sideData.week[day] === id)) return;
    const before = sideData;
    setUndo(undefined);
    if (await save(setWeekDays(sideData, days, id))) {
      setUndo({
        message: weekPickMessage(sideData, days, id), revert: current => restoreWeekDays(current, before, days), focus: weekLine(days[0]),
      });
    }
    refocus(weekLine(days[0]));
  };
  const pickDate = async (date: string, choice: DateChoice) => {
    const next = setDateChange(sideData, date, choice);
    if (JSON.stringify(next.changes) === JSON.stringify(sideData.changes)) return;
    const before = sideData;
    setUndo(undefined);
    if (await save(next)) {
      setUndo({
        message: datePickMessage(sideData, date, choice, today),
        revert: current => restoreDate(current, before, date),
        focus: dateLine(date),
      });
    }
    refocus(dateLine(date));
  };
  const pickDates = async (dates: string[], choice: DateChoice) => {
    const next = setDateChanges(sideData, dates, choice);
    if (JSON.stringify(next.changes) === JSON.stringify(sideData.changes)) return;
    const before = sideData;
    setUndo(undefined);
    if (await save(next)) {
      setUndo({
        message: datesPickMessage(sideData, dates, choice, today),
        revert: current => restoreDates(current, before, dates),
        focus: () => document.getElementById('coming-up-heading'),
      });
    }
    refocus(() => document.getElementById('coming-up-heading'));
  };
  // Deleting has the same undo as a pick; focus goes to the Rhythms heading, since the card is gone.
  const removeRhythm = async (id: string, replacement: string | null) => {
    const before = sideData;
    setUndo(undefined);
    if (!await save(deleteRhythm(sideData, id, replacement, today))) return false;
    const focusCard = () => document.querySelector<HTMLElement>(`[data-rhythm-id="${id}"]`);
    const name = sideData.rhythms[id]?.name ?? '';
    setUndo({
      message: deleteMessage(sideData, id, replacement, today),
      revert: current => restoreDeleted(current, before, id),
      focus: focusCard,
      refused: current => (Object.keys(current.rhythms).length >= MAX_RHYTHMS_PER_SIDE
        ? `Could not restore ${name}. This side already has ${MAX_RHYTHMS_PER_SIDE} rhythms.`
        : `Could not restore ${name}, because another rhythm took its place.`),
    });
    closedEditor.current = undefined;
    setEditing(undefined);
    setError('');
    setHeadingFocus(count => count + 1);
    return true;
  };
  const reviewButton = (rhythmId: string) => () => document.querySelector<HTMLElement>(`[data-review="${rhythmId}"]`)
    ?? document.getElementById('suggestions-heading');
  const toSuggestions = () => requestAnimationFrame(() => document.getElementById('suggestions-heading')?.focus({ preventScroll: true }));
  const openReview = (rhythmId: string) => {
    setUndo(undefined);
    setError('');
    setReview(rhythmId);
  };
  // One save for every checked row; a refusal stays in the sheet, which stays open.
  const addSuggestion = async (rhythmId: string, rows: SuggestionRow[]) => {
    const before = sideData;
    const name = sideData.rhythms[rhythmId]?.name ?? '';
    setUndo(undefined);
    if (!await save(applySuggestion(sideData, rhythmId, rows))) return;
    setReview(undefined);
    setUndo({
      message: undoAddMessage(name, rows, format), revert: current => restoreRhythm(current, before, rhythmId), focus: reviewButton(rhythmId),
    });
    toSuggestions();
  };
  const hideSuggestion = async (rhythmId: string, rows: SuggestionRow[]) => {
    const name = sideData.rhythms[rhythmId]?.name ?? '';
    setError('');
    setUndo(undefined);
    setIsUpdating(true);
    try {
      const ids = await postSuggestionDismiss({
        scope: 'plan', side, rhythmId, rows: rows.map(row => ({ key: row.key, time: row.kind === 'step' ? row.time : null })),
      });
      await queryClient.invalidateQueries({ queryKey: ['useSuggestions'] });
      setReview(undefined);
      setUndo({
        message: undoHideMessage(name),
        focus: reviewButton(rhythmId),
        restore: async () => {
          setError('');
          try {
            await postSuggestionRestore({ side, ids });
            await queryClient.invalidateQueries({ queryKey: ['useSuggestions'] });
            return true;
          } catch {
            setError(HIDE_ERROR);
            return false;
          }
        },
      });
      toSuggestions();
    } catch {
      setError(HIDE_ERROR);
    } finally {
      setIsUpdating(false);
    }
  };
  const undoPick = async () => {
    if (!undo) return;
    if ('restore' in undo) {
      setIsUpdating(true);
      const restored = await undo.restore();
      setIsUpdating(false);
      // The bar stays until the restore lands, so a failed one can be tried again.
      if (restored) setUndo(undefined);
      requestAnimationFrame(() => undo.focus()?.focus({ preventScroll: true }));
      return;
    }
    const { revert, focus, refused } = undo;
    const next = revert(sideData);
    if (next === sideData && refused) {
      setUndo(undefined);
      setError(refused(sideData));
      setHeadingFocus(count => count + 1);
      return;
    }
    // The bar stays until the save lands, so a failed undo can be tried again.
    if (await save(next)) setUndo(undefined);
    focus()?.focus({ preventScroll: true });
  };

  return <PageContainer>
    <PageHeader title="Schedule"/>
    { editing ? <RhythmEditor
      key={ `${side}-${editing.id ?? 'new'}` }
      sideData={ sideData }
      rhythmId={ editing.id }
      sideLabel={ sideLabel }
      format={ format }
      timeZone={ timeZone }
      today={ today }
      trackingOn={ !!services?.biometrics?.enabled }
      saveError={ error }
      onSave={ save }
      onDelete={ removeRhythm }
      onClose={ savedId => {
        closedEditor.current = { id: savedId ?? editing.id, created: !editing.id && !!savedId };
        setEditing(undefined);
        setError('');
      } }/> : <>
      <SideControl/>
      <SchedulePauseNotice
        framed
        note="Changes you save apply after the pause."
        onResumed={ () => requestAnimationFrame(() => document.getElementById('week-heading')?.focus({ preventScroll: true })) }/>
      { error && !reviewEntry && <Alert severity="error" sx={ { width: '100%' } } onClose={ () => setError('') }>{ error }</Alert> }
      { cards.map(entry => <SuggestionCard
        key={ entry.rhythmId }
        name={ sideData.rhythms[entry.rhythmId].name }
        entry={ entry }
        counted={ suggestions.data?.nights[entry.rhythmId]?.counted ?? 0 }
        format={ format }
        onReview={ () => openReview(entry.rhythmId) }/>) }
      <Stack component="section" aria-labelledby="week-heading" spacing={ 1.5 } sx={ { width: '100%' } }>
        <SectionHeading id="week-heading" tabIndex={ -1 } sx={ { outline: 'none' } }>Week</SectionHeading>
        <WeekList
          sideData={ sideData }
          disabled={ isUpdating }
          onSheetOpen={ () => setUndo(undefined) }
          onPick={ (days, id) => void pickWeek(days, id) }/>
      </Stack>
      <Stack component="section" aria-labelledby="coming-up-heading" spacing={ 1.5 } sx={ { width: '100%' } }>
        <SectionHeading id="coming-up-heading" tabIndex={ -1 } sx={ { outline: 'none' } }>Coming up</SectionHeading>
        <ComingUp
          sideData={ sideData }
          sleeps={ sleeps }
          dates={ dates }
          today={ today }
          timeZone={ timeZone }
          disabled={ isUpdating }
          pausedUntil={ pausedUntil }
          onSheetOpen={ () => setUndo(undefined) }
          onChoose={ (date, choice) => void pickDate(date, choice) }
          onChooseMany={ (picked, choice) => void pickDates(picked, choice) }
          more={ <Button
            onClick={ () => setShowAllDates(value => !value) }
            aria-expanded={ showAllDates }
            sx={ { alignSelf: 'flex-start', px: 0 } }>
            { showAllDates ? 'Show fewer dates' : `Show ${LONG_COMING_UP - SHORT_COMING_UP} more dates` }
          </Button> }/>
        <DateChanges
          sideData={ sideData }
          from={ dates[0] }
          today={ today }
          disabled={ isUpdating }
          onChoose={ (date, choice) => void pickDate(date, choice) }/>
      </Stack>
      <Stack component="section" aria-labelledby="rhythms-heading" spacing={ 1.5 } sx={ { width: '100%' } }>
        <SectionHeading id="rhythms-heading" tabIndex={ -1 } sx={ { outline: 'none' } }>Rhythms</SectionHeading>
        <RhythmList
          sideData={ sideData }
          today={ today }
          disabled={ isUpdating }
          chart={ suggestionsOn && suggestions.data?.enabled ? {
            log: suggestions.data.log, timeZone, format, trackingOn: !!services?.biometrics?.enabled,
          } : undefined }
          onOpen={ id => {
            setUndo(undefined);
            setError('');
            setEditing({ id });
          } }
          onUse={ id => {
            setUndo(undefined);
            setError('');
            setUsing(id);
          } }
          onNew={ () => {
            setUndo(undefined);
            setError('');
            setEditing({ id: null });
          } }/>
      </Stack>
      { suggestionsOn && <SuggestionsSection
        sideData={ sideData }
        suggestions={ suggestions }
        away={ away }
        onReview={ openReview }
        onShowNotes={ () => {
          setUndo(undefined);
          setNotes({});
        } }/> }
      { reviewEntry && reviewRhythm && suggestions.data && <SuggestionSheet
        key={ reviewEntry.rhythmId }
        entry={ reviewEntry }
        rhythm={ reviewRhythm }
        side={ side }
        counted={ suggestions.data.nights[reviewEntry.rhythmId]?.counted ?? 0 }
        log={ suggestions.data.log.filter(night => night.rhythmId === reviewEntry.rhythmId) }
        sleeps={ sleeps }
        today={ today }
        timeZone={ timeZone }
        format={ format }
        trackingOn={ !!services?.biometrics?.enabled }
        pausedUntil={ pausedUntil }
        error={ error }
        busy={ isUpdating }
        onAdd={ rows => void addSuggestion(reviewEntry.rhythmId, rows) }
        onDontSuggest={ rows => void hideSuggestion(reviewEntry.rhythmId, rows) }
        onShowNights={ () => setNotes({ rhythmId: reviewEntry.rhythmId }) }
        onClose={ () => {
          setReview(undefined);
          setError('');
        } }/> }
      { notes && suggestions.data && <NotesSheet
        side={ side }
        rhythms={ Object.values(sideData.rhythms) }
        forRhythm={ notes.rhythmId }
        data={ suggestions.data }
        away={ away }
        format={ format }
        timeZone={ timeZone }
        onClose={ () => setNotes(undefined) }/> }
      { using && sideData.rhythms[using] && <UseRhythmSheet
        name={ sideData.rhythms[using].name }
        onClose={ () => setUsing(undefined) }
        onUse={ days => {
          setUsing(undefined);
          void pickWeek(days, using);
        } }/> }
      { settings?.features?.oneOffAlarms && <Accordion sx={ { width: '100%' } } slotProps={ { transition: { unmountOnExit: true } } }>
        <AccordionSummary expandIcon={ <ExpandMore/> }>
          <Typography component="h2" variant="inherit">Add one-time alarm</Typography>
        </AccordionSummary>
        <AccordionDetails><OneOffAlarmSection/></AccordionDetails>
      </Accordion> }
      { undo && <UndoBar
        message={ undo.message }
        disabled={ isUpdating }
        onUndo={ () => void undoPick() }
        onClose={ () => setUndo(undefined) }/> }
    </> }
  </PageContainer>;
}
