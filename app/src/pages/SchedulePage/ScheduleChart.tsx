/* eslint-disable react/no-multi-comp */
import moment from 'moment-timezone';
import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';
import { Paper } from '@mui/material';
import { LineChart, lineElementClasses, areaElementClasses } from '@mui/x-charts/LineChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { useDrawingArea } from '@mui/x-charts/hooks';

import { useScheduleStore } from './scheduleStore.tsx';
import { DailySchedule, Time } from '../../../../server/src/db/schedulesSchema.ts';
import { useSettings } from '@api/settings.ts';
import {
  fahrenheitToDisplay,
  formatDisplayValue,
  displayBounds,
  TemperatureFormat,
  fahrenheitToLevel,
  levelToFahrenheit,
  seriesValueFormatter,
  unitOf,
} from '@lib/temperatureConversions.ts';


import { temperatureColor } from '@lib/temperatureColor';
import { minutesSincePowerOn, temperatureInPowerWindow, timeInPowerWindow } from './scheduleValidation';
import useTemperatureFormat from '@lib/useTemperatureFormat';

export type Point = { x: Date; y: number; temperature: number; rowId: string };

const AREA_ALPHA = 0.20;
const LINE_ALPHA = 1.0;
export const CHART_END_PADDING_MS = 30 * 60 * 1000;

// ---------------- buildSeriesData (same as before) ----------------
const todayAt = (hhmm: Time, timeZone: string, dayOffset = 0) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  return moment.tz(timeZone).startOf('day').add(dayOffset, 'day').hour(hour).minute(minute).toDate();
};


const compareTime = (a: Time, b: Time) => {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return ah - bh || am - bm;
};

function buildSeriesData(selectedSchedule: DailySchedule, yMin: number, yMax: number, format: TemperatureFormat, timeZone: string): Point[] {
  if (!selectedSchedule?.power.enabled) return [];

  const { power, temperatures } = selectedSchedule;
  const wraps = compareTime(power.off, power.on) <= 0;

  const start = todayAt(power.on, timeZone);
  const end = todayAt(power.off, timeZone, wraps ? 1 : 0);

  const entries = Object.entries(temperatures).filter(([time]) => temperatureInPowerWindow(time, power)) as [Time, number][];
  const day0: [Date, number][] = [];
  const day1: [Date, number][] = [];

  for (const [t, temp] of entries.sort((a, b) => compareTime(a[0], b[0]))) {
    if (!wraps) {
      if (compareTime(t, power.on) >= 0 && compareTime(t, power.off) <= 0)
        day0.push([todayAt(t, timeZone), temp]);
    } else {
      if (compareTime(t, power.on) >= 0) day0.push([todayAt(t, timeZone), temp]);
      if (compareTime(t, power.off) <= 0) day1.push([todayAt(t, timeZone, 1), temp]);
    }
  }

  const points: Point[] = [{
    x: start,
    y: fahrenheitToDisplay(power.onTemperature, format), temperature: power.onTemperature, rowId: 'schedule-bedtime'
  }];
  const pushStep = (arr: [Date, number][]) => {
    for (const [dt, temp] of arr) {
      const convertedTemp = fahrenheitToDisplay(temp, format);

      if (dt.getTime() > points[points.length - 1].x.getTime()) {
        const time = moment(dt).tz(timeZone).format('HH:mm');
        points.push({ x: dt, y: convertedTemp, temperature: temp, rowId: `schedule-temperature-${time}` });
      } else {
        points[points.length - 1].y = convertedTemp;
      }
    }
  };
  pushStep(day0);
  pushStep(day1);

  const lastY = points[points.length - 1].y;
  if (end.getTime() > points[points.length - 1].x.getTime()) {
    points.push({
      x: end,
      y: lastY, temperature: points[points.length - 1].temperature, rowId: points[points.length - 1].rowId
    }
    );
  }

  for (const p of points) p.y = Math.min(yMax, Math.max(yMin, p.y));

  return points;
}

// ---------------- Horizontal gradient by time ----------------
export function HorizontalTempGradient({
  idArea,
  idLine,
  points,
  areaAlpha = AREA_ALPHA,
  lineAlpha = LINE_ALPHA,
}: {
  idArea: string;
  idLine: string;
  points: Point[];
  areaAlpha?: number;
  lineAlpha?: number;
}) {
  const { left, width, top } = useDrawingArea();
  const minX = points[0].x.getTime();
  const duration = points[points.length - 1].x.getTime() - minX;
  const stops = points.slice(0, -1).flatMap((point, index) => [
    { off: (point.x.getTime() - minX) / duration, color: temperatureColor(fahrenheitToLevel(point.temperature)) },
    { off: (points[index + 1].x.getTime() - minX) / duration, color: temperatureColor(fahrenheitToLevel(point.temperature)) },
  ]);

  return (
    <defs>
      <linearGradient
        id={ idArea }
        x1={ left }
        x2={ left + width * duration / (duration + CHART_END_PADDING_MS) }
        y1={ top }
        y2={ top }
        gradientUnits="userSpaceOnUse"
      >
        { stops.map((s, i) => (
          <stop key={ `a-${i}` } offset={ s.off } stopColor={ s.color } stopOpacity={ areaAlpha }/>
        )) }
      </linearGradient>
      <linearGradient
        id={ idLine }
        x1={ left }
        x2={ left + width * duration / (duration + CHART_END_PADDING_MS) }
        y1={ top }
        y2={ top }
        gradientUnits="userSpaceOnUse"
      >
        { stops.map((s, i) => (
          <stop key={ `l-${i}` } offset={ s.off } stopColor={ s.color } stopOpacity={ lineAlpha }/>
        )) }
      </linearGradient>
    </defs>
  );
}

// ---------------- Component ----------------
export default function TemperatureScheduleChart() {
  const { selectedSchedule } = useScheduleStore();
  const { data: settings } = useSettings();
  const theme = useTheme();

  const format = useTemperatureFormat();
  const timeZone = settings?.timeZone ?? moment.tz.guess();
  const { min: yMin, max: yMax } = displayBounds(format);

  const points = useMemo(() => {
    if (!selectedSchedule) return [];
    return buildSeriesData(selectedSchedule, yMin, yMax, format, timeZone);
  },
  [selectedSchedule, yMin, yMax, format, timeZone],
  );

  if (!points.length) return null;
  const xData = points.map(p => p.x);
  const yData = points.map(p => p.y);
  const gradAreaId = 'temp-x-grad-area';
  const gradLineId = 'temp-x-grad-line';
  const axisColor = theme.palette.text.secondary;
  const showRow = (rowId: string) => {
    const row = document.getElementById(rowId);
    row?.scrollIntoView?.({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    row?.querySelector<HTMLInputElement>('input[type="time"]')?.focus({ preventScroll: true });
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      row?.animate?.([{ outline: `2px solid ${theme.palette.primary.main}` }, { outline: '2px solid transparent' }], { duration: 1200 });
    }
  };
  const alarms = selectedSchedule?.alarms.length ? selectedSchedule.alarms : selectedSchedule ? [selectedSchedule.alarm] : [];
  const enabledAlarms = alarms.filter(alarm => alarm.enabled).sort((first, second) =>
    minutesSincePowerOn(first.time, selectedSchedule!.power.on) - minutesSincePowerOn(second.time, selectedSchedule!.power.on));

  return (
    <Paper variant="outlined" aria-label="Night temperature chart" sx={ { width: '100%', p: 2 } }>
      <LineChart
        height={ 120 }
        onAxisClick={ (_, data) => { if (data) showRow(points[data.dataIndex].rowId); } }
        xAxis={ [{
          scaleType: 'time',
          data: xData,
          valueFormatter: (v) =>
            moment(v as Date).tz(timeZone).format('h:mm A'),
          min: xData[0],
          max: new Date(xData[xData.length - 1].getTime() + CHART_END_PADDING_MS),
          tickMinStep: 60 * 60 * 1000,
          tickNumber: 4,
          tickLabelStyle: { fill: axisColor },
        }] }
        yAxis={ [{
          min: yMin,
          max: yMax,
          tickLabelStyle: { fill: axisColor },
          valueFormatter: (value: number) => formatDisplayValue(value, format) ,
        }] }
        series={ [{
          id: 'targeTempF',
          label: unitOf(format) === 'level' ? 'Target level' : unitOf(format) === 'celsius' ? 'Target °C' : 'Target °F',
          data: yData,
          valueFormatter: seriesValueFormatter(points.map(p => p.temperature), format),
          area: true,
          baseline: fahrenheitToDisplay(levelToFahrenheit(0), format),
          showMark: false,
          curve: 'stepAfter',
        }] }
        margin={ {
          right: 32,
          left: 44,
          top: 5,
          bottom: 24
        } }
        sx={ {
          pt: 0,
          [`& .${lineElementClasses.root}`]: { stroke: `url(#${gradLineId})` },
          [`& .${areaElementClasses.root}`]: { fill: `url(#${gradAreaId})`, filter: 'none' },
          '& .MuiChartsAxis-bottom .MuiChartsAxis-line': {
            stroke: axisColor,
          },
          '& .MuiChartsAxis-bottom .MuiChartsAxis-tick': {
            stroke: axisColor,
          },
          '& .MuiChartsAxis-left .MuiChartsAxis-line': {
            stroke: axisColor,
          },
          '& .MuiChartsAxis-left .MuiChartsAxis-tick': {
            stroke: axisColor,
          },
          '& .MuiChartsGrid-line': {
            stroke: axisColor,
          },
        } }
        slotProps={ { legend: { hidden: true } } }
      >
        { enabledAlarms[0] && timeInPowerWindow(enabledAlarms[0].time, selectedSchedule!.power) && <ChartsReferenceLine
          x={ todayAt(enabledAlarms[0].time, timeZone, enabledAlarms[0].time < selectedSchedule!.power.on ? 1 : 0) }
          label="Wake"
          labelAlign="start"
          spacing={ { x: -6, y: 5 } }
          labelStyle={ { fill: axisColor, fontSize: 12, textAnchor: 'end' } }
          lineStyle={ { stroke: axisColor, strokeDasharray: '3 3' } }/> }
        <HorizontalTempGradient
          idArea={ gradAreaId }
          idLine={ gradLineId }
          points={ points }
          areaAlpha={ AREA_ALPHA }
          lineAlpha={ LINE_ALPHA }
        />
      </LineChart>
    </Paper>
  );
}
