import { useState } from 'react';
import SectionHeading from '@components/SectionHeading';
import moment from 'moment-timezone';
import { Alert, AlertTitle, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { useStatusSummary } from './useStatusSummary';
import { StatusInfo } from '@api/serverStatusSchema.ts';
import { SubpageShell } from '../DataPage/Header.tsx';
import GroupCard from './GroupCard.tsx';
import FirmwarePanel from './FirmwarePanel.tsx';
import FlashHealthPanel from './FlashHealthPanel.tsx';
import {
  GROUP_LABELS, STATUS_META, StatusGroup, waitingCoreKeys, statusName, statusImpact,
} from './statusMeta.ts';

const GROUPS: StatusGroup[] = ['core', 'schedules', 'biometrics'];

export default function StatusPage() {
  const { data, isLoading, isError, refetch, dataUpdatedAt, keys, coreReady, overdue, attention, now } = useStatusSummary();
  const waitingNames = waitingCoreKeys(data).map(key => statusName(key, data?.[key])).join(', ');
  const overdueNames = overdue.map(key => statusName(key, data?.[key])).join(', ');
  const attentionNames = attention.map(key => statusName(key, data?.[key])).join(', ');
  const impacts = [...new Set(attention.filter(key => !overdue.includes(key)).map(statusImpact))];
  const stale = dataUpdatedAt > 0 && now - dataUpdatedAt > 60_000;
  const activity = keys.filter(key => ['started', 'waiting_for_data'].includes((data![key] as StatusInfo).status));
  const ranked = () => [...GROUPS].sort((left, right) => {
    const rank = (group: StatusGroup) => attention.some(key => STATUS_META[key].group === group) ? 0
      : activity.some(key => STATUS_META[key].group === group) ? 1 : 2;
    return rank(left) - rank(right);
  });
  // The first answer of the visit sets the order; later changes show inside the groups and in the summary.
  const [order, setOrder] = useState<StatusGroup[]>();
  if (!order && keys.length > 0) setOrder(ranked());

  return (
    <SubpageShell title="System status" backTo="/settings/device" backLabel="Back to Pod and diagnostics">
      { isLoading && !isError && !data && <CircularProgress aria-label="Loading system status" sx={ { mx: 'auto' } }/> }
      { (isError || stale) && (
        <Alert severity="warning" action={ <Button color="inherit" onClick={ () => void refetch() }>Check again</Button> }>
          Can't reach the Pod.{ dataUpdatedAt > 0
            ? ` Showing the last check at ${moment(dataUpdatedAt).format('h:mm A')}.` : ' No status check is available yet.' }
        </Alert>
      ) }
      { data && (
        <>
          { !isError && !stale && keys.length === 0 && <Alert severity="info">No status checks are available yet.</Alert> }
          { !isError && !stale && keys.length > 0 && <Alert severity={ attention.length ? 'warning' : coreReady ? 'success' : 'info' }>
            <AlertTitle>{ attention.length ? `${attentionNames} ${attention.length === 1 ? 'needs' : 'need'} attention`
              : coreReady ? 'Everything is running' : 'Waiting for core services' }</AlertTitle>
            { !attention.length && !coreReady && <Typography variant="body2">Waiting for { waitingNames }.</Typography> }
            { overdue.length > 0 && <Typography variant="body2">
              { overdueNames } { overdue.length === 1 ? 'has' : 'have' } not started. Check the service below or open Logs.
            </Typography> }
            { impacts.map(impact => <Typography key={ impact } variant="body2">
              { impact }
            </Typography>) }
          </Alert> }
          { data.systemDate?.status === 'healthy' && data.systemDate.message && (
            <Alert severity="warning" aria-label="Clock warning">{ data.systemDate.message }</Alert>
          ) }
          <Stack direction="row" alignItems="baseline" spacing={ 1 }>
            <Typography variant="body2" color="text.secondary">
              { dataUpdatedAt > 0 && `Checked ${moment(dataUpdatedAt).format('h:mm A')}` }
            </Typography>
            <Button onClick={ () => void refetch() }>Check again</Button>
          </Stack>
          { attention.length > 0 && <SectionHeading>Needs attention ({ attention.length })</SectionHeading> }
          { (order ?? ranked()).map(group => (
            <GroupCard
              key={ group }
              label={ GROUP_LABELS[group] }
              keys={ keys.filter(key => STATUS_META[key].group === group) }
              data={ data }
              attentionKeys={ attention }
            />
          )) }
        </>
      ) }
      <FirmwarePanel />
      <FlashHealthPanel />
    </SubpageShell>
  );
}
