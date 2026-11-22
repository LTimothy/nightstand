import { useState } from 'react';
import { Box, Button, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material';
import NotificationsNone from '@mui/icons-material/NotificationsNone';
import { palette, radius, sx as shared } from '@design/tokens';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { isSchedulePaused } from '@api/schedulePause.ts';
import { pendingOneOffText } from '../SchedulePage/oneOffAlarm';
import OneOffAlarmSection from '../SchedulePage/OneOffAlarmSection';
import { useAlarmNight } from './useAlarmNight';

export default function OneOffAlarmLine() {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const alarmNight = useAlarmNight(side);
  const [open, setOpen] = useState(false);
  if (!settings) return null;
  const text = pendingOneOffText(settings, side, new Date());
  // Offered only when nothing at all will ring: no one-time alarm, no recurring one, no pause notice.
  const empty = !text && alarmNight.ready && !alarmNight.night && !!settings.features?.oneOffAlarms
    && !settings[side].awayMode && !isSchedulePaused(settings, side, new Date());
  if (!text && !empty && !open) return null;
  return (
    <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, borderTop: 1, borderColor: 'divider', pt: '4px' } }>
      <Box sx={ { display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 auto', minHeight: 44 } }>
        <NotificationsNone aria-hidden sx={ { fontSize: 18, color: palette.text.tertiary, flex: 'none' } }/>
        <Typography component="span" sx={ { fontSize: 15, color: 'text.secondary' } }>
          { text ? `One-time alarm ${text}` : 'No alarm coming up' }
        </Typography>
      </Box>
      <Box sx={ { display: 'flex', ml: 'auto', mr: '-10px' } }>
        <Button sx={ shared.lampLink } onClick={ () => setOpen(true) }>{ text ? 'Edit' : 'Add one-time alarm' }</Button>
      </Box>
      <Dialog
        open={ open }
        onClose={ () => setOpen(false) }
        aria-labelledby="one-time-alarm-title"
        fullWidth
        maxWidth="sm"
        sx={ { '& .MuiDialog-container': { alignItems: 'flex-end' },
          '& .MuiDialog-paper': { m: 0, width: '100%', borderRadius: `${radius.base}px ${radius.base}px 0 0` } } }>
        <DialogTitle id="one-time-alarm-title">One-time alarm</DialogTitle>
        <DialogContent sx={ { pt: 1 } }>
          <OneOffAlarmSection startEnabled={ !text } onSaved={ () => setOpen(false) }/>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
