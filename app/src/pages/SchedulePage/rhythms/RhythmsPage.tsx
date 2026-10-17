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
import { postRhythms, refreshRhythms, rhythmsSaveMessage, useResolvedSleeps, useSuggestions } from '@api/rhythms';
import type { DayOfWeek } from '@api/schedulesSchema';
import type { RhythmsDB, SideRhythms } from '@api/rhythmsSchema';
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
import SuggestionsSection from './SuggestionsSection';
import UndoBar from './UndoBar';
import UseRhythmSheet from './UseRhythmSheet';
import WeekList from './WeekList';
import {
  comingUpDates, datePickMessage, datesPickMessage, deleteMessage, deleteRhythm, firstComingUpDate, MAX_RHYTHMS_PER_SIDE, restoreDate,
  restoreDeleted, restoreWeekDays, restoreDates, setDateChange, setDateChanges, setWeekDays, weekPickMessage, type DateChoice,
} from './rhythmsModel';

const SHORT_COMING_UP = 7;
const LONG_COMING_UP = 14;

// `refused` explains an undo that would change nothing, such as a deleted rhythm whose place was taken.
type Undo = {
  message: string;
  revert: (current: SideRhythms) => SideRhythms;
  focus: () => HTMLElement | null;
  refused?: (current: SideRhythms) => string;
};

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
  const undoPick = async () => {
    if (!undo) return;
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
      { error && <Alert severity="error" sx={ { width: '100%' } } onClose={ () => setError('') }>{ error }</Alert> }
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
        onShowNotes={ () => {
          setUndo(undefined);
          setNotes({});
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
