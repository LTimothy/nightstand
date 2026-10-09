import { createSerializedUpdate } from './serializedUpdate.js';
// LowDB, stores the schedules in /persistent/free-sleep-data/lowdb/settingsDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

import { Settings, SideSettings, defaultFeatures } from './settingsSchema.js';
import config from '../config.js';

const defaultSideSettings: SideSettings = {
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
await settingsDB.read();
// Allows us to add default values to the settings if users have existing settingsDB.json data
settingsDB.data = _.merge({}, defaultData, settingsDB.data);
// Remove obsolete cover button settings so full settings updates validate.
for (const side of ['left', 'right'] as const) {
  delete (settingsDB.data[side] as SideSettings & { buttons?: unknown }).buttons;
}

await settingsDB.write();

export const updateSettings = createSerializedUpdate(settingsDB);

export default settingsDB;
