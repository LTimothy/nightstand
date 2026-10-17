import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { minutesAfterOn, temperatureInPowerWindow, wakeFromNight, wakeInNight } from './rhythmWake.js';
import { alarmAt, nightOf, WORKDAY } from '../jobs/rhythms/rhythmsTestData.js';
describe('rhythmWake', () => {
    it('counts minutes from power on across midnight', () => {
        assert.equal(minutesAfterOn('06:30', '22:00'), 510);
        assert.equal(minutesAfterOn('22:00', '22:00'), 0);
    });
    it('wakes at the earliest enabled alarm inside the night', () => {
        assert.equal(wakeFromNight(WORKDAY), '06:30');
        const alarms = [alarmAt('06:50'), alarmAt('05:00', { enabled: false }), alarmAt('06:10'), alarmAt('09:00')];
        assert.equal(wakeFromNight(nightOf({ on: '22:00', off: '07:00', alarms })), '06:10');
    });
    it('reads the single alarm form and falls back to the turn off', () => {
        const single = { ...nightOf({ on: '22:00', off: '07:00' }), alarm: alarmAt('06:45'), alarms: [] };
        assert.equal(wakeFromNight(single), '06:45');
        assert.equal(wakeFromNight(nightOf({ on: '22:00', off: '07:00', alarms: [alarmAt('06:30', { enabled: false })] })), '07:00');
        assert.equal(wakeFromNight(nightOf({ on: '22:00', off: '07:00', alarms: [alarmAt('08:00')] })), '07:00');
    });
    it('keeps a wake time inside the night, a full day when off equals on', () => {
        const power = WORKDAY.power;
        assert.equal(wakeInNight('07:00', power), true);
        assert.equal(wakeInNight('07:01', power), false);
        assert.equal(wakeInNight('21:59', { ...power, on: '22:00', off: '22:00' }), true);
    });
});
describe('temperatureInPowerWindow', () => {
    const power = { on: '22:00', off: '06:00', onTemperature: 82, enabled: true };
    it('is strictly inside the night, across midnight', () => {
        assert.equal(temperatureInPowerWindow('23:45', power), true);
        assert.equal(temperatureInPowerWindow('05:59', power), true);
        assert.equal(temperatureInPowerWindow('22:00', power), false);
        assert.equal(temperatureInPowerWindow('06:00', power), false);
        assert.equal(temperatureInPowerWindow('12:00', power), false);
    });
    it('treats a full-day night as 24 hours and a malformed time as outside', () => {
        assert.equal(temperatureInPowerWindow('21:59', { ...power, off: '22:00' }), true);
        assert.equal(temperatureInPowerWindow('7:00', power), false);
        assert.equal(temperatureInPowerWindow('24:00', power), false);
    });
});
//# sourceMappingURL=rhythmWake.test.js.map