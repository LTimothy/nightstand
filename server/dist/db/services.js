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
// Sensor temperatures and job timestamps change every minute. They are kept
// here and laid over every read; the file is rewritten only when anything
// else changes, which spares the flash about 4300 rewrites a day.
const live = { timestamps: {} };
const remember = (data) => {
    live.sensorTemps = data.biometrics.sensorTemps;
    for (const [key, job] of Object.entries(data.biometrics.jobs)) {
        if (job.timestamp !== undefined)
            live.timestamps[key] = job.timestamp;
    }
};
const overlay = (data) => {
    if (live.sensorTemps)
        data.biometrics.sensorTemps = live.sensorTemps;
    for (const [key, timestamp] of Object.entries(live.timestamps)) {
        const job = data.biometrics.jobs[key];
        if (job)
            job.timestamp = timestamp;
    }
};
// The file's content minus what lives in memory.
const durable = (data) => JSON.stringify({
    ...data,
    biometrics: {
        ...data.biometrics,
        sensorTemps: undefined,
        jobs: _.mapValues(data.biometrics.jobs, job => ({ ...job, timestamp: undefined })),
    },
});
class ServicesLow extends Low {
    async read() {
        await super.read();
        if (this.data?.biometrics?.jobs)
            overlay(this.data);
    }
}
const file = new JSONFile(`${config.lowDbFolder}servicesDB.json`);
const servicesDB = new ServicesLow(file, defaultData);
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
// The stream's last heartbeat used to be on disk, so a restarted server gave
// it five minutes to check in. Starting the clock at startup keeps that.
if (Number.isFinite(Date.parse(servicesDB.data.biometrics.jobs.stream.timestamp ?? ''))) {
    live.timestamps.stream = new Date().toISOString();
}
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
        const before = durable(servicesDB.data);
        if (typeof partial === 'function') {
            if (partial(servicesDB.data) === false)
                return servicesDB.data;
        }
        else {
            _.merge(servicesDB.data, partial);
        }
        remember(servicesDB.data);
        if (durable(servicesDB.data) !== before)
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