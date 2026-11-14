import { useEffect, useState } from 'react';
import moment from 'moment-timezone';
import { useAppStore } from '@state/appStore';
import { useDeviceStatus } from '@api/deviceStatus';
import { isPresenceFresh, usePresence } from '@api/presence';
import { useRhythmsLive } from '@api/rhythms';
import { isSchedulePaused, pauseEndsAt } from '@api/schedulePause';
import { useSchedules } from '@api/schedules';
import { useSettings } from '@api/settings';
import { nextBedEvent } from './bedEvents';
import { NBSP } from './bedText';
import { pauseResumeAt } from './pauseTimes';
import { currentSleep, nextSleepEvent, preWarms, sleepAt } from './sleepEvents';
import { useBedSleeps } from './useBedSleeps';

const clock = (at: moment.Moment) => at.format(`h:mm${NBSP}A`);

// When the side next turns off or on, and while paused, when its own timer ends it.
export function useBedCaption(isOn: boolean): string[] {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const { data: schedules } = useSchedules();
  const { data: deviceStatus } = useDeviceStatus();
  const bed = useBedSleeps(side);
  const { data: live } = useRhythmsLive(side, bed.state === 'rhythms');
  const { data: presence } = usePresence();
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 30_000); return () => clearInterval(timer); }, []);
  const kind = isOn ? 'off' : 'on';
  // While paused, scheduled turn-offs are skipped.
  const paused = !!settings && isSchedulePaused(settings, side, new Date());
  const pauseEnd = settings && paused ? pauseEndsAt(settings, side) : null;
  const resumeAt = !isOn && pauseEnd && settings && !settings[side].awayMode
    ? pauseResumeAt(bed, schedules?.[side], settings.timeZone, moment(pauseEnd)) : undefined;
  const searchFrom = settings && (pauseEnd ? moment.tz(pauseEnd, settings.timeZone).subtract(1, 'ms') : moment.tz(settings.timeZone));
  const event = !settings || !searchFrom || settings[side].awayMode || (paused && (isOn || !pauseEnd)) ? undefined
    : bed.state === 'rhythms' ? nextSleepEvent(bed.sleeps, settings.timeZone, searchFrom, kind)
      : bed.state === 'legacy' && schedules ? nextBedEvent(schedules[side], settings.timeZone, searchFrom, kind)
        : undefined;
  const now = moment.tz(settings?.timeZone ?? 'UTC');
  // The firmware timer still turns a running side off during a pause.
  const timer = deviceStatus?.[side]?.secondsRemaining;
  const timerOff = paused && isOn && timer && timer > 0 ? now.clone().add(timer, 'seconds') : undefined;
  // Between nights the firmware timer turns a running side off: after a sleep kept on when Rhythms was turned off,
  // after tonight's running sleep is removed, or after a manual start.
  const running = isOn && !paused && !!settings && !settings[side].awayMode;
  const nextStart = !running ? undefined
    : bed.state === 'rhythms' ? nextSleepEvent(bed.sleeps, settings.timeZone, now, 'on')
      : bed.state === 'legacy' && schedules ? nextBedEvent(schedules[side], settings.timeZone, now, 'on') : undefined;
  const timerEnd = running && (bed.state === 'rhythms' || (bed.state === 'legacy' && !!schedules)) && timer && timer > 0
    ? now.clone().add(timer, 'seconds') : undefined;
  const betweenNights = bed.state === 'rhythms' ? !currentSleep(bed.sleeps, now.toDate())
    : !event || (!!nextStart && nextStart.at.isBefore(event.at));
  const turnsOff = timerEnd && betweenNights && (!nextStart || timerEnd.isBefore(nextStart.at)) ? timerEnd : event?.at;
  const warming = !resumeAt && !isOn && !!event && bed.state === 'rhythms'
    && preWarms(sleepAt(bed.sleeps, event.at.toDate()));
  // A "When I get up" sleep turns off when the person gets up, by its latest off.
  const upBy = isOn && !paused && !!settings && !settings[side].awayMode && live?.offWhenUp
    ? moment.tz(live.offWhenUp.by, settings.timeZone) : undefined;
  const shownAt = upBy ?? (isOn ? turnsOff : resumeAt ?? event?.at);
  const eventDay = shownAt && (shownAt.isSame(now, 'day') ? shownAt.hour() >= 17 ? ' tonight' : ' today'
    : shownAt.isSame(now.clone().add(1, 'day'), 'day') ? ' tomorrow' : ` ${shownAt.format('ddd')}`);
  const lines: string[] = [];
  if (shownAt) {
    // Only fresh presence can move the turn-off, so without it the line keeps just the latest time. While the
    // other side is away the server reads both sides' presence, and either fresh one will do.
    const other = side === 'left' ? 'right' : 'left';
    const watched = settings?.[other]?.awayMode ? [side, other] as const : [side] as const;
    const whenUp = watched.some(key => isPresenceFresh(presence?.[key])) ? ' when you get up,' : '';
    lines.push(upBy ? `Turns off${whenUp}${eventDay} by${NBSP}${clock(upBy)}`
      : `${isOn ? 'Turns off' : warming ? 'Starts warming' : 'Turns on'}${eventDay} at${NBSP}${clock(shownAt)}`);
  }
  if (paused && isOn) lines.push(timerOff ? `Turns off at${NBSP}${clock(timerOff)}` : 'Stays on until you turn it off');
  return lines;
}
