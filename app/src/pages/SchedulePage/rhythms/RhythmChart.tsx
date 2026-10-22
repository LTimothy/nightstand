// One rhythm's schedule with a typical night where it differs, as inline SVG stretched to the card. Every label is
// HTML beside or over it, so text keeps its size at every card width.
import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { NightLog, Rhythm } from '@api/rhythmsSchema';
import { MIN_NIGHTS } from '@api/suggestionRules';
import { fahrenheitToDisplay, type TemperatureFormat } from '@lib/temperatureConversions';
import { palette, weight } from '@design/tokens';
import { clockAfterOn, yTickLabel, type Step } from './nightsChartModel';
import { BLOCK_OPACITY, rhythmOverlay, type Block } from './rhythmOverlay';
import { nightsSoFar, pairTemperatures, typicalNightText } from './suggestionsCopy';

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
// A block carries its printed value when it is this share of the night wide and the two lines this far apart (of 100).
const LABEL_WIDTH = 0.12;
const LABEL_GAP = 12;
const round = (value: number) => Math.round(value * 100) / 100;
const stroke = { fill: 'none', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' } as const;
const axisText = { variant: 'caption', color: 'text.secondary', sx: { lineHeight: '12px', fontSize: 12 } } as const;

export default function RhythmChart({ rhythm, log, today, timeZone, format, trackingOn, captionId }: Props) {
  const { endMin, loF, hiF, plan, nights, drawn, blocks } = useMemo(() => rhythmOverlay({ rhythm, log, today, timeZone, trackingOn }),
    [rhythm, log, today, timeZone, trackingOn]);
  const { on } = rhythm.night.power;
  const smart = rhythm.temperatureMode === 'smart';
  const x = (minutes: number) => round((minutes / endMin) * 100);
  // Display units, as NightsChart plots them, so a level or Celsius label sits where its value is drawn.
  const lo = fahrenheitToDisplay(loF, format);
  const hi = fahrenheitToDisplay(hiF, format);
  const y = (f: number) => round(((hi - fahrenheitToDisplay(f, format)) / (hi - lo)) * 100);
  const steps = (points: Step[], end: number) =>
    [`M ${x(points[0].x)} ${y(points[0].f)}`, ...points.slice(1).map(point => `H ${x(point.x)} V ${y(point.f)}`), `H ${x(end)}`].join(' ');
  // The block is the space between the typical night's flat run and the schedule's steps under or over it.
  const outline = ({ from, to, f, schedule }: Block) => {
    const back = [...schedule].reverse();
    return [`M ${x(from)} ${y(f)} H ${x(to)} V ${y(back[0].f)}`,
      ...back.map((step, index) => `H ${x(step.x)}${index + 1 < back.length ? ` V ${y(back[index + 1].f)}` : ''}`), 'Z'].join(' ');
  };
  const tone = (block: Block) => (block.f < block.schedule[0].f ? palette.step.cool : palette.step.warm);
  const label = (block: Block) => {
    const middle = (block.from + block.to) / 2;
    const planned = block.schedule.reduce((value, step) => (step.x <= middle ? step.f : value), block.schedule[0].f);
    const gap = Math.abs(y(block.f) - y(planned));
    // A schedule step under the label's span would run through it.
    const crossed = block.schedule.slice(1).some(step => Math.abs(step.x - middle) < (LABEL_WIDTH / 2) * endMin);
    if ((block.to - block.from) / endMin < LABEL_WIDTH || gap < LABEL_GAP || crossed) return null;
    return { left: x(middle), top: (y(block.f) + y(planned)) / 2, text: pairTemperatures(planned, block.f, format)[1] };
  };
  const top = Math.round(fahrenheitToDisplay(hiF, format));
  const tick = (f: number) => yTickLabel(Math.round(fahrenheitToDisplay(f, format)), top, format);
  return <Box sx={ { width: '100%' } }>
    <Box sx={ { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 0.75, rowGap: 0.5 } }>
      <Box sx={ { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', my: '-6px' } }>
        { [hiF, (hiF + loF) / 2, loF].map((f, index) => <Typography key={ index } { ...axisText }>{ tick(f) }</Typography>) }
      </Box>
      <Box sx={ { position: 'relative' } }>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={ { display: 'block', width: '100%', height: HEIGHT, overflow: 'visible' } }>
          { blocks.map(block => <path key={ block.from } data-block d={ outline(block) } fill={ tone(block) } fillOpacity={ BLOCK_OPACITY }/>) }
          { plan.length > 0 && <path data-schedule d={ steps(plan, endMin) } stroke={ palette.step.plan } strokeWidth={ 2 } { ...stroke }/> }
          { blocks.map(block => <path
            key={ block.from }
            data-typical
            d={ `M ${x(block.from)} ${y(block.schedule[0].f)} V ${y(block.f)} H ${x(block.to)}` }
            stroke={ tone(block) }
            strokeWidth={ 1.5 }
            strokeDasharray="3 2"
            { ...stroke }/>) }
        </svg>
        { blocks.flatMap(block => {
          const placed = label(block);
          return placed ? [<Typography
            key={ block.from }
            component="span"
            aria-hidden
            data-block-label
            sx={ {
              position: 'absolute', left: `${placed.left}%`, top: `${placed.top}%`, transform: 'translate(-50%, -50%)',
              fontSize: 11, lineHeight: 1, fontWeight: weight.medium, color: 'text.primary', pointerEvents: 'none', whiteSpace: 'nowrap',
            } }>
            { placed.text }
          </Typography>] : [];
        }) }
      </Box>
      <Box/>
      <Box sx={ { display: 'flex', justifyContent: 'space-between' } }>
        { [0, endMin / 2, endMin].map(minutes => <Typography key={ minutes } { ...axisText }>{ clockAfterOn(on, minutes) }</Typography>) }
      </Box>
    </Box>
    { /* Always rendered, so the card's aria-describedby never points at nothing. */ }
    <Typography id={ captionId } variant="caption" color="text.secondary" sx={ { display: 'block', mt: nights > 0 ? 1 : 0 } }>
      { /* Compared only once five nights can be drawn, so a match is never claimed unchecked. */ }
      { nights > 0 && (drawn < MIN_NIGHTS ? nightsSoFar(nights) : typicalNightText(blocks, on, format, smart)) }
    </Typography>
  </Box>;
}
