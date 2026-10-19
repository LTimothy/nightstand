import { LineChart } from '@mui/x-charts/LineChart';
import { Box } from '@mui/material';
import { useResizeDetector } from 'react-resize-detector';
import { palette } from './tokens';

// A null value is a hole in the readings; the line breaks there.
export type TimeSeriesPoint = {
  timestamp: Date;
  value: number | null;
};

type TimeSeriesChartProps = {
  data: TimeSeriesPoint[];
  height?: number;
  startTime?: string;
  endTime?: string;
  /** Format an x-axis tick in the Pod's time zone. */
  xValueFormatter: (date: Date) => string;
  /** Format a y-axis tick. Default = integer string. */
  yValueFormatter?: (n: number) => string;
  /** Color of the line. */
  lineColor?: string;
};

export default function TimeSeriesChart({
  data,
  height = 220,
  xValueFormatter,
  yValueFormatter,
  startTime,
  endTime,
  lineColor = palette.lamp,
}: TimeSeriesChartProps) {
  const { width = 320, ref } = useResizeDetector();
  const fmtY = yValueFormatter ?? ((n: number) => Math.round(n).toString());

  // Compute Y-axis range: pad slightly above/below data.
  const values = data.map((p) => p.value).filter((v): v is number => Number.isFinite(v));
  const dataMin = values.length ? Math.min(...values) : 0;
  const dataMax = values.length ? Math.max(...values) : 1;
  const ySpan = dataMax - dataMin || 1;
  const padded = [dataMin - ySpan * 0.1, dataMax + ySpan * 0.1];
  // A reading with no neighbour draws no line, so it gets a mark of its own.
  const lone = data.map((point, index) => point.value !== null
    && (data[index - 1]?.value ?? null) === null && (data[index + 1]?.value ?? null) === null);

  return (
    <Box ref={ ref } sx={ { width: '100%', position: 'relative', touchAction: 'pan-y' } }>
      <LineChart
        width={ width }
        height={ height }
        margin={ { top: 12, bottom: 32, left: 38, right: 24 } }
        colors={ [lineColor] }
        dataset={ data.map((p) => ({ ...p })) }
        xAxis={ [{
          dataKey: 'timestamp',
          scaleType: 'time',
          min: startTime ? new Date(startTime) : undefined,
          max: endTime ? new Date(endTime) : undefined,
          tickNumber: 3,
          valueFormatter: (v) => xValueFormatter(v as Date),
          tickLabelStyle: { fill: palette.text.tertiary, fontSize: 12 },
          stroke: 'transparent',
          tickSize: 0,
        }] }
        yAxis={ [{
          min: padded[0],
          max: padded[1],
          position: 'left',
          valueFormatter: fmtY,
          tickLabelStyle: { fill: palette.text.tertiary, fontSize: 12 },
          stroke: 'transparent',
          tickSize: 0,
        }] }
        grid={ { horizontal: true, vertical: true } }
        series={ [{
          dataKey: 'value',
          showMark: ({ index }) => lone[index],
          curve: 'linear',
          valueFormatter: (v) => (v == null ? '' : fmtY(v)),
        }] }
        sx={ {
          '& .MuiChartsAxis-line': { stroke: 'transparent' },
          '& .MuiChartsAxis-tick': { stroke: 'transparent' },
          '& .MuiChartsGrid-line': {
            stroke: palette.border.subtle,
            strokeDasharray: '2 4',
          },
          '& .MuiLineElement-root': {
            strokeWidth: 1.5,
          },
          '& .MuiMarkElement-root': {
            stroke: lineColor,
            strokeWidth: 1,
            fill: palette.bg.base,
            r: 1.5,
          },
          '& .MuiChartsLegend-root': { display: 'none' },
        } }
      />
    </Box>
  );
}
