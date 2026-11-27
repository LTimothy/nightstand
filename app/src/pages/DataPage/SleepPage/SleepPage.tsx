/* eslint-disable react/no-multi-comp */
import SectionHeading from '@components/SectionHeading';
import { useMemo, useState } from 'react';
import moment from 'moment-timezone';
import { useSearchParams } from 'react-router-dom';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button,
  CircularProgress, IconButton, Tab, Tabs, Typography,
} from '@mui/material';
import VitalsLineChart from '@components/VitalsLineChart';
import SleepBalanceCard from '@components/SleepBalanceCard';
import SleepFitnessCard from '@components/SleepFitnessCard';
import PageHeader from '@components/PageHeader';
import SleepSideControl from './SleepSideControl';
import ErrorBoundary from '@components/ErrorBoundary';
import { useAppStore, Side } from '@state/appStore';
import { useSleepRecords } from '@api/sleep';
import { useSettings } from '@api/settings';
import { useServices } from '@api/services';
import { useVitalsRecords, useVitalsSummary, type VitalsSummary } from '@api/vitals';
import type { SleepRecord } from '@api/sleepSchema';
import type { VitalsMetric } from '@lib/vitalsPoints';
import { vitalsRecordsToPoints } from '@lib/vitalsPoints';
import PageContainer from '../../PageContainer';
import WeekStrip from './WeekStrip';
import { recordForNight, recordsInWeek, withoutFutureRecords } from './sleepContext';
import MissingNightCard, { MissingNightState, RHYTHMS_PENDING_DESCRIPTION } from './MissingNightCard';
import { useRhythmsState } from '@api/rhythms';
import useAnalyzeSleep from '@lib/useAnalyzeSleep';
import { SLEEP_ANALYSIS_HOUR, SLEEP_ANALYSIS_MINUTE } from '../../../../../server/src/sleepAnalysisSchedule';

type MetricRow = { key: VitalsMetric; label: string; unit: string; summary: keyof NonNullable<VitalsSummary['retained']> };

const METRICS: ReadonlyArray<MetricRow> = [
  { key: 'heart_rate', label: 'Average heart rate', unit: 'bpm', summary: 'avgHeartRate' },
];

// With new sleep tracking on, breathing rate returns. Minutes whose breathing
// estimate failed its quality check carry no resp_rate and are left out.
const V2_METRICS: ReadonlyArray<MetricRow> = [
  { key: 'heart_rate', label: 'Average heart rate', unit: 'bpm', summary: 'avgHeartRate' },
  { key: 'resp_rate', label: 'Breathing rate', unit: 'breaths/min', summary: 'avgBreathingRate' },
];

function NightVitals({ record, side, timeZone, biometricsV2 }: {
  record: SleepRecord; side: Side; timeZone: string; biometricsV2: boolean;
}) {
  const metrics = biometricsV2 ? V2_METRICS : METRICS;
  const [params, setParams] = useSearchParams();
  const requested = params.get('metric');
  // A saved link to a measurement that is no longer listed opens the first one.
  const metric = requested && !metrics.some(item => item.key === requested) ? metrics[0].key : requested;
  const query = { side, startTime: record.entered_bed_at, endTime: record.left_bed_at };
  const { data: vitals, isPending, isError, refetch } = useVitalsRecords(query);
  const { data: nightSummary } = useVitalsSummary(query);
  const { data: weekSummary } = useVitalsSummary({
    side, startTime: moment.tz(record.left_bed_at, timeZone).subtract(7, 'days').toISOString(), endTime: record.left_bed_at,
  });
  const metricPoints = useMemo(() => metrics.map(item =>
    vitalsRecordsToPoints(vitals ?? [], item.key, { startTime: record.entered_bed_at, endTime: record.left_bed_at }),
  ), [metrics, vitals, record.entered_bed_at, record.left_bed_at]);
  const selectMetric = (next: VitalsMetric, expanded: boolean) => {
    const nextParams = new URLSearchParams(params);
    if (expanded) nextParams.set('metric', next);
    else nextParams.delete('metric');
    setParams(nextParams, { replace: true });
  };
  return (
    <Box sx={ { minWidth: 0, display: 'grid', gap: 2 } }>
      <Typography variant="body2" color="text.secondary">
        Bed sensor estimates, not medical measurements. In a shared bed, some can come from the other sleeper.
      </Typography>
      { metrics.map((item, index) => {
        const points = metricPoints[index];
        const value = nightSummary?.retained?.[item.summary]
          ?? (points.length ? points.reduce((sum, point) => sum + point.value, 0) / points.length : undefined);
        return (
          <Accordion
            key={ item.key }
            sx={ { minWidth: 0 } }
            expanded={ metric === item.key }
            onChange={ (_, expanded) => selectMetric(item.key, expanded) }
            slotProps={ { transition: { mountOnEnter: true, unmountOnExit: true } } }
            disableGutters>
            <AccordionSummary expandIcon={ <ExpandMoreIcon/> } id={ `metric-${item.key}` } aria-controls={ `detail-${item.key}` }>
              <Box sx={ { display: 'flex', justifyContent: 'space-between', width: '100%', gap: 1 } }>
                <Typography variant="inherit" component="span">{ item.label }</Typography>
                <Typography color="text.secondary" variant="body2">
                  { isError ? 'Measurements unavailable' : isPending ? 'Loading measurements'
                    : Number.isFinite(value) && value! > 0 ? `${Math.round(value!)} ${item.unit}` : 'No estimate' }
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <ErrorBoundary componentName={ item.label }>
                { isError ? (
                  <Alert severity="error" action={ <Button onClick={ () => refetch() }>Retry</Button> }>Measurements could not be loaded.</Alert>
                ) : isPending ? <CircularProgress size={ 24 } aria-label="Loading measurements"/> : points.length ? (
                  <VitalsLineChart
                    points={ points }
                    metric={ item.key }
                    sevenDayAvg={ weekSummary?.[item.summary] }
                    timeZone={ timeZone }
                    startTime={ record.entered_bed_at }
                    endTime={ record.left_bed_at }/>
                ) : <Typography color="text.secondary">
                  { nightSummary?.retained ? 'Detailed measurements were pruned. The nightly average is preserved.'
                    : `No ${item.label.toLowerCase()} estimate for this recording.` }
                </Typography> }
              </ErrorBoundary>
            </AccordionDetails>
          </Accordion>
        );
      }) }
    </Box>
  );
}

// Keep explicit date selection across side changes.
function SleepContext({ side, timeZone, biometricsV2 }: { side: Side; timeZone: string; biometricsV2: boolean }) {
  const [weekDate, setWeekDate] = useState<string>();
  const [chosenDate, setChosenDate] = useState<string>();
  const [view, setView] = useState('night');
  const { data: recentData, isError: recentError } = useSleepRecords({ side });
  const requestedWeek = weekDate ? moment.tz(weekDate, timeZone).startOf('day') : undefined;
  const { data, isPending, isError, refetch } = useSleepRecords({
    side,
    ...(requestedWeek ? {
      startTime: requestedWeek.toISOString(),
      endTime: requestedWeek.clone().add(7, 'days').toISOString(),
    } : {}),
  });
  const now = moment.tz(timeZone);
  const sideRecords = isError ? [] : withoutFutureRecords(data ?? [], now.valueOf());
  const recentRecords = recentError ? [] : withoutFutureRecords(recentData ?? [], now.valueOf());
  const latestRecord = [...recentRecords].sort((left, right) => Date.parse(right.left_bed_at) - Date.parse(left.left_bed_at))[0];
  const newest = latestRecord && recordForNight(recentRecords, moment.tz(latestRecord.left_bed_at, timeZone).format('YYYY-MM-DD'), timeZone);
  const { data: services, isError: servicesError, refetch: refetchServices } = useServices();
  const { state: rhythmsState } = useRhythmsState();
  const job = services?.biometrics?.jobs?.[side === 'left' ? 'analyzeSleepLeft' : 'analyzeSleepRight'];
  const analysis = useAnalyzeSleep();
  const today = now.clone();
  const todayDate = today.format('YYYY-MM-DD');
  const latestMissing = !recordForNight(recentRecords, todayDate, timeZone);
  const jobIsToday = !!job?.timestamp && moment.tz(job.timestamp, timeZone).isSame(today, 'day');
  const analysisTime = today.clone().startOf('day').hour(SLEEP_ANALYSIS_HOUR).minute(SLEEP_ANALYSIS_MINUTE);
  const currentState: MissingNightState = services?.biometrics?.enabled === false ? 'off'
    : analysis.isPending ? 'analyzing'
      : analysis.error || (job?.status === 'failed' && jobIsToday) ? 'failed'
        : (today.isBefore(analysisTime) && !jobIsToday) || job?.status === 'not_started'
          || (job?.status === 'waiting_for_data' && !jobIsToday) ? 'pending' : 'empty';
  const completedToday = jobIsToday && (job?.status === 'healthy' || job?.status === 'waiting_for_data');
  const showLatestAnalysis = !chosenDate && !weekDate && latestMissing
    && ((completedToday && currentState === 'empty')
      || (newest?.sleep_period_seconds !== 0 && ['pending', 'analyzing', 'failed'].includes(currentState)));
  const initialWeek = moment.tz(showLatestAnalysis ? todayDate : newest?.left_bed_at, timeZone).startOf('isoWeek').format('YYYY-MM-DD');
  const weekStart = useMemo(() => moment.tz(weekDate ?? initialWeek, timeZone).startOf('day'), [weekDate, initialWeek, timeZone]);
  const weekEnd = weekStart.clone().add(6, 'days');
  const otherYear = weekStart.year() !== today.year() || weekEnd.year() !== today.year();
  const weekFormat = otherYear ? 'MMM D, YYYY' : 'MMM D';
  const weekTitle = `${weekStart.format(weekFormat)} - ${weekEnd.format(weekFormat)}`;
  const records = isError ? [] : recordsInWeek(sideRecords, weekStart, timeZone);
  const latest = [...records].sort((left, right) => Date.parse(right.left_bed_at) - Date.parse(left.left_bed_at))[0];
  const defaultDate = latest ? moment.tz(latest.left_bed_at, timeZone) : moment.min(today, weekEnd);
  const selectedDate = chosenDate ?? (showLatestAnalysis ? todayDate : defaultDate.format('YYYY-MM-DD'));
  const selected = recordForNight(records, selectedDate, timeZone);
  const isLatestDate = selectedDate === todayDate;
  const missingState: MissingNightState = selected?.sleep_period_seconds === 0 ? 'zero'
    : services?.biometrics?.enabled === false ? 'off' : isLatestDate ? currentState : 'empty';
  const fallback = !selected && isLatestDate
    && (['pending', 'analyzing', 'failed'].includes(missingState) || (missingState === 'empty' && completedToday)) ? newest : undefined;
  const displayed = selected?.sleep_period_seconds === 0 ? undefined : selected ?? fallback;
  const nightTitle = (wakeDate: string) => {
    const wake = moment.tz(wakeDate, timeZone);
    return wake.format(wake.year() === today.year() ? '[Out of bed] ddd, MMM D' : '[Out of bed] ddd, MMM D, YYYY');
  };
  const phoneZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const podZoneLabel = timeZone.split('/').slice(-1)[0]?.replace(/_/g, ' ') ?? timeZone;
  const changeWeek = (amount: number) => {
    setWeekDate(weekStart.clone().add(amount, 'week').format('YYYY-MM-DD'));
    setChosenDate(undefined);
  };

  return (
    <>
      { servicesError && (
        <Alert severity="error" action={ <Button onClick={ () => refetchServices() }>Retry</Button> }>
          Sleep tracking status could not be loaded.
        </Alert>
      ) }
      <SleepSideControl
        selectedDate={ displayed ? moment.tz(displayed.left_bed_at, timeZone).format('YYYY-MM-DD') : selectedDate }
        displayedRecord={ displayed }
        timeZone={ timeZone }/>
      <Box sx={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }>
        <IconButton aria-label="Previous week" onClick={ () => changeWeek(-1) }><NavigateBeforeIcon/></IconButton>
        <Typography>{ weekTitle }</Typography>
        <IconButton
          aria-label="Next week"
          disabled={ weekStart.isSameOrAfter(moment.tz(timeZone).startOf('isoWeek')) }
          onClick={ () => changeWeek(1) }><NavigateNextIcon/></IconButton>
      </Box>
      <WeekStrip
        weekStart={ weekStart }
        timeZone={ timeZone }
        selectedDate={ view === 'night' ? selectedDate : undefined }
        records={ records }
        currentNightState={ currentState }
        onSelectDay={ date => {
          setChosenDate(date);
          setWeekDate(weekStart.format('YYYY-MM-DD'));
        } }/>
      <Tabs
        value={ view }
        onChange={ (_, next: string) => setView(next) }
        aria-label="Sleep period"
        variant="fullWidth"
        sx={ { borderBottom: 1, borderColor: 'divider' } }>
        <Tab value="night" label="Night" id="sleep-night" aria-controls="sleep-panel"/>
        <Tab value="week" label="Week" id="sleep-week" aria-controls="sleep-panel"/>
      </Tabs>
      <Box role="tabpanel" id="sleep-panel" aria-labelledby={ `sleep-${view}` }>
        { isError ? (
          <Alert severity="error" action={ <Button onClick={ () => refetch() }>Retry</Button> }>Sleep records could not be loaded.</Alert>
        ) : isPending ? <CircularProgress aria-label="Loading sleep records" sx={ { display: 'block', mx: 'auto' } }/> : view === 'week' ? (
          <ErrorBoundary componentName="Weekly time in bed">
            <SleepBalanceCard
              records={ records }
              weekStart={ weekStart }
              timeZone={ timeZone }
              onSelectDay={ date => {
                setChosenDate(date);
                setWeekDate(weekStart.format('YYYY-MM-DD'));
                setView('night');
              } }/>
          </ErrorBoundary>
        ) : (
          <Box sx={ { display: 'grid', gap: 2 } }>
            { (!selected || selected.sleep_period_seconds === 0) && (
              <SectionHeading>{ nightTitle(selectedDate) }</SectionHeading>
            ) }
            { (!servicesError || selected?.sleep_period_seconds === 0)
              && (!selected || selected.sleep_period_seconds === 0 || services?.biometrics?.enabled === false) && (
              <MissingNightCard
                state={ missingState }
                canAnalyze={ analysis.canAnalyze }
                pendingDescription={ rhythmsState === 'active' ? RHYTHMS_PENDING_DESCRIPTION : undefined }
                onAnalyze={ () => void analysis.analyze() }/>
            ) }
            { fallback && displayed && (
              <Typography variant="body2" color="text.secondary">Most recent recording</Typography>
            ) }
            { displayed && (
              <Box
                sx={ {
                  display: 'grid', gap: 2, alignItems: 'start',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
                } }>
                <Box sx={ { display: 'grid', gap: 2, minWidth: 0 } }>
                  <ErrorBoundary componentName="Night summary">
                    <SleepFitnessCard
                      sleepRecord={ displayed }
                      timeZone={ timeZone }
                      title={ nightTitle(moment.tz(displayed.left_bed_at, timeZone).format('YYYY-MM-DD')) }
                      timeZoneLabel={ phoneZone !== timeZone ? `Times shown in Pod time (${podZoneLabel})` : undefined }/>
                  </ErrorBoundary>
                </Box>
                <Box sx={ { display: 'grid', gap: 2, minWidth: 0 } }>
                  <ErrorBoundary key={ `${side}-${displayed.id}` } componentName="Night measurements">
                    <NightVitals record={ displayed } side={ side } timeZone={ timeZone } biometricsV2={ biometricsV2 }/>
                  </ErrorBoundary>
                </Box>
              </Box>
            ) }
          </Box>
        ) }
      </Box>
    </>
  );
}

export default function SleepPage() {
  const { side } = useAppStore();
  const { data: settings, isError, isFetched, refetch } = useSettings();
  return (
    <ErrorBoundary componentName="Sleep page">
      <PageContainer sx={ { gap: 2, alignItems: 'stretch' } }>
        <PageHeader title="Sleep"/>
        { isError || (isFetched && !settings) ? (
          <Alert severity="error" action={ <Button onClick={ () => refetch() }>Retry</Button> }>
            Pod settings could not be loaded.{ ' ' }
            { settings ? 'Using the last known Pod timezone.' : 'Times shown in UTC until settings are available.' }
          </Alert>
        ) : null }
        { settings || isFetched ? (
          <SleepContext
            key={ settings?.timeZone ?? 'UTC' }
            side={ side }
            timeZone={ settings?.timeZone ?? 'UTC' }
            biometricsV2={ settings?.features?.biometricsV2 === true }/>
        ) : <CircularProgress aria-label="Loading Pod timezone"/> }
      </PageContainer>
    </ErrorBoundary>
  );
}
