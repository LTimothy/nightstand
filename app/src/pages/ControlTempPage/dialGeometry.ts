// The ring is drawn in a 280 x 240 viewBox around (140, 140). Angles are SVG angles: 0 at +x, clockwise.
export const DIAL_WIDTH = 280;
export const DIAL_HEIGHT = 240;
const CENTER = 140;
export const TRACK_RADIUS = 118;
export const TRACK_WIDTH = 6;
export const SCALE_MIN = -10;
export const SCALE_MAX = 10;
// The mark for where the bed is now crosses the track.
export const NOTCH = { inner: 110, outer: 126 };
const TICK = { inner: 129, minor: 133, major: 137 };
// The end labels sit this far below the ends of the track.
const LABEL_DROP = 26;

const round = (value: number) => Math.round(value * 100) / 100;

// 12 degrees a level: -10 at 150 degrees, 0 at 12 o'clock, +10 at 390.
export function levelAngle(level: number): number {
  return 150 + (level - SCALE_MIN) * 12;
}

export function dialPoint(level: number, radius = TRACK_RADIUS): { x: number; y: number } {
  const radians = levelAngle(level) * Math.PI / 180;
  return { x: CENTER + radius * Math.cos(radians), y: CENTER + radius * Math.sin(radians) };
}

export function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, level)) : 0;
}

const arc = (from: number, to: number, large: 0 | 1) => {
  const start = dialPoint(from);
  const end = dialPoint(to);
  return `M ${round(start.x)} ${round(start.y)} A ${TRACK_RADIUS} ${TRACK_RADIUS} 0 ${large} 1 ${round(end.x)} ${round(end.y)}`;
};

// Arcs of a fifth of a level from `from` up to `to`, each overlapping the next by 30% so no seam shows.
// Each carries its middle level so it can take that level's scale colour.
export function bandSegments(from: number, to: number): Array<{ d: string; level: number }> {
  const count = Math.max(1, Math.ceil(Math.abs(to - from) * 5));
  return Array.from({ length: count }, (_, index) => {
    const a = from + (to - from) * index / count;
    const b = from + (to - from) * Math.min(count, index + 1.3) / count;
    return { d: arc(a, b, 0), level: (a + b) / 2 };
  });
}

export function offArc(): string {
  return arc(SCALE_MIN, SCALE_MAX, 1);
}

// The span grows from 0 toward the target: clockwise when warm, counter-clockwise when cool.
export function fillRange(target: number): [number, number] | undefined {
  const level = clampLevel(target);
  if (level === 0) return undefined;
  return level > 0 ? [0, level] : [level, 0];
}

export function radialLine(level: number, inner: number, outer: number) {
  const from = dialPoint(level, inner);
  const to = dialPoint(level, outer);
  return { x1: round(from.x), y1: round(from.y), x2: round(to.x), y2: round(to.y) };
}

export function ticks() {
  return Array.from({ length: SCALE_MAX - SCALE_MIN + 1 }, (_, index) => {
    const level = SCALE_MIN + index;
    const major = level % 5 === 0;
    return { level, major, ...radialLine(level, TICK.inner, major ? TICK.major : TICK.minor) };
  });
}

export function endLabels(): Array<{ level: number; x: number; y: number }> {
  return [SCALE_MIN, SCALE_MAX].map(level => {
    const end = dialPoint(level);
    return { level, x: round(end.x), y: round(end.y + LABEL_DROP) };
  });
}

// The level under a point in the viewBox. Below the centre the ring is open: each half snaps to its end.
export function pointLevel(x: number, y: number): number {
  let angle = Math.atan2(y - CENTER, x - CENTER) * 180 / Math.PI;
  if (angle < 90) angle += 360;
  return clampLevel(SCALE_MIN + (angle - 150) / 12);
}
