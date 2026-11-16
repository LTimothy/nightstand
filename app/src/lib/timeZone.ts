import { TIME_ZONE_LABELS, TimeZone } from '@api/timeZones.ts';

export function friendlyTimeZone(zone: string): string {
  return TIME_ZONE_LABELS[zone as TimeZone] ?? zone;
}
