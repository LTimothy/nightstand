export type ButtonSide = 'left' | 'right';
export type ButtonName = 'top' | 'bottom';

export interface ButtonEvent {
  side: ButtonSide;
  button: ButtonName;
  kind: 'click';
  at: number;
}

const CODE_TO_BUTTON: Record<number, ButtonName> = { 97: 'top', 99: 'bottom' };
const PRESS_RE = /\[tca8418([RL])\]\s+gpi\s+(press|release)\s+(\d+)/i;
const IGNORED_RE = /\[TTC\]\s+ignoring\s+(\d+)\s+short clicks/i;
const HANDLED_RE = /\[TTC\]|\[thermostat\]\s+temp_(?:up|down)/i;

// Only the firmware's ignored-click result authorizes a temperature change.
export class ButtonEventMachine {
  private down = new Set<string>();
  private pending: ButtonEvent[] = [];

  public push(message: string, tsMs: number): ButtonEvent[] {
    const ignored = IGNORED_RE.exec(message);
    if (ignored) {
      const count = Number(ignored[1]);
      // The result names no side, so attribution follows the pending order.
      const events = count > 0 ? this.pending.slice(-count)
        .filter(event => tsMs - event.at <= 5000)
        .map(event => ({ ...event, at: tsMs })) : [];
      this.pending = [];
      return events;
    }
    if (HANDLED_RE.test(message)) {
      this.pending = [];
      return [];
    }

    const press = PRESS_RE.exec(message);
    if (!press) return [];
    const side: ButtonSide = press[1].toUpperCase() === 'L' ? 'left' : 'right';
    const button = CODE_TO_BUTTON[Number(press[3])];
    if (!button) return [];
    const key = `${side}:${button}`;
    if (press[2].toLowerCase() === 'press') {
      this.down.add(key);
    } else if (this.down.delete(key)) {
      this.pending.push({ side, button, kind: 'click', at: tsMs });
      if (this.pending.length > 8) this.pending.shift();
    }
    return [];
  }
}
