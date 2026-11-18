import { useSettings } from '@api/settings.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { Version } from '@api/deviceStatusSchema.ts';
import { TemperatureFormat, targetFormatOf } from './temperatureConversions';

// The format every page displays: the stored unit, relabelled with the Pod's target when that option is on and the hub is a Pod 5.
export default function useTemperatureFormat(): TemperatureFormat {
  const { data: settings } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  const stored = settings?.temperatureFormat ?? 'fahrenheit';
  return settings?.features?.targetTemperatureLabels && deviceStatus?.hubVersion === Version.Pod5 ? targetFormatOf(stored) : stored;
}
