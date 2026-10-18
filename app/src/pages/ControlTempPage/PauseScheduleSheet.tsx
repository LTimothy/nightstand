import { useState } from 'react';
import moment from 'moment-timezone';
import { Alert, Box, Button, Drawer, FormControlLabel, Radio, RadioGroup, TextField, Typography } from '@mui/material';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { MAX_ON_DURATION_SECONDS } from '@api/deviceStatusSchema.ts';
import { postSettings, useSettings } from '@api/settings.ts';
import { isSchedulePaused } from '@api/schedulePause.ts';
import { useSchedules } from '@api/schedules.ts';
import { useAppStore } from '@state/appStore.tsx';
import { friendlyTimeZone } from '@lib/timeZone';
import { serverMessage } from '@lib/requestError';
import { weeklySkips } from './bedEvents';
import { nextSleepEvent, pauseOptionLabel, skippedFromSleeps, skipLine, sleepAt, type Skip } from './sleepEvents';
import { useBedSleeps } from './useBedSleeps';
import { formatPauseEnd, pauseEndError, setTimeDefaultWith, tonightOnlyEndWith, weeklyTimes, type NextBedTime } from './pauseTimes';

type Choice = 'tonight' | 'until' | 'resume';
// The datetime-local input's value, read as wall-clock time in the Pod timezone.
const INPUT_FORMAT = 'YYYY-MM-DDTHH:mm';
// Some browsers add seconds; the pause always ends on a whole minute.
const INPUT_FORMATS = [`${INPUT_FORMAT}:ss.SSS`, `${INPUT_FORMAT}:ss`, INPUT_FORMAT];

export default function PauseScheduleSheet({ open, onClose, onPaused }: {
  open: boolean; onClose: () => void; onPaused?: () => void;
}) {
  const { side } = useAppStore();
  const { data: settings, refetch } = useSettings();
  const { data: schedules } = useSchedules();
  const timeZone = settings?.timeZone ?? 'UTC';
  const schedule = schedules?.[side];
  const bed = useBedSleeps(side);
  const { data: deviceStatus } = useDeviceStatus();
  // Under Rhythms a pause ends at the resolved sleep's times, not the weekly schedule's.
  const next: NextBedTime | undefined = bed.state === 'rhythms'
    ? (after, kind) => nextSleepEvent(bed.sleeps, timeZone, after, kind)?.at
    : bed.state === 'legacy' && schedule ? weeklyTimes(schedule, timeZone) : undefined;
  const editing = !!settings && isSchedulePaused(settings, side, moment().toDate());
  const storedEnd = editing ? settings[side].scheduleOverrides.pause.expiresAt : '';
  const [choice, setChoice] = useState<Choice>(editing ? storedEnd ? 'until' : 'resume' : 'tonight');
  const [picked, setPicked] = useState<string | null>(storedEnd ? moment.tz(storedEnd, timeZone).format(INPUT_FORMAT) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!settings || !next) return null;
  const now = moment.tz(timeZone);
  const tonightEnd = tonightOnlyEndWith(next, timeZone, now);
  const onceLabel = bed.state === 'rhythms' ? pauseOptionLabel(sleepAt(bed.sleeps, tonightEnd.toDate()), timeZone) : 'Tonight only';
  const defaultUntil = setTimeDefaultWith(next, timeZone, now).format(INPUT_FORMAT);
  const untilLocal = picked ?? defaultUntil;
  const untilEnd = moment.tz(untilLocal, INPUT_FORMATS, true, timeZone).startOf('minute');
  const untilError = choice !== 'until' ? null : untilEnd.isValid() ? pauseEndError(untilEnd, now) : 'Pick a date and time';
  const other = side === 'left' ? 'right' : 'left';
  const name = settings[side].name || (side === 'left' ? 'Left side' : 'Right side');
  const partner = settings[other].name || (other === 'left' ? 'Left side' : 'Right side');
  // What each choice skips, from the resolved sleeps or the weekly schedule.
  const skips = (end: moment.Moment): Skip[] => {
    if (bed.state === 'rhythms') return skippedFromSleeps(bed.sleeps, timeZone, now, end);
    return schedule ? weeklySkips(schedule, timeZone, now, end) : [];
  };
  // A pause with an end moves a running side's timer out to that end, by at most 12 hours.
  const status = deviceStatus?.[side];
  const timer = status?.isOn && (status.secondsRemaining ?? 0) > 0 ? now.clone().add(status.secondsRemaining, 'seconds') : undefined;
  const end = choice === 'tonight' ? tonightEnd : choice === 'until' && !untilError ? untilEnd : undefined;
  const held = end && moment.min(end, now.clone().add(MAX_ON_DURATION_SECONDS, 'seconds'));
  const offAt = timer && held ? moment.max(timer, held) : timer;
  const offText = offAt && formatPauseEnd(offAt, timeZone, now);
  const until = offAt && (end && offAt.isSame(end) ? `the pause ends at ${offText}` : offText);
  const onNow = !status?.isOn ? '' : until
    ? `${name}'s side is on now and stays on until ${until}, or until you turn it off.`
    : `${name}'s side is on now and stays on until you turn it off.`;

  // A save in flight cannot be cancelled, so closing waits for it.
  const close = () => {
    if (!saving) onClose();
  };

  const pause = async () => {
    // aria-disabled keeps focus on the button, so it does not block the click itself.
    if (saving || untilError) return;
    const expiresAt = choice === 'tonight' ? tonightEnd.format() : choice === 'until' ? untilEnd.format() : '';
    setSaving(true);
    setError('');
    try {
      await postSettings({ [side]: { scheduleOverrides: { pause: { active: true, expiresAt } } } });
      await refetch();
      onPaused?.();
      onClose();
    } catch (err) {
      console.error(err);
      setError(serverMessage(err) ?? 'Could not pause the schedule. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      anchor="bottom"
      open={ open }
      onClose={ close }
      slotProps={ { paper: { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'pause-schedule-title' } } }>
      <Box sx={ { p: 3, width: '100%', maxWidth: 720, mx: 'auto' } }>
        <Typography variant="h2" id="pause-schedule-title">{ editing ? 'Change pause for' : 'Pause' } <bdi>{ name }</bdi>'s schedule</Typography>
        <RadioGroup
          aria-labelledby="pause-schedule-title"
          value={ choice }
          onChange={ (_event, value) => {
            setChoice(value as Choice);
            setError('');
          } }
          sx={ { my: 2 } }>
          <FormControlLabel
            value="tonight"
            control={ <Radio autoFocus={ choice === 'tonight' }/> }
            label={ <Box>
              <Typography>{ onceLabel }</Typography>
              <Typography variant="caption" color="text.secondary" sx={ { display: 'block' } }>
                { `until ${formatPauseEnd(tonightEnd, timeZone, now)}` }
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={ { display: 'block' } }>{ skipLine(skips(tonightEnd), now) }</Typography>
            </Box> }
            sx={ { minHeight: 44, alignItems: 'flex-start', '& .MuiRadio-root': { mt: -0.5 } } }/>
          <FormControlLabel
            value="until"
            control={ <Radio autoFocus={ choice === 'until' }/> }
            label={ <Box>
              <Typography>Until a set time</Typography>
              { choice === 'until' && !untilError && <Typography variant="caption" color="text.secondary" sx={ { display: 'block' } }>
                { skipLine(skips(untilEnd), now) }
              </Typography> }
            </Box> }
            sx={ { minHeight: 44, alignItems: 'flex-start', '& .MuiRadio-root': { mt: -0.5 } } }/>
          { choice === 'until' && <TextField
            type="datetime-local"
            label="Resume at"
            variant="standard"
            value={ untilLocal }
            onChange={ event => setPicked(event.target.value) }
            error={ !!untilError }
            helperText={ untilError
              ?? `${untilLocal === defaultUntil ? 'In time for your next sleep. ' : ''}Timezone: ${friendlyTimeZone(timeZone)}` }
            slotProps={ { inputLabel: { shrink: true } } }
            sx={ { ml: 4, mb: 1, maxWidth: 'calc(100% - 32px)' } }/> }
          <FormControlLabel
            value="resume"
            control={ <Radio autoFocus={ choice === 'resume' }/> }
            label={ <Box>
              <Typography>Until I resume</Typography>
              <Typography variant="caption" color="text.secondary" sx={ { display: 'block' } }>
                Skips every start and alarm until you resume
              </Typography>
            </Box> }
            sx={ { minHeight: 44, alignItems: 'flex-start', '& .MuiRadio-root': { mt: -0.5 } } }/>
        </RadioGroup>
        { onNow && <Typography variant="body2" sx={ { mb: 1 } }><bdi>{ onNow }</bdi></Typography> }
        <Typography variant="body2" color="text.secondary">
          Your saved schedule is kept.
          { !settings[other].awayMode && <> <bdi>{ partner }</bdi>'s side is not affected.</> }
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>
          When the pause ends, an off side turns on if its night is in progress. Skipped alarms stay skipped.
        </Typography>
        { error && <Alert severity="error" sx={ { mt: 2 } }>{ error }</Alert> }
        <Box sx={ { display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 2 } }>
          <Button onClick={ close } aria-disabled={ saving || undefined } sx={ { minHeight: 44 } }>Cancel</Button>
          { /* aria-disabled while saving, so keyboard focus stays on the button */ }
          <Button
            variant="contained"
            onClick={ pause }
            disabled={ !!untilError }
            aria-disabled={ saving || undefined }
            sx={ { minHeight: 44, ...(saving ? { opacity: 0.6 } : {}) } }>
            { editing ? 'Save pause' : 'Pause' }
          </Button>
        </Box>
      </Box>
    </Drawer>
  );
}
