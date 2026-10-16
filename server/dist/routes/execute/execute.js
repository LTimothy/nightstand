import express from 'express';
import { frankenCommands, executeFunction } from '../../8sleep/deviceApi.js';
import { alarmFromExecuteArg, normalizeExecuteArg } from './executeHelpers.js';
import { recordActiveAlarm } from '../../jobs/activeAlarms.js';
import { noteManualPowerChange } from '../../jobs/manualPowerChange.js';
const router = express.Router();
router.post('/execute', async (req, res) => {
    const { command, arg } = (req.body ?? {});
    // Basic validation
    if (typeof command !== 'string' || !Object.hasOwn(frankenCommands, command)) {
        res.status(400).json({ message: 'Invalid command' });
        return;
    }
    const normalizedArg = normalizeExecuteArg(command, arg);
    if (normalizedArg === undefined) {
        res.status(400).json({ message: `Invalid arg for ${command}` });
        return;
    }
    const isAlarm = command === 'ALARM_LEFT' || command === 'ALARM_RIGHT';
    const alarm = isAlarm ? alarmFromExecuteArg(normalizedArg) : undefined;
    if (isAlarm && !alarm) {
        res.status(400).json({
            message: `Invalid arg for ${command}: raw alarms require a valid payload with tt at or before the current Unix time`,
        });
        return;
    }
    if (command === 'LEFT_TEMP_DURATION')
        noteManualPowerChange('left');
    if (command === 'RIGHT_TEMP_DURATION')
        noteManualPowerChange('right');
    // Execute the 8sleep command
    await executeFunction(command, normalizedArg);
    if (alarm)
        await recordActiveAlarm(command === 'ALARM_LEFT' ? 'left' : 'right', alarm);
    // Respond with success
    res.json({ success: true, message: `Command '${command}' executed successfully.` });
    return;
});
export default router;
//# sourceMappingURL=execute.js.map