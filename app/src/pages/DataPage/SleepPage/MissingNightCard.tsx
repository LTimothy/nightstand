import SectionHeading from '@components/SectionHeading';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import GlassCard from '@design/GlassCard';
import moment from 'moment-timezone';
import { SLEEP_ANALYSIS_HOUR, SLEEP_ANALYSIS_MINUTE } from '../../../../../server/src/sleepAnalysisSchedule';

export type MissingNightState = 'pending' | 'analyzing' | 'empty' | 'failed' | 'off' | 'zero';
const analysisTime = moment.utc().hour(SLEEP_ANALYSIS_HOUR).minute(SLEEP_ANALYSIS_MINUTE).format('h:mm A');
const COPY: Record<MissingNightState, { title: string; description: string }> = {
  pending: { title: 'Not ready yet', description: `Last night is analyzed at ${analysisTime}.` },
  analyzing: { title: 'Analyzing last night', description: 'This takes a few minutes.' },
  empty: { title: 'Nothing recorded', description: "The bed didn't detect anyone on this side." },
  failed: { title: "Couldn't analyze this night", description: 'Try again, or check Pod and diagnostics in Settings.' },
  off: { title: 'Sleep tracking is off', description: 'Turn it on to record new nights.' },
  zero: { title: 'No time in bed recorded', description: 'This night was analyzed, but no time in bed was found.' },
};

export const RHYTHMS_PENDING_DESCRIPTION = 'Analyzed about 15 minutes after a Rhythms sleep ends.';

type Props = { state: MissingNightState; canAnalyze: boolean; onAnalyze: () => void; pendingDescription?: string };
export default function MissingNightCard({ state, canAnalyze, onAnalyze, pendingDescription }: Props) {
  const copy = COPY[state];
  const description = state === 'pending' && pendingDescription ? pendingDescription : copy.description;
  return (
    <GlassCard role="status">
      <Box sx={ { display: 'flex', alignItems: 'center', gap: 1 } }>
        { state === 'analyzing' && <CircularProgress size={ 20 } aria-label="Analysis running"/> }
        <SectionHeading>{ copy.title }</SectionHeading>
      </Box>
      <Typography color="text.secondary" variant="body2" sx={ { mt: 0.5 } }>{ description }</Typography>
      { (state === 'pending' || state === 'failed') && (
        <Button disabled={ !canAnalyze } onClick={ onAnalyze } sx={ { mt: 1, ml: -1 } }>
          { state === 'failed' ? 'Try again' : 'Analyze now' }
        </Button>
      ) }
      { state === 'off' && <Button component={ Link } to="/settings/features" sx={ { mt: 1, ml: -1 } }>Open Features settings</Button> }
    </GlassCard>
  );
}
