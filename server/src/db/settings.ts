import { createSerializedUpdate } from './serializedUpdate.js';
// LowDB, stores the schedules in /persistent/free-sleep-data/lowdb/settingsDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { Settings, SideSettings, defaultFeatures } from './settingsSchema.js';
import config from '../config.js';
import logger from '../logger.js';
import schedulesDB from './schedules.js';
import { createRhythms, loadRhythms } from './rhythms.js';
import { weeklyRhythms } from '../jobs/rhythms/convert.js';

export const defaultSideSettings: SideSettings = {
  name: 'Side',
  awayMode: false,
  alarmsEnabled: true,
  scheduleOverrides: {
    temperatureSchedules: {
      disabled: false,
      expiresAt: ''
    },
    alarm: {
      disabled: false,
      timeOverride: '',
      expiresAt: '',
    },
    pause: {
      active: false,
      expiresAt: '',
    },
  },
  oneOffAlarm: {
    enabled: false,
    fireAt: '',
    vibrationIntensity: 100,
    vibrationPattern: 'rise',
    duration: 30,
  },
  taps: {
    doubleTap: {
      type: 'temperature',
      change: 'decrement',
      amount: 2,
    },
    tripleTap: {
      type: 'temperature',
      change: 'increment',
      amount: 2,
    },
    quadTap: {
      type: 'base_control',
      behavior: 'toggle_preset',
    },
  },
  buttons: {
    invertButtons: false,
    stepF: 1,
    favoriteTemperatureF: 80,
  },
};

const defaultData: Settings = {
  id: crypto.randomUUID(),
  timeZone: 'UTC',
  temperatureFormat: 'fahrenheit',
  rebootDaily: true,
  rawArchiveRetentionDays: 14,
  updateChannel: 'stable',
  left: {
    ..._.cloneDeep(defaultSideSettings),
    name: 'Left',
  },
  right: {
    ..._.cloneDeep(defaultSideSettings),
    name: 'Right',
  },
  primePodDaily: {
    enabled: false,
    time: '14:00',
  },
  features: { ...defaultFeatures },
};

const file = new JSONFile<Settings>(`${config.lowDbFolder}settingsDB.json`);
const settingsDB = new Low<Settings>(file, defaultData);
const stored = await file.read();
// No file, or only the update channel install.sh and the migration installer write before the first start.
const newInstall = !stored || _.isEqual(Object.keys(stored), ['updateChannel']);
// Allows us to add default values to the settings if users have existing settingsDB.json data.
// Rhythms starts on only for a new install, so an upgrade keeps its weekly schedule.
settingsDB.data = _.merge({}, defaultData, newInstall ? {} : { features: { rhythms: false } }, stored);
// A stored gesture is a whole action; merging would add the default's fields.
for (const side of ['left', 'right'] as const) Object.assign(settingsDB.data[side].taps, stored?.[side]?.taps);

// Seeded before the settings are saved, as the Rhythms switch does, so the bed follows them from the first start.
if (newInstall && settingsDB.data.features.rhythms && (await loadRhythms()).state === 'absent') {
  const created = weeklyRhythms(schedulesDB.data);
  if (created.success) {
    await createRhythms(created.data);
  } else {
    logger.warn(`Rhythms left off, the weekly schedule does not convert: ${created.error.message}`);
    settingsDB.data.features.rhythms = false;
  }
}
await settingsDB.write();

export const updateSettings = createSerializedUpdate(settingsDB);

export default settingsDB;
