import SectionHeading from '@components/SectionHeading';
import _ from 'lodash';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Dialog, DialogTitle, DialogActions, Typography,
} from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { DeepPartial } from 'ts-essentials';
import moment from 'moment-timezone';

import OneOffAlarmSection from './OneOffAlarmSection.tsx';
import { pendingOneOffText } from './oneOffAlarm';
import ApplyToOtherDaysAccordion from './ApplyToOtherDaysAccordion.tsx';
import DayTabs from './DayTabs.tsx';
import DraftBar from './DraftBar.tsx';
import EnabledSwitch from './EnabledSwitch.tsx';
import PageContainer from '../PageContainer.tsx';
import SaveButton from './SaveButton.tsx';
import SideControl from '../../components/SideControl.tsx';
import ScheduleTimeline from './ScheduleTimeline';
import { DayOfWeek, Schedules } from '@api/schedulesSchema.ts';
import { postSchedules } from '@api/schedules';
import { useAppStore } from '@state/appStore.tsx';
import { useSchedules } from '@api/schedules';
import { useScheduleStore } from './scheduleStore.tsx';
import { useSettings } from '@api/settings';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { supportsRisePattern } from '@api/alarmPattern.ts';
import { isSchedulePaused } from '@api/schedulePause.ts';
import { LOWERCASE_DAYS } from './days.ts';
import TemperatureScheduleChart from './ScheduleChart.tsx';
import PageHeader from '@components/PageHeader';
import { validateSchedule } from './scheduleValidation';
import { discardTitle } from './discardTitle';
import { friendlyTimeZone } from '@lib/timeZone';
import ErrorBoundary from '@components/ErrorBoundary.tsx';
import SchedulePauseNotice from '../ControlTempPage/SchedulePauseNotice.tsx';
import useTemperatureFormat from '@lib/useTemperatureFormat';


const getAdjustedDayOfWeek = (timeZone?: string): DayOfWeek => {
  // Use the pod's configured timezone (where the schedule actually runs) rather
  // than the browser's, so the preselected day matches the pod for a user in a
  // different timezone. Falls back to local time until settings have loaded.
  const now = timeZone ? moment.tz(timeZone) : moment();
  // Extract the hour of the day in 24-hour format
  const currentHour = now.hour();

  // Determine if it's before noon (12:00 PM)
  if (currentHour < 12) {
    return now.subtract(1, 'day').format('dddd').toLocaleLowerCase() as DayOfWeek;
  } else {
    return now.format('dddd').toLocaleLowerCase() as DayOfWeek;
  }
};


// A notice can be a function, to ask before an action of its own drops the draft.
type Notice = ReactNode | ((confirmLeave: (leave: () => void) => void) => ReactNode);

export default function SchedulePage({ notice: noticeProp }: { notice?: Notice } = {}) {
  const { setIsUpdating, side, isUpdating } = useAppStore();
  const focusSaveAfterUpdate = useRef(false);
  const { data: schedules, refetch, isError: schedulesError } = useSchedules();
  const {
    selectedSchedule,
    setOriginalSchedules,
    selectedDays,
    selectedDay,
    reloadScheduleData,
    selectDay,
  } = useScheduleStore();
  const { data: settings, refetch: refetchSettings, isError: settingsError } = useSettings();
  const oneOffText = settings ? pendingOneOffText(settings, side, new Date()) : null;
  const { data: deviceStatus } = useDeviceStatus();
  const risePattern = supportsRisePattern(deviceStatus?.hubVersion, deviceStatus?.coverVersion);
  const format = useTemperatureFormat();
  const [saveError, setSaveError] = useState('');
  const [pendingChange, setPendingChange] = useState<{ day: number } | { side: 'left' | 'right' } | { leave: () => void }>();
  const changesPresent = useScheduleStore(state => state.changesPresent);
  const titleDay = selectedDay.charAt(0).toUpperCase() + selectedDay.slice(1);
  const nextDay = LOWERCASE_DAYS[(LOWERCASE_DAYS.indexOf(selectedDay) + 1) % 7];
  const sideLabel = settings?.[side]?.name || (side === 'left' ? 'Left side' : 'Right side');
  const affectedDays = _.uniq([selectedDay, ...Object.keys(selectedDays).filter(day => selectedDays[day as DayOfWeek])]);
  const { invalidTimes, schemaIssues } = validateSchedule(selectedSchedule, Math.min(...affectedDays.map(day =>
    useScheduleStore.getState().originalSchedules?.[side]?.[day as DayOfWeek]?.alarms?.length ?? 0)));
  const [showSchemaError, setShowSchemaError] = useState(false);
  const schemaIssue = schemaIssues[0];
  const schemaField = schemaIssue?.path.join('.') === 'power.onTemperature' ? 'Bedtime temperature'
    : schemaIssue?.path[0] === 'temperatures' ? `Temperature at ${schemaIssue.path[1]}`
      : schemaIssue?.path[0] === 'power' ? 'Bedtime and turn-off settings' : 'Alarm settings';
  const draftLabel = `Unsaved: ${sideLabel}, ${affectedDays.map(day => day.charAt(0).toUpperCase() + day.slice(1)).join(', ')}`;
  const shortDay = moment().day(LOWERCASE_DAYS.indexOf(selectedDay)).format('ddd');
  const discardTitleText = discardTitle({
    day: titleDay, otherDays: affectedDays.length - 1, sideChange: !!pendingChange && 'side' in pendingChange,
    side, sideName: settings?.[side]?.name,
  });
  const keepFocusVisible = (target: HTMLElement) => {
    if (target.closest('[data-schedule-draft]')) return;
    const bounds = target.getBoundingClientRect();
    if (bounds.bottom > window.innerHeight - 160 || bounds.top < 8) target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
  };
  useLayoutEffect(() => {
    if (!changesPresent) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = '160px';
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('#PageContainer')) keepFocusVisible(active);
    return () => { root.style.scrollPaddingBottom = previous; };
  }, [changesPresent, selectedSchedule]);
  const unusedSide = !changesPresent && !!schedules?.[side] && Object.values(schedules[side]).every(day =>
    !day.power.enabled && Object.keys(day.temperatures).length === 0
    && !(day.alarms.length ? day.alarms : [day.alarm]).some(alarm => alarm.enabled));
  const firstRun = !selectedSchedule || unusedSide;
  const startNight = () => {
    const store = useScheduleStore.getState();
    store.updateSelectedSchedule({ power: { enabled: true } });
    store.selectAlarm(0);
    store.updateSelectedAlarm({ enabled: true, vibrationIntensity: 100, vibrationPattern: 'double', duration: 30 });
  };

  const initializedSide = useRef<typeof side | undefined>(undefined);
  useEffect(() => {
    if (!schedules || !settings) return;
    const current = useScheduleStore.getState();
    if (initializedSide.current === side && current.changesPresent) return;
    const day = initializedSide.current !== undefined ? current.selectedDay : getAdjustedDayOfWeek(settings.timeZone);
    initializedSide.current = side;
    setOriginalSchedules(schedules);
    selectDay(LOWERCASE_DAYS.indexOf(day));
  }, [schedules, settings?.timeZone, side]);

  // The store survives navigation, so discard unsaved edits when leaving.
  useEffect(() => () => reloadScheduleData(), [reloadScheduleData]);

  const confirmDiscard = (change: { day: number } | { side: 'left' | 'right' }) => {
    if (!useScheduleStore.getState().changesPresent) return true;
    setPendingChange(change);
    return false;
  };
  const confirmLeave = (leave: () => void) => {
    if (useScheduleStore.getState().changesPresent) setPendingChange({ leave });
    else leave();
  };
  const notice = typeof noticeProp === 'function' ? noticeProp(confirmLeave) : noticeProp;
  const discardAndSwitch = () => {
    if (!pendingChange) return;
    if ('leave' in pendingChange) {
      setPendingChange(undefined);
      // Leaving can be refused, so the draft is dropped first.
      reloadScheduleData();
      pendingChange.leave();
      return;
    }
    reloadScheduleData();
    if ('day' in pendingChange) selectDay(pendingChange.day);
    else useAppStore.getState().setSide(pendingChange.side);
    setPendingChange(undefined);
  };

  const showInvalidRow = () => {
    if (schemaIssue) {
      setShowSchemaError(true);
      const control = document.querySelector<HTMLElement>(`[role="spinbutton"][aria-label="${schemaField}"]`);
      control?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      control?.focus({ preventScroll: true });
      return;
    }
    const row = document.querySelector<HTMLElement>('[data-invalid="true"]');
    row?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row?.querySelector<HTMLElement>('input[type="time"], [role="combobox"]')?.focus({ preventScroll: true });
  };

  // The draft bar unmounts and its buttons are disabled mid-save, so focus would fall to the page body.
  const focusIfLost = (target: () => HTMLElement | null) => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('[data-schedule-draft]')) return;
    target()?.focus({ preventScroll: true });
  };
  const nightHeading = () => document.getElementById('schedule-night-heading');
  // The notice and its focused Resume button unmount a render after the resume lands, so move focus once they are gone.
  const [focusAfterResume, setFocusAfterResume] = useState(false);
  const schedulePaused = !!settings && isSchedulePaused(settings, side, moment().toDate());
  useEffect(() => {
    if (!focusAfterResume || schedulePaused) return;
    setFocusAfterResume(false);
    focusIfLost(nightHeading);
  }, [focusAfterResume, schedulePaused]);
  useEffect(() => {
    if (isUpdating || !focusSaveAfterUpdate.current) return;
    focusSaveAfterUpdate.current = false;
    focusIfLost(() => document.querySelector<HTMLElement>('[data-schedule-save]'));
  }, [isUpdating]);

  const handleSave = async () => {
    if (!useScheduleStore.getState().isValid()) return;
    setSaveError('');
    setIsUpdating(true);

    const daysList: DayOfWeek[] = _.uniq(_.keys(_.pickBy(selectedDays, value => value))) as DayOfWeek[];
    daysList.push(selectedDay);
    const payload: DeepPartial<Schedules> = { [side]: {}, };
    daysList.forEach(day => {
      // @ts-expect-error
      payload[side][day] = selectedSchedule;
    });

    await postSchedules(payload)
      .then(() => {
        // Wait 1 second before refreshing the schedules
        return new Promise((resolve) => setTimeout(resolve, 1_000));
      })
      .then(() => refetch())
      .then(result => {
        if (result.data) {
          const current = useScheduleStore.getState();
          useScheduleStore.setState({ originalSchedules: result.data });
          // A save may finish after navigation or after another edit.
          if (useAppStore.getState().side === side && current.selectedDay === selectedDay
            && current.selectedSchedule === selectedSchedule && current.selectedDays === selectedDays) {
            reloadScheduleData();
            focusIfLost(nightHeading);
          }
        }
      })
      .catch(error => {
        console.error(error);
        setSaveError('Could not save the schedule. Your edits are still here. Try again.');
        focusSaveAfterUpdate.current = true;
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  // Editing requires schedules and the Pod timezone.
  if (!settings || !schedules) return <PageContainer>
    <PageHeader title="Schedule"/>
    { notice }
    { schedulesError || settingsError ? <Alert
      severity="error"
      action={ <Button
        onClick={ () => {
          void refetch();
          void refetchSettings();
        } }>Retry</Button> }>Could not load the schedule and Pod timezone.</Alert>
      : <CircularProgress aria-label="Loading schedule and Pod timezone"/> }
  </PageContainer>;

  return (
    <PageContainer
      containerProps={ { onFocusCapture: event => { if (changesPresent) keepFocusVisible(event.target as HTMLElement); } } }
      sx={ { mb: changesPresent ? 9 : 0,
        '& input, & button, & [tabindex]': { scrollMarginBottom: changesPresent ? '160px' : '88px', scrollMarginTop: '16px' } } }>
      <PageHeader title="Schedule"/>
      { notice }
      <SideControl beforeSideChange={ nextSide => confirmDiscard({ side: nextSide }) }/>
      <DayTabs beforeDayChange={ day => confirmDiscard({ day }) }/>
      <SchedulePauseNotice framed note="Changes you save apply after the pause." onResumed={ () => setFocusAfterResume(true) }/>
      <Box sx={ { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 } }>
        <Box sx={ { flex: 1, minWidth: 0 } }>
          <SectionHeading id="schedule-night-heading" tabIndex={ -1 } sx={ { outline: 'none' } }>
            { titleDay } night{ selectedSchedule && selectedSchedule.power.off < selectedSchedule.power.on
              ? ` to ${nextDay.charAt(0).toUpperCase() + nextDay.slice(1)} morning` : '' }
          </SectionHeading>
          { settings.timeZone !== moment.tz.guess() && <Typography variant="caption" color="text.secondary">
            { friendlyTimeZone(settings.timeZone) }
          </Typography> }
        </Box>
        { !firstRun && <EnabledSwitch/> }
      </Box>
      { !firstRun ? selectedSchedule?.power.enabled ? <>
        <ErrorBoundary componentName="Scheduling chart"><TemperatureScheduleChart/></ErrorBoundary>
        <ScheduleTimeline key={ `${side}-${selectedDay}` } format={ format } risePattern={ risePattern }/>
      </> : <Typography color="text.secondary" sx={ { width: '100%' } }>This night is off</Typography> : <Box
        sx={ { width: '100%', p: 2, border: 1, borderColor: 'divider', borderRadius: 1 } }>
        <SectionHeading>Set a bedtime and a wake time</SectionHeading>
        <Typography color="text.secondary" sx={ { my: 2 } }>
          Choose when the bed turns on and when you wake up, then adjust the temperature and vibration for this night.
        </Typography>
        <Button variant="contained" onClick={ startNight }>Set bedtime and wake time</Button>
      </Box> }
      { !firstRun && <ApplyToOtherDaysAccordion/> }
      { settings?.features?.oneOffAlarms && <Accordion sx={ { width: '100%' } } slotProps={ { transition: { unmountOnExit: true } } }>
        <AccordionSummary expandIcon={ <ExpandMore/> }>
          <Typography component="span" variant="inherit">{ oneOffText ? `One-time alarm: ${oneOffText}` : 'Add one-time alarm' }</Typography>
        </AccordionSummary>
        <AccordionDetails><OneOffAlarmSection/></AccordionDetails>
      </Accordion> }
      { saveError && <Alert severity="error" sx={ { width: '100%' } }>{ saveError }</Alert> }
      { showSchemaError && schemaIssue && <Alert severity="error" sx={ { width: '100%' } }>
        { schemaField }: { schemaIssue.message }
      </Alert> }
      { changesPresent && <DraftBar>
        { invalidTimes > 0 || schemaIssue ? <Button
          color="error"
          onClick={ showInvalidRow }
          sx={ { flex: 1, minWidth: 0, whiteSpace: 'nowrap', px: 0 } }>
          { schemaIssue ? 'Fix schedule' : `Fix ${invalidTimes} ${invalidTimes === 1 ? 'time' : 'times'}` }
        </Button>
          : <Typography
            role="status"
            variant="body2"
            title={ draftLabel }
            aria-label={ draftLabel }
            sx={ { flex: 1, minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3 } }>
            Unsaved: <bdi>{ sideLabel }</bdi>, { shortDay }{ affectedDays.length > 1 ? ` +${affectedDays.length - 1}` : '' }
          </Typography> }
        <Button
          onClick={ () => { reloadScheduleData(); nightHeading()?.focus({ preventScroll: true }); } }
          disabled={ isUpdating }
          sx={ { flexShrink: 0, px: 1 } }>Discard</Button>
        <SaveButton onSave={ handleSave }/>
      </DraftBar> }

      <Dialog open={ !!pendingChange } onClose={ () => setPendingChange(undefined) } aria-labelledby="discard-schedule-title">
        <DialogTitle id="discard-schedule-title">{ discardTitleText }</DialogTitle>
        <DialogActions>
          <Button onClick={ () => setPendingChange(undefined) } autoFocus>Keep editing</Button>
          <Button onClick={ discardAndSwitch }>Discard</Button>
        </DialogActions>
      </Dialog>
    </PageContainer>
  );
}
