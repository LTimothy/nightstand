import SectionHeading from '@components/SectionHeading';
import StatusText from '@components/StatusText';
import { useEffect, useRef, useState } from 'react';
import moment from 'moment-timezone';
import { Box, Button, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { useSchedules } from '@api/schedules.ts';
import { useSettings } from '@api/settings.ts';
import { isSchedulePaused, pauseEndsAt } from '@api/schedulePause.ts';
import { useAppStore } from '@state/appStore.tsx';
import { palette, sx as shared } from '@design/tokens';
import { displayTemperature } from '@lib/temperatureConversions.ts';
import { nextBedEvent } from './bedEvents';
import AlarmNotification from './AlarmNotification';
import OneOffAlarmLine from './OneOffAlarmLine';
import PauseScheduleSheet from './PauseScheduleSheet';
import { MAX_PAUSE_DAYS, pauseResumeAt } from './pauseTimes';
import SchedulePauseNotice from './SchedulePauseNotice';
import SmartPhaseLine from './SmartPhaseLine';
import { currentSleep, isEveningSleep, nextSleepEvent, preWarms, sleepAt } from './sleepEvents';
import { useBedSleeps } from './useBedSleeps';
import { cardSx, headingSx, tonightLineSx } from './tonightStyles';
import useTemperatureFormat from '@lib/useTemperatureFormat';

export default function UpcomingNight() {
  const { side } = useAppStore();
  const { data: schedules, isError: schedulesError, refetch: refetchSchedules } = useSchedules();
  const { data: settings, isError: settingsError, refetch: refetchSettings } = useSettings();
  const format = useTemperatureFormat();
  const bed = useBedSleeps(side);
  const [pauseOpen, setPauseOpen] = useState(false);
  const editingPause = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Pausing and resuming swap the card's buttons; focus moves once the expected one exists.
  const [focusWhenPaused, setFocusWhenPaused] = useState<boolean | null>(null);
  const schedulePaused = !!settings && isSchedulePaused(settings, side, moment().toDate());
  useEffect(() => {
    if (focusWhenPaused !== schedulePaused) return;
    const target = schedulePaused && editingPause.current ? '[data-pause-edit]' : '[data-pause-control]';
    cardRef.current?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
    setFocusWhenPaused(null);
  }, [focusWhenPaused, schedulePaused]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const retry = () => {
    if (!schedules) void refetchSchedules();
    if (!settings) void refetchSettings();
    if (bed.state === 'error') bed.retry();
  };
  // While Rhythms runs the weekly schedules are not needed.
  const legacy = bed.state === 'legacy';
  if (!settings || bed.state === 'loading' || bed.state === 'error' || (legacy && !schedules)) {
    const failed = settingsError || bed.state === 'error' || (legacy && schedulesError);
    // The card holds its place while the schedule loads, so nothing under it moves when it arrives.
    return (
      <Box data-tonight sx={ cardSx }>
        <SectionHeading sx={ headingSx }>Tonight</SectionHeading>
        { /* One region from Loading schedule to Schedule unavailable, so the change is announced. */ }
        <StatusText sx={ failed ? tonightLineSx : { ...tonightLineSx, color: palette.text.tertiary } }>
          { failed ? 'Schedule unavailable.' : 'Loading schedule' }
        </StatusText>
        { failed && <Button sx={ { ...shared.lampLink, ml: '-10px' } } onClick={ retry }>Try again</Button> }
      </Box>
    );
  }
  const upcoming = (after?: moment.Moment, kind?: 'on' | 'off') => bed.state === 'rhythms'
    ? nextSleepEvent(bed.sleeps, settings.timeZone, after, kind)
    : schedules ? nextBedEvent(schedules[side], settings.timeZone, after, kind) : undefined;
  // The sentence leads with the next event, a start included, whether the side is on or off.
  const event = !settings[side].awayMode && upcoming();
  const current = bed.state === 'rhythms' && !settings[side].awayMode ? currentSleep(bed.sleeps, new Date()) : undefined;
  const smartSleep = current?.mode === 'smart' ? current : undefined;
  // Name the rhythm the next change belongs to, so a date change or weekday pick is easy to confirm.
  const eventSleep = bed.state === 'rhythms' && event ? sleepAt(bed.sleeps, event.at.toDate()) : undefined;
  const nameOf = (at: moment.Moment) => {
    const sleep = bed.state === 'rhythms' ? sleepAt(bed.sleeps, at.toDate()) : undefined;
    return bed.state === 'rhythms' && sleep?.rhythmId ? bed.names?.[sleep.rhythmId] : undefined;
  };
  const rhythmLabel = event ? nameOf(event.at) : undefined;
  const temperature =
    event && event.temperature !== undefined ? displayTemperature(event.temperature, format) : '';
  const override = settings[side].scheduleOverrides.temperatureSchedules;
  const paused = override.disabled && moment(override.expiresAt).isAfter(moment());
  const eventPaused = paused && !!event && moment(override.expiresAt).isAfter(event.at);
  const action =
    event &&
    (event.kind === 'off'
      ? 'Turns off'
      : event.kind === 'on'
        ? preWarms(eventSleep) ? 'Starts warming' : 'Turns on'
        : `Changes to ${temperature}`);
  const now = moment.tz(settings.timeZone);
  // An older server leaves pause out of its settings and would drop the write.
  const canPause = !schedulePaused && !settings[side].awayMode && !!settings[side].scheduleOverrides.pause;
  const canChangePause = schedulePaused && !settings[side].awayMode;
  const dayWord = (at: moment.Moment) => at.isSame(now, 'day') ? at.hour() >= 17 ? 'tonight' : 'today'
    : at.isSame(now.clone().add(1, 'day'), 'day') ? 'tomorrow' : at.format('ddd');
  const eventDay = event && dayWord(event.at);
  // During a sleep the heading names that sleep: "Tonight" for an evening one, "This sleep" for a day sleep.
  const heading = current ? isEveningSleep(current, settings.timeZone) ? 'Tonight' : 'This sleep'
    : bed.state === 'rhythms' ? now.hour() >= 17 || (!!event && event.at.isSame(now, 'day') && event.at.hour() >= 17) ? 'Tonight' : 'Upcoming'
      : now.hour() >= 17 || (!!event && event.kind !== 'on' && event.at.isSame(now, 'day')) ? 'Tonight' : 'Upcoming';
  // Under Rhythms an away side runs the present side's sleeps.
  const other = side === 'left' ? 'right' : 'left';
  const followsPartner = bed.state === 'rhythms' && settings[side].awayMode && !settings[other].awayMode;
  const partner = followsPartner ? settings[other].name || (other === 'left' ? 'Left side' : 'Right side') : '';
  const pauseEnd = schedulePaused ? pauseEndsAt(settings, side) : null;
  const backOn = pauseEnd && !settings[side].awayMode
    ? pauseResumeAt(bed, schedules?.[side], settings.timeZone, moment(pauseEnd))
      ?? upcoming(moment(pauseEnd).subtract(1, 'ms'), 'on')?.at : undefined;
  const backOnName = backOn ? nameOf(backOn) : undefined;
  const backOnText = backOn && `Back on schedule ${dayWord(backOn)} at ${backOn.format('h:mm A')}${backOnName ? ` (${backOnName})` : ''}`;
  const eventText = event && `${action} ${eventDay} at ${event.at.format('h:mm A')}`
    + (event.kind === 'on' ? eventPaused ? ' and keeps your manual temperature' : `, ${temperature}` : '')
    + (event.kind === 'temperature' && eventPaused ? ' (on hold)' : '')
    + (rhythmLabel ? ` (${rhythmLabel})` : '');
  return (
    <Box ref={ cardRef } data-tonight sx={ cardSx }>
      <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 1 } }>
        <SectionHeading sx={ headingSx }>
          { heading }
        </SectionHeading>
        { /* Right-aligned on the heading's row; under it when the row is too narrow. */ }
        <Box sx={ { display: 'flex', ml: 'auto', mr: '-10px' } }>
          { canPause && <Button
            sx={ shared.lampLink }
            data-pause-control
            onClick={ () => { editingPause.current = false; setPauseOpen(true); } }>
            Pause schedule
          </Button> }
          { canChangePause && <Button
            sx={ shared.lampLink }
            data-pause-edit
            onClick={ () => { editingPause.current = true; setPauseOpen(true); } }>
            Change pause
          </Button> }
          <Button component={ Link } to="/schedules" aria-label="Edit schedule" sx={ shared.lampLink }>
            Edit
          </Button>
        </Box>
      </Box>
      { schedulePaused ? <SchedulePauseNotice detail={ backOnText || undefined } onResumed={ () => setFocusWhenPaused(false) }/> : <>
        { !(smartSleep && event && event.kind === 'temperature') && <Typography sx={ tonightLineSx }>
          { event
            ? eventText
            : bed.state !== 'rhythms' ? 'No upcoming power or temperature changes.'
              : followsPartner ? <>Away mode is on, so this side follows <bdi>{ partner }</bdi>'s schedule.</>
                // useBedSleeps loads this far ahead.
                : `No sleep scheduled in the next ${MAX_PAUSE_DAYS} days.` }
        </Typography> }
        { smartSleep && <SmartPhaseLine sleep={ smartSleep } side={ side }/> }
        <AlarmNotification />
      </> }
      <OneOffAlarmLine/>
      { pauseOpen && <PauseScheduleSheet
        open
        onPaused={ () => setFocusWhenPaused(true) }
        onClose={ () => { setPauseOpen(false); setFocusWhenPaused((expected) => expected ?? schedulePaused); } }/> }
    </Box>
  );
}
