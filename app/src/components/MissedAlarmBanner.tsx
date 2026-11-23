import { useRef } from 'react';
import { Alert, Box, Button, Stack } from '@mui/material';
import moment from 'moment-timezone';
import { useSettings } from '@api/settings';
import { MissedAlarm, useDismissMissedAlarms, useMissedAlarms } from '@api/missedAlarms';
import { bannerRailSx } from './pageRail';

const ENDING: Record<MissedAlarm['reason'], string> = {
  'not-running': 'did not ring because Nightstand was not running.',
  late: 'did not ring because the Pod did not answer in time.',
  failed: 'did not ring because it could not be sent to the Pod.',
  'side-off': 'did not ring because that side was off.',
  error: 'did not ring because of an error in Nightstand.',
  unconfirmed: 'may not have rung: the Pod did not confirm it.',
};

const isShown = (item: MissedAlarm | null | undefined) => (
  !!item && Object.prototype.hasOwnProperty.call(ENDING, item.reason)
  && (item.side === 'left' || item.side === 'right') && moment(item.at).isValid()
);

// The live region is always mounted and empty until alarms arrive, so a screen
// reader announces them once instead of missing a region that appears with its
// text already inside.
export default function MissedAlarmBanner({ wide = false }: { wide?: boolean }) {
  const { data } = useMissedAlarms();
  const { data: settings, isPending } = useSettings();
  const dismiss = useDismissMissedAlarms();
  const region = useRef<HTMLDivElement>(null);
  const missed = isPending ? [] : (data ?? []).filter(isShown);
  const zone = settings?.timeZone ?? moment.tz.guess();
  return (
    <Box
      ref={ region }
      role="status"
      aria-live="polite"
      tabIndex={ -1 }
      sx={ { ...bannerRailSx(wide), outline: 'none', '&:empty': { mb: -2 } } }
    >
      { missed.length > 0 && (
        <Alert
          role="none"
          severity="warning"
          sx={ { flexWrap: { xs: 'wrap', sm: 'nowrap' }, '& .MuiAlert-message': { flexBasis: { xs: '100%', sm: 'auto' } } } }
          action={ (
            <Button
              color="inherit"
              aria-disabled={ dismiss.isPending }
              sx={ { opacity: dismiss.isPending ? 0.6 : 1 } }
              onClick={ () => {
                if (dismiss.isPending) return;
                dismiss.mutate(missed.map(item => item.id), { onSuccess: () => region.current?.focus() });
              } }
            >
              Dismiss
            </Button>
          ) }
        >
          <Stack spacing={ 0.5 }>
            { missed.map(item => (
              <span key={ item.id }>
                { `The ${moment.tz(item.at, zone).format('h:mm A')} alarm on the ${item.side} side ${ENDING[item.reason]}` }
              </span>
            )) }
            { dismiss.isError && <span>Could not dismiss. Try again.</span> }
          </Stack>
        </Alert>
      ) }
    </Box>
  );
}
