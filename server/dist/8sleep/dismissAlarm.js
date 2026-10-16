import cbor from 'cbor';
import { connectFrankenWithin } from './frankenServer.js';
import memoryDB from '../db/memoryDB.js';
import { activeAlarms } from '../jobs/activeAlarms.js';
// Replace only this side's running alarm. An unscoped clear may stop both sides.
export async function dismissAlarm(side, options = {}) {
    if (!memoryDB.data[side].isAlarmVibrating && !activeAlarms.has(side))
        return;
    const command = side === 'left' ? 'ALARM_LEFT' : 'ALARM_RIGHT';
    const connection = await connectFrankenWithin(options, command);
    // The alarm may have ended while the connection was unavailable.
    if (!memoryDB.data[side].isAlarmVibrating && !activeAlarms.has(side))
        return;
    await connection.callFunction(command, cbor.encode({
        pl: 1, du: 1, pi: 'double', tt: Math.floor(Date.now() / 1_000),
    }).toString('hex'));
}
//# sourceMappingURL=dismissAlarm.js.map