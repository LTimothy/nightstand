import { Alert, Button } from '@mui/material';
import { useMemory } from '@api/memory.ts';
import UsageBar from './UsageBar.tsx';

export default function MemoryIndicator() {
  // The pod has no swap, so RAM pressure can turn into an OOM kill quickly:
  // poll a bit more often than storage.
  const { data, isLoading, isError, refetch } = useMemory(60_000);
  if (isError) return <Alert severity="warning" action={ <Button onClick={ () => void refetch() }>Retry</Button> }>
    Could not load memory usage.
  </Alert>;
  if (isLoading || !data) return null;

  return (
    <UsageBar
      label="Memory"
      usedBytes={ data.usedBytes }
      totalBytes={ data.totalBytes }
      usedPercent={ data.usedPercent }
    />
  );
}
