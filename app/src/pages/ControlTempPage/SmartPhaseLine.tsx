import { Fragment } from 'react';
import { Box, Typography } from '@mui/material';
import { useRhythmsLive } from '@api/rhythms';
import { useSettings } from '@api/settings';
import type { ResolvedSleepResponse } from '@api/rhythmsResponse';
import type { Side } from '@state/appStore';
import { fahrenheitToLevel } from '@lib/temperatureConversions';
import { smartLineForSleep } from './smartPhase';
import { STALE_AFTER_MS } from './bedFrame';
import { tonightLineSx } from './tonightStyles';
import { useDeviceFreshness } from './useDeviceFreshness';
import useTemperatureFormat from '@lib/useTemperatureFormat';

// A Smart Schedule hold lives in the server's memory, not in settings, so the
// hold and the delayed cool-down come from GET /rhythms/live.
export default function SmartPhaseLine({ sleep, side }: { sleep: ResolvedSleepResponse; side: Side }) {
  const { data: settings } = useSettings();
  const format = useTemperatureFormat();
  const { data: deviceStatus, frameFor } = useDeviceFreshness();
  const frame = frameFor(side);
  const { data: live, isError: liveFailed, dataUpdatedAt: liveAt } = useRhythmsLive(side);
  if (!settings) return null;
  const now = new Date();
  // Tonight's answer from the server, while it is recent.
  const night = !liveFailed && live?.date === sleep.date && now.getTime() - liveAt <= STALE_AFTER_MS ? live : undefined;
  const target = deviceStatus?.[side]?.targetTemperatureF;
  const until = night?.hold ? new Date(night.hold.until) : undefined;
  const inCurve = !!smartLineForSleep(sleep, { now, timeZone: settings.timeZone, format, waiting: false,
    runtime: 'live' });
  // While the bed is not responding, its caption already says schedules may not run.
  const line = frame.kind === 'live' && smartLineForSleep(sleep, {
    now,
    timeZone: settings.timeZone,
    format,
    waiting: !!night?.waiting,
    runtime: night ? 'live' : 'unknown',
    coolStart: night ? new Date(night.coolStart) : undefined,
    hold: until && until > now && target !== undefined ? { level: fahrenheitToLevel(target), until } : undefined,
    base: night?.baseSince && sleep.smart ? { level: sleep.smart.baseLevel, since: new Date(night.baseSince) } : undefined,
  });
  // Within the night's curve the line keeps its place while it has nothing it can say, so the card does not move.
  if (!line) return inCurve ? <Typography sx={ tonightLineSx } aria-hidden>{ '\u00a0' }</Typography> : null;
  // "wake-up" never breaks at its hyphen.
  const parts = line.split('wake-up');
  return <Typography sx={ tonightLineSx }>
    { parts.map((part, index) => <Fragment key={ index }>
      { index > 0 && <Box component="span" sx={ { whiteSpace: 'nowrap' } }>wake-up</Box> }
      { part }
    </Fragment>) }
  </Typography>;
}
