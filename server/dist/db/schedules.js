import { createSerializedUpdate } from './serializedUpdate.js';
// LowDB, stores the schedules in /persistent/free-sleep-data/lowdb/schedulesDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { dailyAlarmSchedules } from './scheduleAlarms.js';
import config from '../config.js';
import { SCHEDULE_SIDES, SCHEDULE_DAYS } from './scheduleKeys.js';
const defaultDailySchedule = {
    temperatures: {},
    power: {
        on: '21:00',
        off: '09:00',
        enabled: false,
        onTemperature: 82,
    },
    alarm: {
        time: '09:00',
        vibrationIntensity: 100,
        vibrationPattern: 'double',
        duration: 30,
        enabled: false,
        alarmTemperature: 82,
    },
    alarms: [],
};
const defaultSideSchedule = {
    sunday: defaultDailySchedule,
    monday: defaultDailySchedule,
    tuesday: defaultDailySchedule,
    wednesday: defaultDailySchedule,
    thursday: defaultDailySchedule,
    friday: defaultDailySchedule,
    saturday: defaultDailySchedule,
};
const defaultData = {
    left: _.cloneDeep(defaultSideSchedule),
    right: _.cloneDeep(defaultSideSchedule),
};
const file = new JSONFile(`${config.lowDbFolder}schedulesDB.json`);
const schedulesDB = new Low(file, defaultData);
await schedulesDB.read();
// Allows us to add default values to the schedules if users have existing schedulesDB.json data
schedulesDB.data = _.merge({}, defaultData, schedulesDB.data);
for (const side of SCHEDULE_SIDES) {
    for (const day of SCHEDULE_DAYS) {
        const dailySchedule = schedulesDB.data[side][day];
        dailySchedule.alarms = dailyAlarmSchedules(dailySchedule);
        dailySchedule.alarm = dailySchedule.alarms[0] ?? dailySchedule.alarm;
    }
}
await schedulesDB.write();
export const updateSchedules = createSerializedUpdate(schedulesDB);
export default schedulesDB;
//# sourceMappingURL=schedules.js.map