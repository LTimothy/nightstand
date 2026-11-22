import moment from 'moment-timezone';
import { Alert, Box, Button, Typography } from '@mui/material';
import NotificationsNone from '@mui/icons-material/NotificationsNone';
import { palette, sx as shared } from '@design/tokens';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { useEffect, useState } from 'react';
import AlarmOverride from './AlarmOverride.tsx';
import AlarmDisabledDialog from './AlarmDisabledDialog.tsx';
import { useAlarmNight } from './useAlarmNight';

export default function AlarmNotification() {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const { night } = useAlarmNight(side);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [alarmTimeLocalOverride, setAlarmTimeLocalOverride] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setAlarmTimeLocalOverride('');
    setOverrideOpen(false);
    setDisabledOpen(false);
  }, [side]);

  if (!settings || !night) return null;
  const override = settings[side].scheduleOverrides.alarm;
  const expires = moment(override.expiresAt);
  const hasOverride = !!override.expiresAt && expires.isBetween(night.start, night.end, undefined, '(]');
  const disabled = hasOverride && override.disabled;
  const time = hasOverride && override.timeOverride ? override.timeOverride : night.alarms[0].alarm.time;
  const replacement = night.start.clone().hour(Number(time.split(':')[0])).minute(Number(time.split(':')[1]));
  if (time < night.start.format('HH:mm')) replacement.add(1, 'day');
  const replacementFinished = hasOverride && !!override.timeOverride && replacement.isBefore(moment());
  const scope = <><bdi>{ settings[side].name || (side === 'left' ? 'Left' : 'Right') }</bdi> · { night.start.format('ddd, MMM D') } night</>;
  const alarmDate = hasOverride && override.timeOverride ? replacement : night.alarms[0].at;
  const now = moment.tz(settings.timeZone);
  const alarmDay = alarmDate?.isSame(now, 'day') ? 'today'
    : alarmDate?.isSame(now.clone().add(1, 'day'), 'day') ? 'tomorrow' : alarmDate?.format('ddd');
  return (
    <Alert
      icon={ false }
      severity="info"
      sx={ {
        width: '100%', p: 0, background: 'transparent', border: 0, color: 'text.secondary',
        '& .MuiAlert-message': { width: '100%', py: 0 },
      } }>
      <AlarmOverride
        open={ overrideOpen }
        setOverrideOpen={ setOverrideOpen }
        alarmTimeLocalOverride={ alarmTimeLocalOverride }
        setAlarmTimeLocalOverride={ setAlarmTimeLocalOverride }
        scheduledAlarmTimeHhMm={ time }
        nightStart={ night.start.format() }
        nightEnd={ night.end.format() }
        scope={ scope } />
      <AlarmDisabledDialog
        open={ disabledOpen }
        setOpen={ setDisabledOpen }
        alarmDisabled={ disabled }
        nightEnd={ night.end.format() }
        scope={ scope } />
      <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, borderTop: 1, borderColor: 'divider', pt: '4px' } }>
        <Box sx={ { display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 auto', minHeight: 44 } }>
          <NotificationsNone aria-hidden sx={ { fontSize: 18, color: palette.text.tertiary, flex: 'none' } }/>
          <Typography component="span" sx={ { fontSize: 15, color: 'text.secondary' } }>
            { disabled ? 'Recurring alarms skipped'
              : replacementFinished ? 'Recurring alarms replaced for this night'
                : <>Alarm { alarmDay } at { moment(time, 'HH:mm').format('h:mm A') }</> }
          </Typography>
        </Box>
        { /* Stays at the right edge when it wraps under the alarm line. */ }
        <Box sx={ { display: 'flex', ml: 'auto', mr: '-10px' } }>
          { !disabled && !replacementFinished && <Button sx={ shared.lampLink } onClick={ () => setOverrideOpen(true) }>Change</Button> }
          <Button sx={ shared.lampLink } onClick={ () => setDisabledOpen(true) }>{ disabled ? 'Restore alarm' : 'Skip' }</Button>
        </Box>
      </Box>
    </Alert>
  );
}
