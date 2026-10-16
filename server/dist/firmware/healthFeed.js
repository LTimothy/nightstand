import { HEALTH_MESSAGES, FIRMWARE_FRESH_SECONDS } from './firmwareSchema.js';
const severity = (code) => ['write-failures', 'samples-dropped'].includes(code) ? 'warning'
    : ['bus-timeout', 'device-missing', 'pump-running', 'pump-stopped', 'throttling-disabled'].includes(code) ? 'diagnostic' : 'info';
export class HealthFeed {
    incidents = [];
    counters = new Map();
    counterTimes = new Map();
    session;
    lastSensor;
    firstObservation;
    beginSession(session, now) {
        if (session === this.session)
            return;
        for (const incident of this.incidents)
            incident.historical = true;
        this.counters.clear();
        this.counterTimes.clear();
        this.lastSensor = undefined;
        this.firstObservation = now;
        this.session = session;
    }
    sensor(timestamp) { this.lastSensor = Math.max(this.lastSensor ?? 0, timestamp); }
    observe(record, session, now) {
        this.beginSession(session, now);
        let count = 1;
        if (record.code === 'write-failures' || record.code === 'samples-dropped') {
            if (record.value === undefined)
                return;
            if (record.timestamp < (this.counterTimes.get(record.code) ?? 0))
                return;
            this.counterTimes.set(record.code, record.timestamp);
            const before = this.counters.get(record.code);
            this.counters.set(record.code, record.value);
            if (before === undefined || record.value <= before)
                return;
            count = record.value - before;
        }
        this.prune(now);
        const previous = this.incidents.find(item => item.code === record.code && item.side === record.side);
        if (previous) {
            if (record.timestamp < previous.lastSeen)
                return;
            previous.count = Math.min(Number.MAX_SAFE_INTEGER, previous.count + count);
            previous.lastSeen = record.timestamp;
            previous.receivedAt = record.receivedAt;
            previous.details = record.details;
            delete previous.recoveredAt;
            delete previous.historical;
        }
        else {
            this.incidents.push({ code: record.code, message: HEALTH_MESSAGES[record.code], severity: severity(record.code),
                side: record.side, source: record.source, count, firstSeen: record.timestamp,
                lastSeen: record.timestamp, receivedAt: record.receivedAt, details: record.details });
        }
        if (record.code === 'pump-running') {
            const stopped = this.incidents.find(item => item.code === 'pump-stopped' && item.side === record.side);
            if (stopped && stopped.lastSeen <= record.timestamp)
                stopped.recoveredAt = record.timestamp;
        }
        this.prune(now);
    }
    prune(now) {
        this.incidents = this.incidents.filter(item => now - item.lastSeen <= 86400);
        while (this.incidents.length > 200 || JSON.stringify(this.incidents).length * 3 > 256 * 1024)
            this.incidents.shift();
    }
    snapshot(now) {
        this.prune(now);
        const sensorFresh = this.lastSensor !== undefined && now - this.lastSensor <= FIRMWARE_FRESH_SECONDS;
        const incidents = this.incidents.map(item => ({ ...item,
            freshness: item.historical ? 'Historical' : now - item.lastSeen <= FIRMWARE_FRESH_SECONDS ? 'Recent' : 'No recent readings' }));
        const missingSince = this.lastSensor ?? this.firstObservation;
        const interrupted = !sensorFresh && missingSince !== undefined && now - missingSince >= 120
            && incidents.some(item => item.code === 'bus-timeout' && item.freshness === 'Recent');
        return { sensorFresh, incidents, interrupted };
    }
}
//# sourceMappingURL=healthFeed.js.map