import { Alert, Button } from '@mui/material';
import { useStorage } from '@api/storage.ts';
import { formatBytes } from '../../lib/formatBytes.ts';
import UsageBar from './UsageBar.tsx';

export default function StorageIndicator() {
  // Storage rarely changes second-to-second: a slow poll is enough to
  // notice the biometrics archive or logs growing over days, not seconds.
  const { data, isLoading, isError, refetch } = useStorage(5 * 60_000);
  if (isError) return <Alert severity="warning" action={ <Button onClick={ () => void refetch() }>Retry</Button> }>
    Could not load storage usage.
  </Alert>;
  if (isLoading || !data) return null;

  const caption = [
    data.breakdown.biometricsArchiveBytes > 0 && `${formatBytes(data.breakdown.biometricsArchiveBytes)} biometrics archive`,
    `${formatBytes(data.breakdown.logsBytes)} logs`,
  ].filter(Boolean).join(' · ');

  return (
    <UsageBar
      label="Storage"
      usedBytes={ data.usedBytes }
      totalBytes={ data.totalBytes }
      usedPercent={ data.usedPercent }
      caption={ caption }
    />
  );
}
