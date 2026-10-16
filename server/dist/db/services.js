// LowDB, stores the services in /persistent/free-sleep-data/lowdb/servicesDB.json
import _ from 'lodash';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import config from '../config.js';
const defaultData = {
    biometrics: {
        enabled: false,
        jobs: {
            installation: {
                name: 'Biometrics installation',
                message: '',
                status: 'not_started',
                description: 'Whether or not biometrics was installed successfully',
                timestamp: '',
            },
            stream: {
                name: 'Biometrics stream',
                message: '',
                status: 'not_started',
                description: 'Consumes the sensor data as a stream and calculates biometrics',
                timestamp: '',
            },
            analyzeSleepLeft: {
                name: 'Analyze sleep - left',
                message: '',
                status: 'not_started',
                description: 'Analyzes sleep period',
                timestamp: '',
            },
            analyzeSleepRight: {
                name: 'Analyze sleep - right',
                message: '',
                status: 'not_started',
                description: 'Analyzes sleep period',
                timestamp: '',
            },
            calibrateLeft: {
                name: 'Calibration job - Left',
                message: '',
                status: 'not_started',
                description: 'Calculates presence thresholds for cap sensor data',
                timestamp: '',
            },
            calibrateRight: {
                name: 'Calibration job - Right',
                message: '',
                status: 'not_started',
                description: 'Calculates presence thresholds for cap sensor data',
                timestamp: '',
            },
            pumpLeft: {
                name: 'Pump health - left',
                message: '',
                status: 'not_started',
                description: 'Watches for a stalled circulation pump while the heater/cooler is active',
                timestamp: '',
            },
            pumpRight: {
                name: 'Pump health - right',
                message: '',
                status: 'not_started',
                description: 'Watches for a stalled circulation pump while the heater/cooler is active',
                timestamp: '',
            }
        }
    }
};
const file = new JSONFile(`${config.lowDbFolder}servicesDB.json`);
const servicesDB = new Low(file, defaultData);
await servicesDB.read();
// Allows us to add default values to the services if users have existing servicesDB.json data
servicesDB.data = _.merge({}, defaultData, servicesDB.data);
// A job status stuck at 'started' cannot be legitimately in progress across
// a process restart, since the python jobs that write these statuses are
// spawned fresh per invocation and hold no other state. Left there, a job
// whose status update got lost (e.g. clobbered by the pre-updateServices
// concurrent-write race) or whose process was killed mid-run shows as
// perpetually "running" on the Status page even though nothing is actually
// happening. Reconcile once at startup so a stale status reads as the
// failure it is.
for (const job of Object.values(servicesDB.data.biometrics.jobs)) {
    if (job.status === 'started') {
        job.status = 'failed';
        job.message = 'Stale "started" status found at server startup. The job likely never finished its previous run.';
    }
}
await servicesDB.write();
// Serializes read-merge-write updates against servicesDB. The biometrics
// python jobs (left/right analyzeSleep, calibrateLeft/Right, pumpLeft/Right)
// POST their status independently and can land within milliseconds of each
// other; without this, two concurrent read()s can both load the pre-update
// state, and the second write() silently clobbers the first job's status
// update (observed: analyzeSleepLeft's "failed" write lost to
// analyzeRight's write).
let updateQueue = Promise.resolve();
export const updateServices = (partial) => {
    const result = updateQueue.then(async () => {
        await servicesDB.read();
        if (typeof partial === 'function') {
            if (partial(servicesDB.data) === false)
                return servicesDB.data;
        }
        else {
            _.merge(servicesDB.data, partial);
        }
        await servicesDB.write();
        return servicesDB.data;
    });
    // Swallow rejection on the shared chain so one failed update doesn't
    // permanently wedge the queue for subsequent updates.
    updateQueue = result.catch(() => undefined);
    return result;
};
export default servicesDB;
//# sourceMappingURL=services.js.map