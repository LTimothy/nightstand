import { expect, it } from 'vitest';
import {
  DIAL_HEIGHT, DIAL_WIDTH, NOTCH, TRACK_RADIUS, bandSegments, clampLevel, dialPoint, endLabels, fillRange, levelAngle,
  offArc, pointLevel, radialLine, ticks,
} from './dialGeometry';

it('spreads -10..+10 over 240 degrees with 0 at 12 o\'clock', () => {
  expect(levelAngle(-10)).toBe(150);
  expect(levelAngle(0)).toBe(270);
  expect(levelAngle(10)).toBe(390);
  expect(levelAngle(1) - levelAngle(0)).toBe(12);
});

it('draws in a 280 x 240 box around (140, 140)', () => {
  expect([DIAL_WIDTH, DIAL_HEIGHT]).toEqual([280, 240]);
  const top = dialPoint(0);
  expect(top.x).toBeCloseTo(140);
  expect(top.y).toBeCloseTo(140 - TRACK_RADIUS);
  const left = dialPoint(-10);
  expect(left.x).toBeCloseTo(37.81, 2);
  expect(left.y).toBeCloseTo(199, 5);
  const right = dialPoint(10);
  expect(right.x).toBeCloseTo(242.19, 2);
  expect(right.y).toBeCloseTo(199, 5);
});

it('clamps levels to the scale and reads a bad value as 0', () => {
  expect(clampLevel(14)).toBe(10);
  expect(clampLevel(-11)).toBe(-10);
  expect(clampLevel(Number.NaN)).toBe(0);
  expect(clampLevel(3)).toBe(3);
});

it('cuts a band into short arcs that overlap the next and end on the target', () => {
  const segments = bandSegments(0, 3);
  expect(segments).toHaveLength(15);
  expect(segments[0].d.startsWith('M 140 22 A 118 118 0 0 1 ')).toBe(true);
  const end = dialPoint(3);
  expect(segments[14].d.endsWith(`${Math.round(end.x * 100) / 100} ${Math.round(end.y * 100) / 100}`)).toBe(true);
  expect(segments[0].level).toBeCloseTo(0.13);
  expect(bandSegments(-10, 10)).toHaveLength(100);
});

it('draws the off track as one arc across the whole scale', () => {
  expect(offArc()).toBe('M 37.81 199 A 118 118 0 1 1 242.19 199');
});

it('fills from 0 toward the target and not at all at 0', () => {
  expect(fillRange(3)).toEqual([0, 3]);
  expect(fillRange(-3)).toEqual([-3, 0]);
  expect(fillRange(0)).toBeUndefined();
  expect(fillRange(14)).toEqual([0, 10]);
});

it('fills all the way to either end of the scale', () => {
  const warm = bandSegments(...fillRange(10)!);
  expect(warm).toHaveLength(50);
  expect(warm[0].d.startsWith('M 140 22 ')).toBe(true);
  expect(warm[warm.length - 1].d.endsWith(' 242.19 199')).toBe(true);
  const cool = bandSegments(...fillRange(-10)!);
  expect(cool).toHaveLength(50);
  expect(cool[0].d.startsWith('M 37.81 199 ')).toBe(true);
  expect(cool[cool.length - 1].d.endsWith(' 140 22')).toBe(true);
});

it('points the notch at either end of the scale along its angle', () => {
  for (const level of [-10, 10]) {
    const { x1, y1, x2, y2 } = radialLine(level, NOTCH.inner, NOTCH.outer);
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    expect((angle + 360) % 360).toBeCloseTo(levelAngle(level) % 360, 0);
  }
});

it('runs the notch across the track', () => {
  expect(NOTCH).toEqual({ inner: 110, outer: 126 });
  expect(radialLine(0, NOTCH.inner, NOTCH.outer)).toEqual({ x1: 140, y1: 30, x2: 140, y2: 14 });
});

it('marks 21 ticks outside the track, longer every 5 levels', () => {
  const all = ticks();
  expect(all).toHaveLength(21);
  expect(all.filter(tick => tick.major).map(tick => tick.level)).toEqual([-10, -5, 0, 5, 10]);
  expect(all[10]).toEqual({ level: 0, major: true, x1: 140, y1: 11, x2: 140, y2: 3 });
  expect(all[11]).toEqual({ level: 1, major: false, x1: 166.82, y1: 13.82, x2: 167.65, y2: 9.91 });
});

it('puts the end labels under the ends of the track', () => {
  expect(endLabels()).toEqual([{ level: -10, x: 37.81, y: 225 }, { level: 10, x: 242.19, y: 225 }]);
});

it('reads the level under a point, snapping the open bottom to the nearer end', () => {
  for (const level of [-10, -4, 0, 3.5, 10]) {
    const { x, y } = dialPoint(level);
    expect(pointLevel(x, y)).toBeCloseTo(level);
  }
  expect(pointLevel(120, 230)).toBe(-10);
  expect(pointLevel(160, 230)).toBe(10);
});
