import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import deviceStatus from '../routes/deviceStatus/deviceStatus.js';
import alarm from '../routes/alarm/alarm.js';
import missedAlarms from '../routes/alarm/missedAlarms.js';
import execute from '../routes/execute/execute.js';
import jobs from '../routes/jobs/jobs.js';
import settings from '../routes/settings/settings.js';
import services from '../routes/services/services.js';
import firmware from '../routes/services/firmware.js';
import schedules from '../routes/schedules/schedules.js';
import rhythms from '../routes/rhythms/rhythms.js';
import sleep from '../routes/metrics/sleep.js';
import movement from '../routes/metrics/movement.js';
import vitals from '../routes/metrics/vitals.js';
import sleepScore from '../routes/metrics/sleepScore.js';
import sleepStages from '../routes/metrics/sleepStages.js';
import presence from '../routes/metrics/presence.js';
import logs from '../routes/logs/logs.js';
import serverStatus from '../routes/serverStatus/serverStatus.js';
import baseControl from '../routes/baseControl/baseControl.js';
import update from '../routes/update/update.js';
import { setLeaveHook, setInUseCheck } from '../routes/update/update.js';
import { prepareToLeaveRhythms } from '../jobs/rhythms/handoff.js';
import { bedInUseReasons } from '../jobs/bedInUse.js';
import { leaveAlarmLedger } from '../jobs/alarmLedger.js';
import metricsServer from '../routes/metricsServer/metricsServer.js';
import storage from '../routes/storage/storage.js';
import memory from '../routes/memory/memory.js';
import calibration from '../routes/calibration/calibration.js';
import changelog from '../routes/changelog/changelog.js';
import logger from '../logger.js';
import { registerErrorHandlers } from './errorHandlers.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export default function (app) {
    logger.debug('Registering routes...');
    app.use('/api/', alarm);
    app.use('/api/', missedAlarms);
    app.use('/api/', deviceStatus);
    app.use('/api/', execute);
    app.use('/api/', schedules);
    app.use('/api/', rhythms);
    app.use('/api/', jobs);
    app.use('/api/', settings);
    app.use('/api/', services);
    app.use('/api/', firmware);
    app.use('/api/metrics/', movement);
    app.use('/api/metrics/', sleep);
    app.use('/api/metrics/', vitals);
    app.use('/api/metrics/', sleepScore);
    app.use('/api/metrics/', sleepStages);
    app.use('/api/metrics/', presence);
    app.use('/api/logs', logs);
    app.use('/api/serverStatus', serverStatus);
    app.use('/api/', baseControl);
    setLeaveHook(async (reason, { handBack }) => {
        leaveAlarmLedger();
        if (handBack)
            await prepareToLeaveRhythms(reason);
    });
    setInUseCheck(() => bedInUseReasons());
    app.use('/api/update', update);
    app.use('/api/', metricsServer);
    app.use('/api/storage', storage);
    app.use('/api/memory', memory);
    app.use('/api/calibration', calibration);
    app.use('/api/changelog', changelog);
    app.use('/api', (req, res) => {
        res.status(404).json({ error: { message: 'Not Found' } });
    });
    registerErrorHandlers(app);
    // --- Static files for the SPA
    app.use(express.static(path.join(__dirname, '../../public')));
    // --- SPA catch-all (MUST be last)
    app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.resolve(__dirname, '../../public', 'index.html'));
    });
    logger.debug('Registered routes!');
}
//# sourceMappingURL=routes.js.map