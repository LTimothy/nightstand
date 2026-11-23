import { Box, Button, Typography } from '@mui/material';
import { useAppStore } from '@state/appStore.tsx';
import { postAlarm } from '@api/alarm.ts';
import { useEffect, useState } from 'react';
import { useSettings } from '@api/settings';
import type { Alarm } from '@api/schedulesSchema';

const TEST_DURATION_SECONDS = 10;

// Test windows outlive the sheet, so closing and reopening it cannot start a second test.
const testEndsAt: Partial<Record<string, number>> = {};
const remainingMs = (side: string) => Math.max(0, (testEndsAt[side] ?? 0) - Date.now());
// Only the latest press may report a failure; an older request must not clear a newer test.
const latestPress: Partial<Record<string, number>> = {};

export default function AlarmTest({ vibrationIntensity, vibrationPattern }: Pick<Alarm, 'vibrationIntensity' | 'vibrationPattern'>) {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const sleeper = settings?.[side]?.name;
  const [isTesting, setIsTesting] = useState(() => remainingMs(side) > 0);
  const [error, setError] = useState('');

  useEffect(() => {
    setIsTesting(remainingMs(side) > 0);
    if (remainingMs(side) === 0) return;
    const timer = setTimeout(() => setIsTesting(false), remainingMs(side));
    return () => clearTimeout(timer);
  }, [side, isTesting]);

  const onTestAlarm = () => {
    if (remainingMs(side) > 0) return;
    setError('');
    const press = (latestPress[side] ?? 0) + 1;
    latestPress[side] = press;
    testEndsAt[side] = Date.now() + TEST_DURATION_SECONDS * 1_000;
    setIsTesting(true);

    postAlarm({
      side,
      vibrationIntensity,
      duration: TEST_DURATION_SECONDS,
      vibrationPattern,
      force: true,
    }).catch(failure => {
      console.error(failure);
      if (latestPress[side] !== press) return;
      testEndsAt[side] = 0;
      setIsTesting(false);
      setError('Could not start the test. Try again.');
    });
  };

  return (
    <Box
      sx={ {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1,
      } }
    >
      { error && <Typography role="alert" color="error" variant="body2">{ error }</Typography> }

      <Button
        variant="outlined"
        onClick={ onTestAlarm }
        disabled={ isTesting }
      >
        { isTesting ? 'Alarm running now...' : `Test on ${sleeper ? `${sleeper}'s side` : `${side} side`}` }
      </Button>
    </Box>
  );
}
