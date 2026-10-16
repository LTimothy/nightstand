import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
it('prepares upstream day saves while retaining unrelated and future data', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upstream-data-'));
    try {
        const alarm = { enabled: true, time: '08:00', duration: 300, vibrationIntensity: 70,
            vibrationPattern: 'rise', alarmTemperature: 80 };
        writeFileSync(path.join(folder, 'schedulesDB.json'), JSON.stringify({
            left: { monday: { alarm, alarms: [{ ...alarm, enabled: false }, alarm], temperatures: {}, power: {} } },
            future: { preserved: true },
        }));
        writeFileSync(path.join(folder, 'settingsDB.json'), JSON.stringify({
            temperatureFormat: 'level', left: { taps: { quadTap: { type: 'base_control' } }, oneOffAlarm: { enabled: true } },
            future: { preserved: true },
        }));
        const result = spawnSync('python3', ['../scripts/prepare-upstream.py', folder], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const schedules = JSON.parse(readFileSync(path.join(folder, 'schedulesDB.json'), 'utf8'));
        const settings = JSON.parse(readFileSync(path.join(folder, 'settingsDB.json'), 'utf8'));
        assert.equal(schedules.left.monday.alarms, undefined);
        assert.equal(schedules.left.monday.alarm.enabled, true);
        assert.equal(schedules.left.monday.alarm.duration, 180);
        assert.deepEqual(schedules.future, { preserved: true });
        assert.equal(settings.temperatureFormat, 'fahrenheit');
        assert.deepEqual(settings.left.taps.quadTap, {
            type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none',
        });
        assert.equal(settings.left.oneOffAlarm.enabled, true);
        assert.deepEqual(settings.future, { preserved: true });
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
it('turns a set temperature tap into an alarm dismiss tap for upstream', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upstream-data-'));
    try {
        writeFileSync(path.join(folder, 'schedulesDB.json'), '{}');
        writeFileSync(path.join(folder, 'settingsDB.json'), JSON.stringify({
            right: { taps: { quadTap: { type: 'set_temperature', temperatureF: 76 } } },
        }));
        const result = spawnSync('python3', ['../scripts/prepare-upstream.py', folder], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const settings = JSON.parse(readFileSync(path.join(folder, 'settingsDB.json'), 'utf8'));
        assert.deepEqual(settings.right.taps.quadTap, {
            type: 'alarm', behavior: 'dismiss', snoozeDuration: 300, inactiveAlarmBehavior: 'none',
        });
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
it('does not enable a disabled alarm when no enabled alarm remains', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'upstream-data-'));
    try {
        writeFileSync(path.join(folder, 'settingsDB.json'), '{}');
        writeFileSync(path.join(folder, 'schedulesDB.json'), JSON.stringify({ left: { monday: {
                    alarm: { enabled: true, time: '06:00', duration: 30 },
                    alarms: [{ enabled: false, time: '09:00', duration: 300 }],
                } } }));
        const result = spawnSync('python3', ['../scripts/prepare-upstream.py', folder], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const data = JSON.parse(readFileSync(path.join(folder, 'schedulesDB.json'), 'utf8'));
        assert.equal(data.left.monday.alarm.enabled, false);
        assert.equal(data.left.monday.alarm.time, '09:00');
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
});
//# sourceMappingURL=upstreamPreparation.test.js.map