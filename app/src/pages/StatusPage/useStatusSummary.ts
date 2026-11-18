import { useEffect, useState } from 'react';
import { useServerStatus } from '@api/serverStatus';
import { useDeviceStatus } from '@api/deviceStatus';
import { Version } from '@api/deviceStatusSchema.ts';
import { coreServicesReady, needsAttention, overdueCoreKeys, usableStatusKeys } from './statusMeta';

export function useStatusSummary() {
  const query = useServerStatus(30_000);
  const { data: device } = useDeviceStatus();
  const [lastCheckFailed, setLastCheckFailed] = useState(false);
  useEffect(() => {
    if (query.isError) setLastCheckFailed(true);
    else if (query.isSuccess) setLastCheckFailed(false);
  }, [query.isError, query.isSuccess]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  const { data, clock } = query;
  // A Pod 5 hub handles its own buttons, so the monitor row means nothing there. Readiness still counts it: it is always healthy.
  const keys = usableStatusKeys(data).filter(key => !(key === 'buttonMonitor' && device?.hubVersion === Version.Pod5));
  const podNow = clock ? clock.podTime + Math.max(0, performance.now() - clock.receivedAt) : undefined;
  const overdue = overdueCoreKeys(data, podNow);
  const attention = keys.filter(key => needsAttention(data?.[key]?.status) || overdue.includes(key));
  return { ...query, isError: query.isError || lastCheckFailed, keys, overdue, attention, coreReady: coreServicesReady(data), now: Date.now() };
}
