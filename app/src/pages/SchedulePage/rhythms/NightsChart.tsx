/* eslint-disable react/no-multi-comp */
// The clip marks, the step label and the legend are private to this chart; the first two need its scales.
import { useMemo } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { LineChart } from '@mui/x-charts/LineChart';
import { useDrawingArea, useXScale, useYScale } from '@mui/x-charts/hooks';
import type { NightLog, Rhythm, SuggestionRow } from '@api/rhythmsSchema';
import { fahrenheitToDisplay, fahrenheitToLevel, type TemperatureFormat } from '@lib/temperatureConversions';
import { temperatureColor } from '@lib/temperatureColor';
import { palette } from '@design/tokens';
import { clockAfterOn, nightsChartModel, yTickLabel, type ChartLine, type ClipMark } from './nightsChartModel';
import { CHART_LEGEND, chartCaption, pairTemperatures } from './suggestionsCopy';

type Props = {
  rhythm: Rhythm;
  after: Rhythm;
  nights: NightLog[];
  rows: SuggestionRow[];
  timeZone: string;
  format: TemperatureFormat;
  evidence: string;
};

function ClipMarks({ marks }: { marks: ClipMark[] }) {
  const { top, height } = useDrawingArea();
  const xScale = useXScale<'linear'>();
  return <>{ marks.map(({ x, edge }) => {
    const center = xScale(x) ?? 0;
    const y = edge === 'top' ? top : top + height;
    const tip = edge === 'top' ? y - 5 : y + 5;
    const shape = `M ${center - 4} ${y} L ${center + 4} ${y} L ${center} ${tip} Z`;
    return <path key={ `${edge}-${x}` } d={ shape } fill={ palette.text.secondary }/>;
  }) }</>;
}

function StepLabel({ x, y, text }: { x: number; y: number; text: string }) {
  const xScale = useXScale<'linear'>();
  const yScale = useYScale<'linear'>();
  return <text x={ (xScale(x) ?? 0) + 4 } y={ (yScale(y) ?? 0) - 6 } fontSize={ 12 } fill={ palette.text.primary }>{ text }</text>;
}

function Legend({ line, text }: { line: string; text: string }) {
  return <Stack direction="row" spacing={ 0.75 } alignItems="center">
    <Box sx={ { width: 16, borderTop: line } }/>
    <Typography variant="caption" color="text.secondary">{ text }</Typography>
  </Stack>;
}

const strokeOf = (line: ChartLine, changeColor: string) => {
  if (line.kind === 'plan') return palette.text.secondary;
  if (line.kind === 'change') return changeColor;
  if (line.direction === 'down') return palette.step.cool;
  return line.direction === 'up' ? palette.step.warm : palette.border.control;
};

// One line per counted night over the plan, with the night as it would be with the checked rows.
export default function NightsChart({ rhythm, after, nights, rows, timeZone, format, evidence }: Props) {
  const model = useMemo(() => nightsChartModel({ rhythm, after, nights, rows, timeZone }), [rhythm, after, nights, rows, timeZone]);
  const counted = nights.filter(night => !night.excluded && !night.tonight && night.samePlan !== false);
  const caption = chartCaption(counted, rows.flatMap(row => row.supportingDates));
  const changeColor = temperatureColor(fahrenheitToLevel(model.label?.f ?? after.night.power.onTemperature));
  const lo = fahrenheitToDisplay(model.loF, format);
  const hi = fahrenheitToDisplay(model.hiF, format);
  const axisText = { fill: palette.text.secondary, fontSize: 12 };
  return <Box role="figure" aria-label={ `${evidence} ${caption}` } sx={ { width: '100%' } }>
    <Box aria-hidden>
      <LineChart
        height={ 160 }
        xAxis={ [{
          scaleType: 'linear', data: model.xs, min: 0, max: model.endMin, tickInterval: model.ticks, tickLabelStyle: axisText,
          valueFormatter: (value: number) => clockAfterOn(rhythm.night.power.on, value),
        }] }
        yAxis={ [{
          min: lo, max: hi, tickInterval: [lo, hi], tickLabelStyle: axisText, valueFormatter: (value: number) => yTickLabel(value, hi, format),
        }] }
        series={ model.lines.map(line => ({
          id: line.id, data: line.values.map(value => fahrenheitToDisplay(value, format)), curve: 'stepAfter' as const, showMark: false,
          color: strokeOf(line, changeColor),
        })) }
        margin={ { right: 16, left: 44, top: 12, bottom: 24 } }
        slotProps={ { legend: { hidden: true } } }
        sx={ {
          '& .MuiLineElement-root': { strokeWidth: 1 },
          '& .MuiLineElement-series-plan': { strokeDasharray: '4 4' },
          '& .MuiLineElement-series-change': { strokeWidth: 3 },
        } }>
        <ClipMarks marks={ model.clips }/>
        { model.label && <StepLabel
          x={ model.label.x }
          y={ fahrenheitToDisplay(model.label.f, format) }
          text={ pairTemperatures(model.label.fromF, model.label.f, format)[1] }/> }
      </LineChart>
      <Stack direction="row" spacing={ 2 } sx={ { mt: 0.5, flexWrap: 'wrap' } }>
        <Legend line={ `4px solid ${changeColor}` } text={ CHART_LEGEND.change }/>
        <Legend line={ `1px solid ${palette.border.control}` } text={ CHART_LEGEND.night }/>
        <Legend line={ `2px dashed ${palette.text.secondary}` } text={ CHART_LEGEND.now }/>
      </Stack>
    </Box>
    <Typography variant="caption" color="text.secondary" sx={ { display: 'block', mt: 0.5 } }>{ caption }</Typography>
  </Box>;
}
