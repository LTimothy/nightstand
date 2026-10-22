import type { Side } from '../db/schedulesSchema.js';

// The targets Nightstand sent, so a target the hub changed by itself (a Pod 5
// hub acts on cover clicks) can be told apart from our own writes.

// The firmware's level scale, the same as updateDeviceStatus uses.
const levelOf = (temperatureF: number) => Math.round((temperatureF - 82.5) / 27.5 * 100);

// When each level was last sent, per side. At most one entry per level.
const sent: Record<Side, Map<number, number>> = { left: new Map(), right: new Map() };

export function noteSentTarget(side: Side, temperatureF: number, now = Date.now()): void {
  sent[side].set(levelOf(temperatureF), now);
}

export function wasSentSince(side: Side, temperatureF: number, since: number): boolean {
  const at = sent[side].get(levelOf(temperatureF));
  return at !== undefined && at >= since;
}
