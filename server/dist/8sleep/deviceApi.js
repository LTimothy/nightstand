import { connectFrankenWithin } from './frankenServer.js';
import logger from '../logger.js';
export const frankenCommands = {
    HELLO: '0',
    SET_TEMP: '1',
    SET_ALARM: '2',
    // RESET: '3',
    // FORCE_RESET: '4',
    ALARM_LEFT: '5',
    ALARM_RIGHT: '6',
    // FORMAT: '7',
    SET_SETTINGS: '8',
    LEFT_TEMP_DURATION: '9',
    RIGHT_TEMP_DURATION: '10',
    TEMP_LEVEL_LEFT: '11',
    TEMP_LEVEL_RIGHT: '12',
    PRIME: '13',
    DEVICE_STATUS: '14',
    ALARM_CLEAR: '16',
};
// A function arg is worked out once the Pod is reachable, for values that
// depend on when the command is sent.
export async function executeFunction(command, arg = 'empty', options = {}) {
    logger.debug(`Executing command | command: ${command} | arg: ${typeof arg === 'string' ? arg : 'when sent'}`);
    const franken = await connectFrankenWithin(options, command);
    await franken.callFunction(command, typeof arg === 'string' ? arg : arg());
}
//# sourceMappingURL=deviceApi.js.map