import { z } from 'zod';
export const FIRMWARE_FRESH_SECONDS = 60;
const EpochSchema = z.number().finite().nonnegative();
const identity = {
    timestamp: EpochSchema,
    receivedAt: EpochSchema,
    source: z.enum(['RAW', 'NATS']),
    sequence: z.union([
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(value => BigInt(value) <= 18446744073709551615n),
    ]).nullable(),
    index: z.number().int().min(0).max(1024 * 1024 - 1),
};
export const ThermostatSchema = z.object({
    ...identity, kind: z.literal('thermostat'), side: z.enum(['left', 'right']),
    targetC: z.number().finite().min(-40).max(100).nullable(),
    power: z.number().finite().min(-100).max(100).nullable(), valid: z.boolean(), enabled: z.boolean(),
}).strict();
export const HEALTH_MESSAGES = {
    moisture: 'Moisture conditions updated.',
    'pump-interlock': 'Temperature control paused while the pump is stopped.',
    'pump-running': 'Water pump running',
    'pump-stopped': 'Water pump stopped',
    'presence-low': 'Presence sensor reported a low signal.',
    'sensor-reset': 'Bed sensor restarted.',
    'bus-timeout': 'Sensor bus timeout count',
    'device-missing': 'A device connection was not found.',
    'water-calibration': 'Water sensor reports missing calibration.',
    'water-calibrated': 'Water sensor calibration reported.',
    'write-failures': 'The Pod could not save some sensor data.',
    'samples-dropped': 'Some sensor readings were lost.',
    'throttling-disabled': 'Firmware reported throttling disabled.',
};
export const HealthCodeSchema = z.enum([
    'moisture', 'pump-interlock', 'pump-running', 'pump-stopped', 'presence-low', 'sensor-reset',
    'bus-timeout', 'device-missing', 'water-calibration', 'water-calibrated', 'write-failures', 'samples-dropped', 'throttling-disabled',
]);
export const HealthSchema = z.object({
    ...identity, kind: z.literal('health'), code: HealthCodeSchema, side: z.enum(['left', 'right']).nullable(),
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    details: z.object({
        temperatureC: z.number().finite().min(-40).max(100).optional(),
        humidity: z.number().finite().min(0).max(100).optional(),
        dewPointC: z.number().finite().min(-40).max(100).optional(),
        bus: z.number().int().min(0).max(99).optional(),
        port: z.string().max(24).regex(/^\d{1,2}-\d{1,2}(?:\.\d{1,2}){0,3}$/).optional(),
        raw: z.number().finite().min(-100).max(100).optional(),
        calibrated: z.boolean().optional(),
        empty: z.number().finite().min(-100).max(100).optional(),
        full: z.number().finite().min(-100).max(100).optional(),
    }).strict(),
}).strict();
const SensorSchema = z.object({ ...identity, kind: z.literal('sensor') }).strict();
export const TapSchema = z.object({
    ...identity, kind: z.literal('tap'), origin: z.enum(['buttonEvent', 'tap-gesture', 'alarm-dismiss-log']),
    side: z.enum(['left', 'right']).nullable(), count: z.number().int().min(1).max(16),
    control: z.enum(['top', 'bottom', 'middle']).optional(),
}).strict();
export const WaterSchema = z.object({ ...identity, kind: z.literal('water'), side: z.enum(['left', 'right']),
    waterC: z.number().finite().min(-40).max(100).nullable() }).strict();
export const PumpSchema = z.object({ ...identity, kind: z.literal('pump'), side: z.enum(['left', 'right']),
    rpm: z.number().finite().min(0).max(20000).nullable(), water: z.boolean(),
    loopC: z.number().finite().min(-40).max(100).nullable() }).strict();
export const FirmwareRecordSchema = z.discriminatedUnion('kind', [
    ThermostatSchema, HealthSchema, SensorSchema, TapSchema, WaterSchema, PumpSchema,
]);
export const FirmwareBatchSchema = z.object({
    session: z.string().regex(/^[a-f0-9]{32}$/), records: z.array(FirmwareRecordSchema).min(1).max(128),
}).strict();
//# sourceMappingURL=firmwareSchema.js.map