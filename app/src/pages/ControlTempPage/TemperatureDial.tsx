import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import StatusText from '@components/StatusText';
import { useAppStore } from '@state/appStore';
import { useSettings } from '@api/settings.ts';
import { media, palette } from '@design/tokens';
import { fahrenheitToLevel, type TemperatureFormat } from '@lib/temperatureConversions.ts';
import { temperatureColor } from '@lib/temperatureColor';
import { lastKnownAt } from './bedText';
import CaptionSlot from './CaptionSlot';
import { useControlTempStore } from './controlTempStore.tsx';
import DialRing from './DialRing';
import { DIAL_HEIGHT, DIAL_WIDTH } from './dialGeometry';
import TemperatureButtons from './TemperatureButtons.tsx';
import type { DialStatus } from './bedFrame.ts';
import TemperatureLabel, { centreSx } from './TemperatureLabel.tsx';
import { usePendingGrey } from './usePendingGrey';

type TemperatureDialProps = {
  // The side's status: live, or the last known one while staleSince is set.
  status?: DialStatus;
  staleSince?: Date;
  // Nothing to show yet: every slot keeps its size.
  loading?: boolean;
  // An away side that is on follows the other side; it shows last night instead of steppers.
  away?: boolean;
  // A side whose schedule is paused: its value is drawn grey, like the side tile's.
  paused?: boolean;
  refetch: () => unknown;
  format: TemperatureFormat;
  // Shown on the controls row while the side is off.
  whenOff?: ReactNode;
};

const columnSx = { width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' } as const;
// On a short screen the dial gives up height first, down to 180 px wide, so the power row stays clear of the
// bottom bar. The budget is the rest of the trimmed column plus the bar, its scroll padding and a margin. Small
// viewport units, so the dial does not grow when a mobile browser's toolbar collapses on scroll. Below about
// 550 px of height (a phone on its side) even the smallest dial does not fit, and the page scrolls.
const fitWidth = (cap: number, budget: number) =>
  `min(${cap}px, 100%, max(180px, (100svh - ${budget}px) * ${DIAL_WIDTH} / ${DIAL_HEIGHT}))`;
const dialSx = {
  position: 'relative', flex: 'none', mx: 'auto', mt: '14px', aspectRatio: `${DIAL_WIDTH} / ${DIAL_HEIGHT}`,
  width: 'min(300px, 100%, 40svh)', containerType: 'inline-size',
  [media.short]: { mt: '4px', width: fitWidth(300, 493) },
  [media.tight]: { mt: 0, width: fitWidth(300, 422) },
  [media.desktop]: { mt: '10px', width: 320 },
  [media.desktopShort]: { mt: '4px', width: fitWidth(320, 493) },
  // The ring's end labels scale with it; keep them about 10 px tall on the smaller dials.
  '@container (max-width: 259.95px)': { '& [data-end-label]': { fontSize: 13 } },
  '@container (max-width: 219.95px)': { '& [data-end-label]': { fontSize: 16 } },
} as const;
// One height whatever it holds, so nothing under it moves when the side turns on or off.
const controlsRowSx = {
  width: '100%', height: 86, mt: '8px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  [media.narrow]: { height: 78 },
  [media.desktop]: { mt: '10px' },
  [media.short]: { height: 78, mt: '6px' },
  [media.tight]: { height: 67, mt: '2px' },
} as const;

export default function TemperatureDial({
  status, staleSince, loading = false, away = false, paused = false, refetch, format, whenOff,
}: TemperatureDialProps) {
  const { side } = useAppStore();
  const { data: settings } = useSettings();
  const stored = useControlTempStore(state => state.deviceStatus?.[side]?.targetTemperatureF);
  const stale = !!staleSince;
  const isOn = !!status?.isOn;
  // A last known target is the Pod's own, never an edit it did not take.
  const target = (stale ? undefined : stored) ?? status?.targetTemperatureF ?? 0;
  const targetLevel = fahrenheitToLevel(target);
  // An edit the Pod has not reported back yet.
  const pending = isOn && !stale && !!status && target !== status.targetTemperatureF;
  const unconfirmed = usePendingGrey(pending, target);
  return <Box sx={ columnSx }>
    <Box data-dial sx={ dialSx }>
      <DialRing
        isOn={ isOn }
        stale={ stale }
        away={ away }
        paused={ paused }
        pending={ pending }
        unconfirmed={ unconfirmed }
        targetLevel={ targetLevel }
        currentLevel={ fahrenheitToLevel(status?.currentTemperatureF ?? target) }/>
      { loading && <Box sx={ centreSx }>
        <StatusText sx={ { fontSize: 15, color: palette.text.tertiary } }>Loading</StatusText>
      </Box> }
      { status && <TemperatureLabel
        isOn={ isOn }
        sliderTemp={ target }
        sliderColor={ away || paused || unconfirmed ? palette.text.secondary : temperatureColor(targetLevel) }
        currentTargetTemp={ status.targetTemperatureF }
        currentTemperatureF={ status.currentTemperatureF }
        currentLevel={ status.currentTemperatureLevel }
        format={ format }
        lastKnownAt={ staleSince && lastKnownAt(staleSince, settings?.timeZone) }/> }
    </Box>
    <CaptionSlot isOn={ isOn } staleSince={ staleSince } empty={ !status && !stale }/>
    <Box data-controls-row sx={ controlsRowSx }>
      { status && (isOn && !away
        ? <TemperatureButtons
          key={ side }
          statusUnavailable={ stale }
          refetch={ refetch }
          currentTargetTemp={ status.targetTemperatureF }/>
        : whenOff && <Box sx={ { width: '100%', height: '100%' } }>{ whenOff }</Box>) }
    </Box>
  </Box>;
}
