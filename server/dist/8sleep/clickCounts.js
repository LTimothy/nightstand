const MAX_AGE_SECONDS = 10;
const MATCH_WINDOW_SECONDS = 1;
const GESTURE_BY_CONTROL = { top: 'tripleTap', bottom: 'doubleTap' };
let records = [];
let pending = [];
let done = new Map();
const listeners = new Set();
const keyOf = (side, gesture, timestamp) => `${side}:${gesture}:${timestamp}`;
const prune = (now) => {
    records = records.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
    pending = pending.filter(entry => now - entry.seen <= MAX_AGE_SECONDS);
    done = new Map([...done].filter(([, seen]) => now - seen <= MAX_AGE_SECONDS));
};
// Exact timestamp first, otherwise the closest entry within the match window.
const find = (list, side, gesture, timestamp) => {
    let best = -1;
    list.forEach((entry, index) => {
        if (entry.side !== side || entry.gesture !== gesture)
            return;
        const gap = Math.abs(entry.timestamp - timestamp);
        if (gap > MATCH_WINDOW_SECONDS)
            return;
        if (best < 0 || gap < Math.abs(list[best].timestamp - timestamp))
            best = index;
    });
    return best;
};
export function noteButtonTap(record, nowSeconds) {
    prune(nowSeconds);
    const gesture = record.control && record.control !== 'middle' ? GESTURE_BY_CONTROL[record.control] : undefined;
    if (!record.side || !gesture)
        return;
    const key = keyOf(record.side, gesture, record.timestamp);
    if (done.has(key) || records.some(entry => keyOf(entry.side, entry.gesture, entry.timestamp) === key))
        return;
    const waiting = find(pending, record.side, gesture, record.timestamp);
    if (waiting >= 0) {
        pending.splice(waiting, 1);
        done.set(key, nowSeconds);
        if (record.count > 1)
            listeners.forEach(listener => listener(record.side, gesture, record.count - 1));
        return;
    }
    records.push({ side: record.side, gesture, timestamp: record.timestamp, seen: nowSeconds, count: record.count });
}
// Returns the firmware's count for this tap and removes it, or undefined if no record arrived yet.
export function claimClicks(side, gesture, tapTimestamp, nowSeconds) {
    prune(nowSeconds);
    const index = find(records, side, gesture, tapTimestamp);
    if (index < 0)
        return undefined;
    const [claimed] = records.splice(index, 1);
    done.set(keyOf(side, gesture, claimed.timestamp), nowSeconds);
    return claimed.count;
}
// A tap stepped once without a count; a record arriving soon fires the listeners with count - 1.
export function markPending(side, gesture, tapTimestamp, nowSeconds) {
    prune(nowSeconds);
    pending.push({ side, gesture, timestamp: tapTimestamp, seen: nowSeconds });
}
export function onLateClicks(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function resetClickCounts() {
    records = [];
    pending = [];
    done = new Map();
    listeners.clear();
}
//# sourceMappingURL=clickCounts.js.map