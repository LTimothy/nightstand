export const COOLING_WARNING_TEXT = 'Water is warming while cooling is requested';
export class CoolingWarning {
    history = [];
    start;
    last;
    target;
    candidate;
    peak;
    since;
    acknowledged;
    reset() {
        this.history = [];
        this.start = this.last = this.target = this.candidate = this.peak = this.since = this.acknowledged = undefined;
    }
    observe(sample) {
        const { timestamp, waterC, targetC } = sample;
        if (!sample.isOn || sample.priming || !sample.valid || !sample.enabled
            || waterC === null || targetC === null || sample.rpm === null || sample.rpm < 200
            || !sample.water || sample.loopC === null || ![waterC, targetC, sample.loopC, sample.rpm].every(Number.isFinite)) {
            this.reset();
            return;
        }
        if (targetC !== this.target || (this.last !== undefined && timestamp - this.last > 60))
            this.reset();
        if (this.last !== undefined && timestamp < this.last)
            return;
        const newWater = this.last === undefined || timestamp > this.last;
        if (newWater) {
            this.target = targetC;
            this.start ??= timestamp;
            this.last = timestamp;
            this.history = this.history.filter(item => timestamp - item.timestamp <= 3600);
            // Keep only samples that can still be the preceding hour's minimum.
            while (this.history.length && this.history[this.history.length - 1].waterC >= waterC)
                this.history.pop();
            this.history.push({ timestamp, waterC });
            if (this.history.length > 4096) {
                this.reset();
                return;
            }
        }
        const minimum = this.history[0].waterC;
        const warm = this.start !== undefined && timestamp - this.start >= 3600
            && waterC - targetC >= 0.5 && waterC - minimum >= 1 && sample.power !== null && sample.power < 0;
        if (!warm || (this.peak !== undefined && this.peak - waterC >= 0.25)) {
            this.candidate = this.peak = this.since = this.acknowledged = undefined;
            return;
        }
        // New control evidence can clear a candidate, but only new water samples advance dwell.
        if (!newWater)
            return;
        this.candidate ??= timestamp;
        this.peak = Math.max(this.peak ?? waterC, waterC);
        if (timestamp - this.candidate >= 1200)
            this.since ??= timestamp;
    }
    acknowledge(since) { if (this.since === since)
        this.acknowledged = since; }
    snapshot(now) {
        if (this.last !== undefined && now - this.last > 60)
            this.reset();
        const state = this.last === undefined ? 'unavailable' : this.since !== undefined ? 'warning'
            : this.start !== undefined && now - this.start < 3600 ? 'collecting' : 'monitoring';
        return { state, active: this.since !== undefined, notice: this.since !== undefined && this.acknowledged !== this.since,
            since: this.since, message: COOLING_WARNING_TEXT };
    }
}
//# sourceMappingURL=coolingWarning.js.map