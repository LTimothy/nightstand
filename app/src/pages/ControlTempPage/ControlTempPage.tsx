import { useEffect } from 'react';
import { Alert, Box } from '@mui/material';

import AlarmDismissal from './AlarmDismissal.tsx';
import AnalyzeLastNightPrompt from './AnalyzeLastNightPrompt.tsx';
import UpcomingNight from './UpcomingNight.tsx';
import PageHeader from '@components/PageHeader';
import BedTabs from '@components/BedTabs';
import ErrorBoundary from '@components/ErrorBoundary.tsx';
import LastNightChip from './LastNightChip.tsx';
import LastNightSummary from './LastNightSummary.tsx';
import PageContainer from '../PageContainer.tsx';
import PowerRow from './PowerRow.tsx';
import ScheduleOverrideBanner from './ScheduleOverrideBanner.tsx';
import SideControl from '../../components/SideControl.tsx';
import TemperatureDial from './TemperatureDial.tsx';
import WaterNotification from './WaterNotification.tsx';
import { useAppStore } from '@state/appStore.tsx';
import { useControlTempStore } from './controlTempStore.tsx';
import { useLastNight } from './useLastNight.ts';
import { useBedFrame } from './useBedFrame';
import { NOT_RESPONDING } from './bedText';
import { media } from '@design/tokens';
import { BED_MAX_WIDTH, BED_PADDING_X } from '@components/pageRail';
import { useSettings } from '@api/settings.ts';
import { isSchedulePaused } from '@api/schedulePause.ts';
import useTemperatureFormat from '@lib/useTemperatureFormat';

const STALE_TILES = { left: NOT_RESPONDING, right: NOT_RESPONDING };
const LOADING_TILES = { left: '', right: '' };
const pageSx = {
  [media.short]: { gap: 1, pt: 1 },
  [media.tight]: { gap: 0.5, pt: 0.5 },
  [media.desktop]: { maxWidth: BED_MAX_WIDTH, px: BED_PADDING_X, pt: '24px', pb: '40px' },
} as const;
const tabsSx = { width: '100%', [media.desktop]: { maxWidth: 440, alignSelf: 'flex-start' } } as const;
// One column on a phone. On a desktop the controls take 440 px and Tonight the rest, both from the top.
const gridSx = {
  display: 'grid', width: '100%', rowGap: 2, alignItems: 'start', gridTemplateColumns: 'minmax(0, 1fr)',
  [media.desktop]: { gridTemplateColumns: '440px minmax(0, 1fr)', columnGap: '48px' },
} as const;
const controlColumnSx = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%',
  gap: 2, [media.short]: { gap: 1 }, [media.tight]: { gap: 0.5 },
} as const;

export default function ControlTempPage() {
  const { refetch, data: deviceStatus, dataUpdatedAt, frame } = useBedFrame();
  const syncFromServer = useControlTempStore((state) => state.syncFromServer);
  const { data: settings, isError: settingsError } = useSettings();
  const format = useTemperatureFormat();
  const { side } = useAppStore();
  const commandError = useControlTempStore((state) => state.commandError);
  const setCommandError = useControlTempStore((state) => state.setCommandError);

  // Stale keeps the last known values; the page never drops the dial.
  const staleSince = frame.kind === 'stale' ? frame.since : undefined;
  const loading = frame.kind === 'loading';
  const sideStatus = frame.kind === 'loading' ? undefined : frame.status;
  const isOn = sideStatus?.isOn ?? false;
  const lastNight = useLastNight();
  const away = !!settings?.[side]?.awayMode;
  // Away wins over a pause, as on the side tiles.
  const paused = !away && !!settings && isSchedulePaused(settings, side, new Date());
  // While off or away, last night moves up into the steppers' row under the dial.
  const lastNightUnderDial = !!sideStatus && (!isOn || away);

  useEffect(() => {
    refetch();
  }, [side]);

  useEffect(() => {
    setCommandError(undefined);
    return () => setCommandError(undefined);
  }, [side, setCommandError]);

  // Every answer, even one equal to the last: a write the Pod ignored leaves the data unchanged, and only the
  // resync clears the edit it still shows as pending.
  useEffect(() => {
    if (!deviceStatus) return;
    syncFromServer(deviceStatus);
  }, [deviceStatus, dataUpdatedAt, syncFromServer]);

  return (
    <PageContainer sx={ pageSx }>
      <PageHeader
        title="Bed"
        status={ staleSince ? NOT_RESPONDING : deviceStatus?.isPriming ? 'Priming' : undefined }
        tone={ staleSince ? 'warn' : undefined }/>
      <Box sx={ tabsSx }><BedTabs /></Box>
      { settingsError && <Alert severity="warning" sx={ { width: '100%' } }>
        Bed preferences are unavailable. { settings ? 'Using the last known preferences.' : 'Temperatures are shown in Fahrenheit.' }
      </Alert> }
      <Box sx={ gridSx }>
        <Box data-bed-controls sx={ controlColumnSx }>
          <SideControl compact={ false } captions={ loading ? LOADING_TILES : staleSince ? STALE_TILES : undefined }/>
          <TemperatureDial
            status={ sideStatus }
            loading={ loading }
            staleSince={ staleSince }
            away={ away }
            paused={ paused }
            refetch={ refetch }
            format={ format }
            whenOff={ <ErrorBoundary componentName="Last night summary">
              <LastNightSummary lastNight={ lastNight } />
            </ErrorBoundary> }/>
          <PowerRow isOn={ isOn } refetch={ refetch } loading={ loading } onRetry={ staleSince ? () => void refetch() : undefined }/>
          { commandError && <Alert severity="error" sx={ { width: '100%' } }>{ commandError }</Alert> }
        </Box>
        <Box sx={ { display: 'flex', flexDirection: 'column', gap: 2, width: '100%' } }>
          <ErrorBoundary componentName="Schedule override banner">
            <ScheduleOverrideBanner />
          </ErrorBoundary>
          <WaterNotification />
          <ErrorBoundary componentName="Alarm notification">
            <UpcomingNight />
          </ErrorBoundary>
          { !loading && !lastNightUnderDial && <ErrorBoundary componentName="Last night chip">
            <LastNightChip lastNight={ lastNight } />
          </ErrorBoundary> }
          <ErrorBoundary componentName="Analyze last night">
            <AnalyzeLastNightPrompt />
          </ErrorBoundary>
        </Box>
      </Box>
      <AlarmDismissal refetch={ refetch } />
    </PageContainer>
  );
}
