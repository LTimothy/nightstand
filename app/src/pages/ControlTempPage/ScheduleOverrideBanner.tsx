import { useEffect, useState } from 'react';
import { Alert, Button, Typography, Box } from '@mui/material';
import moment from 'moment-timezone';
import { useQueryClient } from '@tanstack/react-query';

import { useSettings, postSettings } from '@api/settings.ts';
import { isSchedulePaused } from '@api/schedulePause.ts';
import { useAppStore } from '@state/appStore.tsx';
import { weight } from '@design/tokens';
import { formatPauseEnd } from './pauseTimes';

export default function ScheduleOverrideBanner() {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const queryClient = useQueryClient();
  const [isResuming, setIsResuming] = useState(false);

  const override = settings?.[side]?.scheduleOverrides?.temperatureSchedules;
  const isOverridden =
    !!override?.disabled && !!override.expiresAt && moment(override.expiresAt).isAfter(moment());

  const expiresAt = override?.expiresAt;
  const [, setExpired] = useState(0);
  // Re-render when the hold ends so the banner drops away without waiting on a refetch.
  useEffect(() => {
    if (!isOverridden || !expiresAt) return;
    const id = setTimeout(() => setExpired((n) => n + 1), Math.min(moment(expiresAt).diff(moment()) + 50, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [isOverridden, expiresAt]);

  // The pause notice on the Tonight card covers a paused side.
  if (!isOverridden || !settings || isSchedulePaused(settings, side, moment().toDate())) return null;

  const handleResume = async () => {
    setIsResuming(true);
    try {
      await postSettings({
        [side]: {
          scheduleOverrides: {
            temperatureSchedules: {
              disabled: false,
              expiresAt: '',
            },
          },
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['useSettings'] });
    } catch (err) {
      console.error(err);
    } finally {
      setIsResuming(false);
    }
  };

  return (
    <Alert
      severity="info"
      icon={ false }
      sx={ {
        width: '100%',
        backgroundColor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        '& .MuiAlert-message': { width: '100%' },
      } }
    >
      <Box display="flex" alignItems="center" justifyContent="space-between" gap={ 2 }>
        <Box>
          <Typography variant="body2" fontWeight={ weight.heading }>
            Holding your temperature
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Scheduled temperature changes resume at { formatPauseEnd(moment(override!.expiresAt), settings.timeZone) }
          </Typography>
        </Box>
        <Button
          variant="text"
          size="small"
          onClick={ handleResume }
          disabled={ isResuming }
        >
          Resume now
        </Button>
      </Box>
    </Alert>
  );
}
