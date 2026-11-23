import { useEffect, useState } from 'react';
import moment from 'moment-timezone';
import { Alert, Box, Button, Typography } from '@mui/material';
import { postSettings, useSettings } from '@api/settings.ts';
import { isSchedulePaused, pauseEndsAt } from '@api/schedulePause.ts';
import { serverMessage } from '@lib/requestError';
import { sx as shared, weight } from '@design/tokens';
import { tonightLineSx } from './tonightStyles';
import { useAppStore } from '@state/appStore.tsx';
import { formatPauseEnd } from './pauseTimes';

// `detail` says what comes back when the pause ends, for example "Back on schedule tomorrow at 10:00 PM (Workday)".
export default function SchedulePauseNotice({ note, detail, framed = false, onResumed }: {
  note?: string; detail?: string; framed?: boolean; onResumed?: () => void;
}) {
  const { side } = useAppStore();
  const { data: settings, refetch } = useSettings();
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState('');
  // Re-render every 30s so the notice goes away when the pause ends.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(value => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => setError(''), [side]);

  if (!settings || !isSchedulePaused(settings, side, moment().toDate())) return null;
  const end = pauseEndsAt(settings, side);
  const title = end
    ? `Schedule paused until ${formatPauseEnd(moment(end), settings.timeZone)}`
    : 'Schedule paused until you resume';

  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    setError('');
    try {
      await postSettings({ [side]: { scheduleOverrides: { pause: { active: false, expiresAt: '' } } } });
      const { data: fresh } = await refetch();
      // This notice unmounts once the pause clears; the caller places focus after it is gone.
      if (onResumed && fresh && !isSchedulePaused(fresh, side, moment().toDate())) onResumed();
    } catch (err) {
      console.error(err);
      setError(serverMessage(err) ?? 'Could not resume the schedule. Try again.');
    } finally {
      setResuming(false);
    }
  };

  return (
    <Box
      sx={ {
        width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5,
        ...(framed ? { p: 2, border: 1, borderColor: 'divider', borderRadius: 1 } : {}),
      } }>
      <Typography variant="body2" fontWeight={ weight.heading }>{ title }</Typography>
      { detail && <Typography variant="body2" color="text.secondary" sx={ { ...tonightLineSx, m: 0 } }>{ detail }</Typography> }
      { note && <Typography variant="body2" color="text.secondary" sx={ { ...tonightLineSx, m: 0 } }>{ note }</Typography> }
      { error && <Alert severity="error" sx={ { width: '100%' } }>{ error }</Alert> }
      { /* aria-disabled, not disabled, so keyboard focus stays on the button */ }
      <Button
        data-pause-control
        onClick={ resume }
        aria-disabled={ resuming || undefined }
        sx={ { ...shared.lampLink, ml: '-10px', ...(resuming ? { opacity: 0.6 } : {}) } }>
        Resume schedule
      </Button>
    </Box>
  );
}
