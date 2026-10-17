// One rhythm's schedule over its last nights, as inline SVG stretched to the card. The axis labels are HTML
// beside it, so they keep their size at every card width.
import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { NightLog, Rhythm } from '@api/rhythmsSchema';
import { fahrenheitToDisplay, type TemperatureFormat } from '@lib/temperatureConversions';
import { palette } from '@design/tokens';
import { clockAfterOn, yTickLabel, type Step } from './nightsChartModel';
import { NIGHT_OPACITY, rhythmOverlay, type OverlayNight } from './rhythmOverlay';
import { lastNightText, overlayCaption } from './suggestionsCopy';

type Props = {
  rhythm: Rhythm;
  log: NightLog[];
  today: string;
  timeZone: string;
  format: TemperatureFormat;
  trackingOn: boolean;
  captionId: string;
};

const HEIGHT = 110;
const round = (value: number) => Math.round(value * 100) / 100;
const strength = (index: number, night: OverlayNight) =>
  (night.dim || index >= 7 ? NIGHT_OPACITY.older : index === 0 ? NIGHT_OPACITY.last : NIGHT_OPACITY.recent);
const stroke = { fill: 'none', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' } as const;
const axisText = { variant: 'caption', color: 'text.secondary', sx: { lineHeight: '12px', fontSize: 12 } } as const;
// Read by screen readers, never seen; `sx` would read a bare 1 as 100 percent, so the sizes are strings.
const HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

export default function RhythmChart({ rhythm, log, today, timeZone, format, trackingOn, captionId }: Props) {
  const { endMin, loF, hiF, plan, nights } = useMemo(() => rhythmOverlay({ rhythm, log, today, timeZone, trackingOn }),
    [rhythm, log, today, timeZone, trackingOn]);
  const { on } = rhythm.night.power;
  const smart = rhythm.temperatureMode === 'smart';
  const x = (minutes: number) => round((minutes / endMin) * 100);
  const y = (f: number) => round(((hiF - f) / (hiF - loF)) * 100);
  const steps = (points: Step[], end: number) =>
    [`M ${x(points[0].x)} ${y(points[0].f)}`, ...points.slice(1).map(point => `H ${x(point.x)} V ${y(point.f)}`), `H ${x(end)}`].join(' ');
  const top = Math.round(fahrenheitToDisplay(hiF, format));
  const label = (f: number) => yTickLabel(Math.round(fahrenheitToDisplay(f, format)), top, format);
  return <Box sx={ { width: '100%' } }>
    <Box sx={ { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 0.75, rowGap: 0.5 } }>
      <Box sx={ { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', my: '-6px' } }>
        { [hiF, (hiF + loF) / 2, loF].map((f, index) => <Typography key={ index } { ...axisText }>{ label(f) }</Typography>) }
      </Box>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        style={ { display: 'block', width: '100%', height: HEIGHT, overflow: 'visible' } }>
        <path d="M 0 0 V 100 H 100" stroke={ palette.border.control } strokeWidth={ 1 } { ...stroke }/>
        { nights.map((night, index) => <path
          key={ night.date }
          data-night={ night.date }
          d={ steps(night.points, night.end) }
          stroke={ palette.text.primary }
          strokeOpacity={ strength(index, night) }
          strokeWidth={ index === 0 && !night.dim ? 2 : 1 }
          { ...stroke }/>).reverse() }
        { plan.length > 0 && <path data-schedule d={ steps(plan, endMin) } stroke={ palette.step.cool } strokeWidth={ 2.5 } { ...stroke }/> }
      </svg>
      <Box/>
      <Box sx={ { display: 'flex', justifyContent: 'space-between' } }>
        { [0, endMin / 2, endMin].map(minutes => <Typography key={ minutes } { ...axisText }>{ clockAfterOn(on, minutes) }</Typography>) }
      </Box>
    </Box>
    { nights.length > 0 && <Typography id={ captionId } variant="caption" color="text.secondary" sx={ { display: 'block', mt: 1 } }>
      { overlayCaption(nights.length, smart) }
      <Box component="span" sx={ HIDDEN }>{ ` ${lastNightText(nights[0].points, nights[0].end, on, format, smart)}` }</Box>
    </Typography> }
  </Box>;
}
