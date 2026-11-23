import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import PageHeader from '@components/PageHeader';
import { disableRhythms, enableRhythms, refreshRhythms, useRhythmsState } from '@api/rhythms';
import { serverMessage } from '@lib/requestError';
import PageContainer from '../PageContainer.tsx';
import SchedulePage from './SchedulePage.tsx';
import RhythmsPage from './rhythms/RhythmsPage.tsx';
import { rhythmsNotice } from './rhythms/rhythmsModel.ts';

export default function ScheduleTab() {
  const queryClient = useQueryClient();
  const { state, response, refetch } = useRhythmsState();
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  // After a weekly edit elsewhere the flag stays on; the person picks which schedule runs.
  const choose = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setActionError('');
    try {
      await action();
      await refreshRhythms(queryClient);
    } catch (caught) {
      setActionError(serverMessage(caught) ?? 'Could not change which schedule runs. Try again.');
      // A request that timed out may still have gone through; show what the Pod has now.
      void refreshRhythms(queryClient);
    } finally {
      setWorking(false);
    }
  };
  if (state === 'active' && response?.data) return <RhythmsPage db={ response.data }/>;
  // With the flag on, never offer the weekly editor until Rhythms is known to be off.
  if (state === 'loading' || state === 'error') return <PageContainer>
    <PageHeader title="Schedule"/>
    { state === 'error'
      ? <Alert severity="error" sx={ { width: '100%' } } action={ <Button onClick={ () => void refetch() }>Retry</Button> }>
        Could not load Rhythms.
      </Alert>
      : <CircularProgress aria-label="Loading Rhythms"/> }
  </PageContainer>;
  const mismatch = response?.status.reason === 'fingerprint-mismatch';
  // Going back to Rhythms leaves the weekly page, so it asks first when there is a draft.
  const notice = state === 'inactive' && response?.status.enabled ? (confirmLeave: (leave: () => void) => void) => <Alert
    severity="info"
    sx={ { width: '100%' } }
    action={ mismatch ? undefined : <Button component={ Link } to="/settings/features">Features</Button> }>
    { rhythmsNotice(response.status.reason) }
    { mismatch && <>
      <Typography variant="body2" sx={ { mt: 0.5 } }>
        If you go back to Rhythms, those weekly changes wait until you turn Rhythms off.
      </Typography>
      <Box sx={ { display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1, ml: -1 } }>
        <Button disabled={ working } onClick={ () => void choose(() => disableRhythms({ powerOffNow: false })) }>
          Use my weekly schedule
        </Button>
        <Button disabled={ working } onClick={ () => confirmLeave(() => void choose(enableRhythms)) }>
          Go back to Rhythms
        </Button>
      </Box>
      { actionError && <Typography role="alert" variant="body2" color="error" sx={ { mt: 1 } }>{ actionError }</Typography> }
    </> }
  </Alert> : undefined;
  return <SchedulePage notice={ notice }/>;
}
