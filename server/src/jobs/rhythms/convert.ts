import { DailySchedule, DayOfWeek, Schedules, SideSchedule } from '../../db/schedulesSchema.js';
import { DEFAULT_SMART, RHYTHMS_FILE_VERSION, Rhythm, RhythmsDBSchema, SideRhythms, WeekPlan } from '../../db/rhythmsSchema.js';
import { conversionName } from '../../db/rhythmDays.js';
import { wakeFromNight } from '../../db/rhythmWake.js';
import { SCHEDULE_DAYS } from '../../db/scheduleKeys.js';
import { canonicalJson, normalizeNight } from './night.js';
import { legacyFingerprint } from './fingerprint.js';

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'rhythm';

// Ids follow RhythmIdSchema: at most 32 characters, suffixed -2, -3 on collision.
export function uniqueRhythmId(name: string, used: Set<string>): string {
  const base = slug(name);
  let id = base;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  used.add(id);
  return id;
}

function convertSide(side: SideSchedule): SideRhythms {
  const groups: Array<{ key: string; night: DailySchedule; days: DayOfWeek[] }> = [];
  for (const day of SCHEDULE_DAYS) {
    const night = normalizeNight(side[day]);
    if (!night.power.enabled) continue;
    const key = canonicalJson(night);
    const group = groups.find(entry => entry.key === key);
    if (group) group.days.push(day);
    else groups.push({ key, night, days: [day] });
  }
  const week: WeekPlan = {
    sunday: null, monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null,
  };
  const rhythms: Record<string, Rhythm> = {};
  const used = new Set<string>();
  for (const group of groups) {
    const name = conversionName(group.days);
    const id = uniqueRhythmId(name, used);
    rhythms[id] = { id, name, night: group.night, wake: wakeFromNight(group.night), temperatureMode: 'manual', smart: { ...DEFAULT_SMART } };
    for (const day of group.days) week[day] = id;
  }
  return { rhythms, week, changes: [] };
}

// Identical enabled nights share one rhythm named after its days; disabled nights plan no sleep.
export function convertLegacy(schedules: Schedules): { left: SideRhythms; right: SideRhythms } {
  return { left: convertSide(schedules.left), right: convertSide(schedules.right) };
}

// The rhythms file turning Rhythms on first writes.
export function weeklyRhythms(schedules: Schedules) {
  const { left, right } = convertLegacy(schedules);
  return RhythmsDBSchema.safeParse({ version: RHYTHMS_FILE_VERSION, legacyFingerprint: legacyFingerprint(schedules), left, right });
}
