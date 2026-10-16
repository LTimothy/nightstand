import { exec } from 'child_process';
import logger from '../logger.js';

// NetworkManager's last scan: a forced rescan disturbs the Pod's Wi-Fi link.
const COMMAND = 'nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi list --rescan no';
const REFRESH_MS = 60_000;

export let WIFI_SIGNAL_STRENGTH = 0;
let lastRead = -Infinity;
let reading: Promise<void> | undefined;

// Only Settings shows the value, so it is read when the device status is asked
// for, at most once a minute.
export function refreshWifiSignalStrength(now = Date.now()): Promise<void> {
  if (reading) return reading;
  if (now - lastRead < REFRESH_MS) return Promise.resolve();
  lastRead = now;
  reading = new Promise<void>(resolve => {
    exec(COMMAND, { timeout: 2000 }, (error, stdout) => {
      if (error) logger.warn(`Could not read Wi-Fi strength: ${error.message}`);
      const active = error ? undefined : stdout.split('\n').find(line => line.startsWith('yes:'));
      // 0 hides the row in Settings rather than showing an old reading.
      WIFI_SIGNAL_STRENGTH = active ? Number(active.split(':').at(-1)) || 0 : 0;
      resolve();
    });
  }).finally(() => { reading = undefined; });
  return reading;
}
