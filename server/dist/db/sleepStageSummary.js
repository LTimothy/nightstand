// Heuristic sleep-stage classifier with three improvements over the original
// per-epoch version:
//
//   1. Dense epochs covering the FULL requested period - one 5-min epoch per
//      bucket from periodStart to periodEnd. Buckets without a vitals record
//      use carry-forward (or movement-only) classification. Fixes the visible
//      "gaps in the chart" the user reported (vitals coverage was ~58%).
//
//   2. Sleep-onset / sleep-offset detection. Walks the timeline to find the
//      first sustained "calm" window (HR near baseline AND low movement) -
//      that's when you actually fell asleep, not when you got into bed.
//      Everything before onset and after offset is reclassified as 'awake'.
//      Without this, lying in bed watching TV reads as REM (elevated HR)
//      and inflates "Time slept".
//
//   3. Per-epoch fall-through is unchanged for actually-asleep buckets:
//      DEEP / REM / LIGHT decided by HR vs baseline, breathing, and HR-delta.
//
// Approach (still no ML, fully deterministic):
//   - baselineHR = 10th-percentile HR across the night = the lowest-HR reference
//   - calm movement = not restless (below the 85th percentile or at most 50)
//   - sleep onset = first epoch where (HR ≤ baseline+5) AND calm movement
//     stays true for ≥3 consecutive epochs (~15 min)
//
// Fixed thresholds over heart rate and movement; not validated against
// polysomnography.
const BUCKET_SECONDS = 300;
const SLEEP_HR_DELTA_BPM = 5;
const ONSET_REQUIRED_CALM_BUCKETS = 3; // 15 min of sustained calm marks estimated onset
// Below this share of buckets with a vitals row, onset/offset detection is
// guessing, so the per-epoch stages are kept as-is and the night is flagged.
const MIN_VITALS_COVERAGE = 0.6;
function classifyStages(vitals, movements, periodStart, periodEnd) {
    // Build vitals lookup by 5-min bucket
    const vitalByBucket = new Map();
    for (const v of vitals) {
        const bucket = Math.floor(v.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
        if (!vitalByBucket.has(bucket))
            vitalByBucket.set(bucket, v);
    }
    // Build movement lookup by 5-min bucket
    const moveByBucket = new Map();
    for (const m of movements) {
        const bucket = Math.floor(m.timestamp / BUCKET_SECONDS) * BUCKET_SECONDS;
        moveByBucket.set(bucket, (moveByBucket.get(bucket) || 0) + m.total_movement);
    }
    // Baseline = 10th-percentile HR (the calmest few minutes of the night)
    const hrs = vitals.map((v) => v.heart_rate || 0).filter((h) => h > 0).sort((a, b) => a - b);
    const baselineHR = hrs.length ? hrs[Math.floor(hrs.length * 0.1)] : 60;
    // Movement threshold = 85th percentile = "restless / awake"
    const allMoves = Array.from(moveByBucket.values()).sort((a, b) => a - b);
    const moveThreshold = allMoves.length ? allMoves[Math.floor(allMoves.length * 0.85)] : 100;
    // For sleep-onset detection, "calm" just needs to be below the awake bar.
    // Earlier I used p50 here but that's by-definition strict - half of even
    // a perfectly slept night exceeds it, breaking onset detection. Mirror
    // the awake threshold so onset works whenever HR is low and movement
    // isn't at the awake-restless level.
    const calmMoveThreshold = moveThreshold;
    // HRV quartiles: higher HRV is treated as a REM cue and lower as deep.
    // The HRV estimate is unreliable and this rule is not validated.
    // We tolerate sparse / missing HRV gracefully: if the per-night spread is
    // too narrow (the upstream HRV calc occasionally collapses to a single
    // value when the present_for gate is failing), hrvSpreadOk goes false and
    // the REM branch becomes unreachable for the night, so no REM is
    // assigned from HR alone.
    const hrvVals = vitals.map((v) => v.hrv ?? 0).filter((h) => h > 0).sort((a, b) => a - b);
    const hrvP25 = hrvVals.length ? hrvVals[Math.floor(hrvVals.length * 0.25)] : 0;
    const hrvP75 = hrvVals.length ? hrvVals[Math.floor(hrvVals.length * 0.75)] : 0;
    const hrvSpreadOk = hrvP75 - hrvP25 >= 5; // need at least 5 ms between Q1 and Q3 to be useful
    // REM requires BOTH a top-quartile HRV AND modestly
    // elevated HR vs the night's baseline HR. The previous version
    // produced implausible 40-70% REM nights because three
    // separate OR branches all funneled to REM (hrvHigh on its own, HR ≥
    // baseline+5 on its own, or HR-delta ≥ 4 on its own). Since hrvHigh is
    // by definition the top-25% of HRV values, ≥25% of every night was
    // automatically REM before any other criteria mattered. Now LIGHT is the
    // default for "not deep, not REM", since light is the largest share of
    // typical sleep (about 50-60%, REM 20-25%, Deep 13-23%).
    const REM_HR_DELTA_BPM = 4;
    // Walk every 5-min bucket in the requested period (this is what fixes the
    // chart gaps - we emit an epoch even when vitals are missing).
    const startBucket = Math.floor(periodStart / BUCKET_SECONDS) * BUCKET_SECONDS;
    const endBucket = Math.ceil(periodEnd / BUCKET_SECONDS) * BUCKET_SECONDS;
    const working = [];
    let lastClassifiedSleepStage = 'light';
    for (let b = startBucket; b < endBucket; b += BUCKET_SECONDS) {
        const v = vitalByBucket.get(b);
        const movement = moveByBucket.get(b) ?? 0;
        const hr = v?.heart_rate ?? null;
        const br = v?.breathing_rate ?? null;
        const hrv = v?.hrv ?? null;
        const hrCalm = hr !== null && hr <= baselineHR + SLEEP_HR_DELTA_BPM;
        const moveCalm = !(movement >= calmMoveThreshold && movement > 50);
        const isCalm = hrCalm && moveCalm;
        const isNeutral = hr === null && moveCalm;
        // HRV-driven signal (only meaningful when the per-night HRV spread is
        // reasonable - see hrvSpreadOk above). hrvLow is intentionally unused
        // for now: requiring it for DEEP eats too many epochs (produced 2-4%
        // deep on real nights). "Not high HRV" captures the deep-sleep
        // signature well enough.
        const hrvHigh = hrvSpreadOk && hrv !== null && hrv >= hrvP75;
        let stage;
        if (movement >= moveThreshold && movement > 50) {
            stage = 'awake';
        }
        else if (hr === null) {
            // No vitals this bucket - carry forward the previous sleep stage if
            // movement is low; otherwise treat as light. Avoids leaving holes in
            // the chart while not fabricating "deep sleep" through restless gaps.
            stage = moveCalm ? lastClassifiedSleepStage : 'light';
        }
        else if (hr <= baselineHR + 2 && !hrvHigh) {
            // DEEP: low HR (near baseline) and HRV is NOT in the upper quartile.
            // When HRV is unusable (hrvSpreadOk false), hrvHigh is forced false
            // so this still fires on HR alone.
            stage = 'deep';
        }
        else if (hrvHigh && hr >= baselineHR + REM_HR_DELTA_BPM) {
            // REM: BOTH a top-quartile HRV AND modestly
            // elevated HR (4+ bpm above baseline). Requiring both signals is the
            // key change vs the old classifier - alone, hrvHigh covers ~25% of
            // every night by definition (it's the top quartile), and HR-only or
            // HR-delta gates lit up another huge chunk. The intersection
            // is meant to give roughly 15-25%; that is a target, not a
            // measured agreement with REM.
            stage = 'rem';
        }
        else {
            // LIGHT is the default for "not deep, not REM, not awake", chosen
            // because light is the largest share of typical sleep (50-60%).
            stage = 'light';
        }
        if (stage !== 'awake')
            lastClassifiedSleepStage = stage;
        working.push({ bucket: b, movement, hr, br, hrv, isCalm, isNeutral, stage });
    }
    // Sleep-onset detection: first run of ≥ONSET_REQUIRED_CALM_BUCKETS consecutive
    // calm epochs. Until that point, the user was in bed but awake - relabel to
    // 'awake' so it doesn't count as "Time slept" and the chart shows the
    // pre-sleep period correctly.
    let onsetIdx = -1;
    let calmRun = 0;
    let calmRunStart = -1;
    for (let i = 0; i < working.length; i++) {
        if (working[i].isNeutral)
            continue;
        if (working[i].isCalm) {
            if (calmRun === 0)
                calmRunStart = i;
            calmRun++;
            if (calmRun >= ONSET_REQUIRED_CALM_BUCKETS) {
                onsetIdx = calmRunStart;
                break;
            }
        }
        else {
            calmRun = 0;
        }
    }
    // Sleep-offset detection. The "calm streak walking backward" rule used to
    // be the same as for onset, but it produced wake times that overshot real
    // wake by ~1 hour: phone-in-bed periods after waking have HR/movement
    // patterns very similar to light/REM sleep (low movement, HR a few bpm
    // above baseline) and the classifier had to call them light/REM. The
    // calm-streak rule then happily latched onto those short post-wake
    // sleep-ish bursts and reported wake = end of the latest one.
    //
    // Switch to a *sustained main sleep block* rule for offset: walk backward
    // to find the last run of ≥OFFSET_REQUIRED_SLEEP_BUCKETS consecutive
    // non-awake epochs (= 50 min of continuous classified sleep). The end
    // of that block is the real wake time. Brief 4-5-epoch bursts during
    // phone-in-bed are filtered out because they don't sustain long enough.
    const OFFSET_REQUIRED_SLEEP_BUCKETS = 10; // 50 min of continuous sleep
    let offsetIdx = working.length;
    let sleepRun = 0;
    let sleepRunEnd = -1;
    // Unknown buckets directly after the final sleep block stay asleep.
    let unknownTailEnd = -1;
    for (let i = working.length - 1; i >= 0; i--) {
        if (working[i].isNeutral) {
            if (sleepRun === 0 && unknownTailEnd === -1)
                unknownTailEnd = i;
            continue;
        }
        if (working[i].stage !== 'awake') {
            if (sleepRun === 0)
                sleepRunEnd = unknownTailEnd === -1 ? i : unknownTailEnd;
            sleepRun++;
            if (sleepRun >= OFFSET_REQUIRED_SLEEP_BUCKETS) {
                // First epoch AFTER the sustained sleep block, walking forward.
                offsetIdx = sleepRunEnd + 1;
                break;
            }
        }
        else {
            sleepRun = 0;
            unknownTailEnd = -1;
        }
    }
    const covered = working.filter((w) => w.hr !== null).length;
    const lowCoverage = working.length === 0 || covered / working.length < MIN_VITALS_COVERAGE;
    // If we never found a calm run, leave classifications as-is - the user
    // probably never properly slept (or vitals are too sparse to tell), and
    // the per-epoch heuristic is the best we have.
    if (onsetIdx >= 0 && !lowCoverage) {
        for (let i = 0; i < onsetIdx; i++)
            working[i].stage = 'awake';
        for (let i = offsetIdx; i < working.length; i++)
            working[i].stage = 'awake';
    }
    const epochs = working.map((w) => ({
        startUnix: w.bucket,
        endUnix: w.bucket + BUCKET_SECONDS,
        stage: w.stage,
    }));
    return { epochs, lowCoverage };
}
// The biometrics writer stores 0 when it had no HRV or breathing estimate.
export function toStageVitals(row) {
    return {
        timestamp: row.timestamp,
        heart_rate: row.heart_rate,
        hrv: row.hrv || null,
        breathing_rate: row.breathing_rate || null,
    };
}
// Classify [startUnix, endUnix] and roll the epochs up into per-stage totals.
export function summarizeStages(vitals, movements, startUnix, endUnix) {
    const { epochs: rawEpochs, lowCoverage } = classifyStages(vitals, movements, startUnix, endUnix);
    // Clamp each epoch to the requested period AND drop epochs that fall
    // entirely outside it. Belt-and-suspenders - the SQL query already filters
    // by timestamp range, but the classifier extends each epoch by 300s so the
    // last one could overrun endUnix.
    const epochs = rawEpochs
        .map((e) => ({
        ...e,
        startUnix: Math.max(e.startUnix, startUnix),
        endUnix: Math.min(e.endUnix, endUnix),
    }))
        .filter((e) => e.endUnix > e.startUnix);
    // Roll up totals per stage
    const totals = { awake: 0, rem: 0, light: 0, deep: 0 };
    for (const e of epochs)
        totals[e.stage] += e.endUnix - e.startUnix;
    const totalSeconds = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
    const percentages = {
        awake: Math.round((totals.awake / totalSeconds) * 100),
        rem: Math.round((totals.rem / totalSeconds) * 100),
        light: Math.round((totals.light / totalSeconds) * 100),
        deep: Math.round((totals.deep / totalSeconds) * 100),
    };
    return { epochs, totals, percentages, totalSeconds, asleepSeconds: totals.light + totals.rem + totals.deep, lowCoverage };
}
//# sourceMappingURL=sleepStageSummary.js.map