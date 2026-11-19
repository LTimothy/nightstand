import { Box, Button, Typography } from '@mui/material';
import NotificationsNone from '@mui/icons-material/NotificationsNone';
import { Link } from 'react-router-dom';
import { palette, sx as shared } from '@design/tokens';
import { useAppStore } from '@state/appStore.tsx';
import { useSettings } from '@api/settings.ts';
import { pendingOneOffText } from '../SchedulePage/oneOffAlarm';

export default function OneOffAlarmLine() {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const text = settings && pendingOneOffText(settings, side, new Date());
  if (!text) return null;
  return (
    <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, borderTop: 1, borderColor: 'divider', pt: '4px' } }>
      <Box sx={ { display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 auto', minHeight: 44 } }>
        <NotificationsNone aria-hidden sx={ { fontSize: 18, color: palette.text.tertiary, flex: 'none' } }/>
        <Typography component="span" sx={ { fontSize: 15, color: 'text.secondary' } }>One-time alarm { text }</Typography>
      </Box>
      <Box sx={ { display: 'flex', ml: 'auto', mr: '-10px' } }>
        <Button component={ Link } to="/schedules" sx={ shared.lampLink }>Edit</Button>
      </Box>
    </Box>
  );
}
