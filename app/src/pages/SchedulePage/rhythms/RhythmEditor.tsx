import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import _ from 'lodash';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, MenuItem, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ErrorBoundary from '@components/ErrorBoundary';
import SectionHeading from '@components/SectionHeading';
import { DEFAULT_SMART, rhythmOffWhenUp, type Rhythm, type SideRhythms, type SmartSchedule } from '@api/rhythmsSchema';
import { CURVE, isDaySleep } from '@api/smartCurve';
import { useDeviceStatus } from '@api/deviceStatus';
import { supportsRisePattern } from '@api/alarmPattern';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { useAppStore } from '@state/appStore';
import DraftBar from '../DraftBar';
import TemperatureScheduleChart from '../ScheduleChart';
import ScheduleTimeline from '../ScheduleTimeline';
import { useScheduleStore } from '../scheduleStore';
import { timeInPowerWindow, validateSchedule } from '../scheduleValidation';
import SmartCurveChart from './SmartCurveChart';
import SmartResearchSheet from './SmartResearchSheet';
import SmartScheduleControls from './SmartScheduleControls';
import { bedtimeNote, nightAnchors, previewCurves } from './smartPreview';
import {
  DEFAULT_WAKE, defaultNight, isRhythmInUse, MAX_NAME_LENGTH, MAX_RHYTHMS_PER_SIDE, newRhythmId, NO_SLEEP, rhythmUsage, usageSubject,
  withOffWhenUp,
} from './rhythmsModel';

type Props = {
  sideData: SideRhythms;
  rhythmId: string | null;
  sideLabel: string;
  format: TemperatureFormat;
  timeZone: string;
  today: string;
  trackingOn: boolean;
  saveError: string;
  onSave: (next: SideRhythms) => Promise<boolean>;
  onDelete: (id: string, replacement: string | null) => Promise<boolean>;
  onClose: (savedId?: string) => void;
};

const focusSaveError = () => document.getElementById('rhythm-save-error')?.focus({ preventScroll: true });

// The draft bar unmounts and its buttons are disabled mid-save, so focus would fall to the page body.
function focusIfLost(target: () => HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest('[data-schedule-draft]')) return;
  target()?.focus({ preventScroll: true });
}

export default function RhythmEditor({
  sideData, rhythmId, sideLabel, format, timeZone, today, trackingOn, saveError, onSave, onDelete, onClose,
}: Props) {
  const original = rhythmId ? sideData.rhythms[rhythmId] : undefined;
  const [baseline] = useState(() => ({
    name: original?.name ?? `Rhythm ${Object.keys(sideData.rhythms).length + 1}`,
    // New rhythms start on Smart Schedule; converted ones keep their hand-set rows.
    mode: (original?.temperatureMode ?? 'smart') as Rhythm['temperatureMode'],
    smart: withOffWhenUp(original?.smart ?? DEFAULT_SMART, !!original && rhythmOffWhenUp(original)),
    wake: original?.wake ?? DEFAULT_WAKE,
  }));
  const isUpdating = useAppStore(state => state.isUpdating);
  const { data: deviceStatus } = useDeviceStatus();
  const risePattern = supportsRisePattern(deviceStatus?.hubVersion, deviceStatus?.coverVersion);
  const night = useScheduleStore(state => state.selectedSchedule);
  const nightBaseline = useScheduleStore(state => state.nightBaseline);
  const nightChanged = useScheduleStore(state => state.changesPresent);
  const [name, setName] = useState(baseline.name);
  const [mode, setMode] = useState<Rhythm['temperatureMode']>(baseline.mode);
  const [smart, setSmart] = useState<SmartSchedule>(baseline.smart);
  const [wake, setWake] = useState(baseline.wake);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const others = Object.values(sideData.rhythms).filter(rhythm => rhythm.id !== rhythmId);
  const [replacement, setReplacement] = useState(others[0]?.id ?? 'none');
  const [saveFailures, setSaveFailures] = useState(0);
  const nameInput = useRef<HTMLInputElement>(null);
  const dirty = nightChanged || name !== baseline.name || mode !== baseline.mode || wake !== baseline.wake
    || !_.isEqual(smart, baseline.smart);
  const showDraft = dirty || !original;

  // Load once per rhythm so a refetch never replaces the draft.
  useEffect(() => {
    useScheduleStore.getState().editNight(original?.night ?? defaultNight());
    return () => useScheduleStore.getState().endNightEdit();
  }, [rhythmId]);

  // Keep a focused control clear of the draft bar, as the weekly page does.
  useLayoutEffect(() => {
    if (!showDraft) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = '160px';
    return () => { root.style.scrollPaddingBottom = previous; };
  }, [showDraft]);

  // A failed save keeps the draft and moves focus to the reason, shown just above the draft bar.
  useEffect(() => {
    if (saveFailures) requestAnimationFrame(focusSaveError);
  }, [saveFailures]);

  // The card that opened the editor is gone, so start keyboard users at the rhythm's heading.
  const loaded = !!nightBaseline;
  useEffect(() => {
    if (loaded) focusIfLost(() => document.getElementById('rhythm-night-heading'));
  }, [loaded]);

  if (!night || !nightBaseline) return null;

  const trimmed = name.trim();
  const nameError = !trimmed ? 'Enter a name.' : trimmed.length > MAX_NAME_LENGTH ? `Use ${MAX_NAME_LENGTH} characters or fewer.` : '';
  const checked = validateSchedule(mode === 'smart' ? { ...night, temperatures: {} } : night, nightBaseline.alarms.length);
  const invalidTimes = checked.invalidTimes + (night.power.enabled && !timeInPowerWindow(wake, night.power) ? 1 : 0);
  const { schemaIssues } = checked;
  // The server refuses a side with more rhythms than this.
  const full = !original && Object.keys(sideData.rhythms).length >= MAX_RHYTHMS_PER_SIDE;
  const valid = !full && !nameError && invalidTimes === 0 && schemaIssues.length === 0 && night.power.enabled;
  const draftLabel = `Unsaved: ${sideLabel}, ${trimmed || 'New rhythm'}`;
  const anchors = nightAnchors(night, wake, today, timeZone);
  const daySleep = mode === 'smart' && isDaySleep(anchors.bedtime, anchors.wake, timeZone);
  // The curve drops the warm start for a sleep this short.
  const shortSleep = mode === 'smart' && anchors.wake.getTime() - anchors.bedtime.getTime() < CURVE.shortWindowMinutes * 60_000;
  const note = mode === 'smart'
    ? bedtimeNote(previewCurves({ night, wake, smart, date: today, timeZone, trackingOn: false }).points, timeZone) ?? ''
    : undefined;
  const usage = original ? rhythmUsage(sideData, original.id, today) : undefined;
  const inUse = !!original && isRhythmInUse(sideData, original.id, today);
  const problem = nameError ? 'Fix name' : invalidTimes > 0 ? `Fix ${invalidTimes} ${invalidTimes === 1 ? 'time' : 'times'}`
    : schemaIssues.length > 0 ? 'Fix rhythm' : '';

  const save = async () => {
    if (!valid) return;
    const id = rhythmId ?? newRhythmId(trimmed, Object.keys(sideData.rhythms));
    const rhythm: Rhythm = { id, name: trimmed, night, wake, temperatureMode: mode, smart, ...(smart.offWhenUp ? { offWhenUp: true } : {}) };
    if (await onSave({ ...sideData, rhythms: { ...sideData.rhythms, [id]: rhythm } })) onClose(id);
    else setSaveFailures(count => count + 1);
  };
  const discard = () => {
    useScheduleStore.getState().reloadScheduleData();
    setName(baseline.name);
    setMode(baseline.mode);
    setSmart(baseline.smart);
    setWake(baseline.wake);
    document.getElementById('rhythm-night-heading')?.focus({ preventScroll: true });
  };
  const remove = async () => {
    if (!original) return;
    if (await onDelete(original.id, replacement === 'none' ? null : replacement)) return;
    setDeleteOpen(false);
    setSaveFailures(count => count + 1);
  };
  const showProblem = () => {
    if (nameError) {
      nameInput.current?.focus();
      return;
    }
    const row = document.querySelector<HTMLElement>('[data-invalid="true"]');
    row?.scrollIntoView?.({ block: 'center' });
    row?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  };

  const errorAlert = <Alert id="rhythm-save-error" severity="error" tabIndex={ -1 } sx={ { width: '100%', outline: 'none' } }>
    { saveError }
  </Alert>;

  return <>
    <Button startIcon={ <ChevronLeft/> } onClick={ () => (dirty ? setLeaveOpen(true) : onClose()) } sx={ { alignSelf: 'flex-start', px: 0 } }>
      Rhythms
    </Button>
    <SectionHeading id="rhythm-night-heading" tabIndex={ -1 } sx={ { width: '100%', outline: 'none', overflowWrap: 'anywhere' } }>
      <bdi>{ baseline.name }</bdi>
    </SectionHeading>
    <TextField
      label="Name"
      value={ name }
      inputRef={ nameInput }
      error={ !!nameError }
      helperText={ nameError || `For ${sideLabel}` }
      disabled={ isUpdating }
      fullWidth
      onChange={ event => setName(event.target.value) }/>
    { full && <Alert severity="warning" sx={ { width: '100%' } }>
      { `This side already has ${MAX_RHYTHMS_PER_SIDE} rhythms, the most it can have. Delete one to add another.` }
    </Alert> }
    { !night.power.enabled && <Alert
      severity="info"
      sx={ { width: '100%' } }
      action={ <Button onClick={ () => useScheduleStore.getState().updateSelectedSchedule({ power: { enabled: true } }) }>Turn on</Button> }>
      This rhythm's night is off.
    </Alert> }
    <ScheduleTimeline
      format={ format }
      risePattern={ risePattern }
      hideTemperatures={ mode === 'smart' }
      bedtimeNote={ note }
      wake={ { time: wake, onChange: setWake } }
      getUp={ { on: smart.offWhenUp === true, tracking: trackingOn, onChange: on => setSmart(withOffWhenUp(smart, on)) } }/>
    <Box component="section" aria-labelledby="temperature-heading" sx={ { width: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 } }>
      <SectionHeading id="temperature-heading">Temperature</SectionHeading>
      <ToggleButtonGroup
        exclusive
        color="primary"
        aria-labelledby="temperature-heading"
        value={ mode }
        disabled={ isUpdating }
        sx={ { flexWrap: 'wrap' } }
        onChange={ (_event, next: Rhythm['temperatureMode'] | null) => {
          if (!next) return;
          setMode(next);
        } }>
        <ToggleButton value="smart">Smart Schedule</ToggleButton>
        <ToggleButton value="manual">Set by hand</ToggleButton>
      </ToggleButtonGroup>
      { night.power.enabled && <ErrorBoundary componentName="Rhythm chart">
        { mode === 'smart'
          ? <SmartCurveChart
            night={ night }
            wake={ wake }
            smart={ smart }
            date={ today }
            timeZone={ timeZone }
            format={ format }
            trackingOn={ trackingOn }/>
          : <TemperatureScheduleChart/> }
      </ErrorBoundary> }
      { mode === 'smart' && <Button
        onClick={ () => setResearchOpen(true) }
        aria-haspopup="dialog"
        endIcon={ <ChevronRight/> }
        sx={ { alignSelf: 'flex-start', px: 0, mt: -1, minHeight: 44 } }>
        The research behind it
      </Button> }
      { researchOpen && <SmartResearchSheet onClose={ () => setResearchOpen(false) }/> }
      { mode === 'smart' && <SmartScheduleControls
        value={ smart }
        onChange={ setSmart }
        format={ format }
        trackingOn={ trackingOn }
        daySleep={ daySleep }
        shortSleep={ shortSleep }
        disabled={ isUpdating }/> }
    </Box>
    { saveError && !showDraft && errorAlert }
    { original && <Button color="error" onClick={ () => setDeleteOpen(true) } disabled={ isUpdating } sx={ { alignSelf: 'flex-start', px: 0 } }>
      Delete rhythm
    </Button> }
    { showDraft && <Box aria-hidden sx={ { height: saveError ? 200 : 72 } }/> }
    { showDraft && <DraftBar above={ saveError ? errorAlert : undefined }>
      { problem ? <Button color="error" onClick={ showProblem } sx={ { flex: 1, minWidth: 0, whiteSpace: 'nowrap', px: 0 } }>{ problem }</Button>
        : <Typography
          role="status"
          variant="body2"
          title={ draftLabel }
          aria-label={ draftLabel }
          sx={ { flex: 1, minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3 } }>
          Unsaved: <bdi>{ sideLabel }</bdi>, <bdi>{ trimmed || 'New rhythm' }</bdi>
        </Typography> }
      { original && dirty && <Button onClick={ discard } disabled={ isUpdating } sx={ { flexShrink: 0, px: 1 } }>Discard</Button> }
      <Button data-schedule-save="true" variant="contained" onClick={ () => void save() } disabled={ isUpdating || !valid }>Save</Button>
    </DraftBar> }
    <Dialog open={ leaveOpen } onClose={ () => setLeaveOpen(false) } aria-labelledby="leave-rhythm-title">
      <DialogTitle id="leave-rhythm-title">Discard changes to { baseline.name }?</DialogTitle>
      <DialogActions>
        <Button onClick={ () => setLeaveOpen(false) } autoFocus>Keep editing</Button>
        <Button onClick={ () => onClose() }>Discard</Button>
      </DialogActions>
    </Dialog>
    { original && <Dialog open={ deleteOpen } onClose={ () => setDeleteOpen(false) } aria-labelledby="delete-rhythm-title">
      <DialogTitle id="delete-rhythm-title">Delete { original.name }?</DialogTitle>
      <DialogContent>
        { inUse && usage ? <>
          <DialogContentText>{ `${usageSubject(usage)} will use:` }</DialogContentText>
          <TextField
            select
            fullWidth
            label="Use instead"
            value={ replacement }
            sx={ { mt: 2 } }
            onChange={ event => setReplacement(event.target.value) }>
            { others.map(rhythm => <MenuItem key={ rhythm.id } value={ rhythm.id }>{ rhythm.name }</MenuItem>) }
            <MenuItem value="none">{ NO_SLEEP }</MenuItem>
          </TextField>
        </> : <DialogContentText>This rhythm is not used on any day or date.</DialogContentText> }
      </DialogContent>
      <DialogActions>
        <Button onClick={ () => setDeleteOpen(false) }>Cancel</Button>
        <Button color="error" variant="contained" disabled={ isUpdating } onClick={ () => void remove() }>
          { inUse ? 'Move and delete' : 'Delete this rhythm' }
        </Button>
      </DialogActions>
    </Dialog> }
  </>;
}
