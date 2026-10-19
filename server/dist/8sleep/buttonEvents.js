const CODE_TO_BUTTON = { 97: 'top', 98: 'middle', 99: 'bottom' };
const PRESS_RE = /\[tca8418([RL])\]\s+gpi\s+(press|release)\s+(\d+)/i;
const IGNORED_RE = /\[TTC\]\s+ignoring\s+(\d+)\s+short clicks/i;
const HUB_LOGO_RE = /\[TTC\][^\n]*?\b(left|right)\b[^\n]*?\bmiddle button clicked/i;
const HANDLED_RE = /\[TTC\]|\[thermostat\]\s+temp_(?:up|down)/i;
// Only the firmware's ignored-click result authorizes a temperature change.
export class ButtonEventMachine {
    down = new Set();
    pending = [];
    push(message, tsMs) {
        const ignored = IGNORED_RE.exec(message);
        if (ignored) {
            const count = Number(ignored[1]);
            // The result names no side, so attribution follows the pending order.
            const fresh = this.pending.filter(event => tsMs - event.at <= 5000);
            // A logo click counts only when every pending click was ignored, so a logo
            // the firmware acted on itself is never applied a second time.
            const candidates = count >= this.pending.length ? fresh : fresh.filter(event => event.button !== 'middle');
            const events = count > 0 ? candidates.slice(-count).map(event => ({ ...event, at: tsMs })) : [];
            this.pending = [];
            return events;
        }
        const logo = HUB_LOGO_RE.exec(message);
        if (logo) {
            this.pending = [];
            return [{ side: logo[1].toLowerCase(), button: 'middle', kind: 'click', at: tsMs, hub: true }];
        }
        if (HANDLED_RE.test(message)) {
            this.pending = [];
            return [];
        }
        const press = PRESS_RE.exec(message);
        if (!press)
            return [];
        const side = press[1].toUpperCase() === 'L' ? 'left' : 'right';
        const button = CODE_TO_BUTTON[Number(press[3])];
        if (!button)
            return [];
        const key = `${side}:${button}`;
        if (press[2].toLowerCase() === 'press') {
            this.down.add(key);
        }
        else if (this.down.delete(key)) {
            this.pending.push({ side, button, kind: 'click', at: tsMs });
            if (this.pending.length > 8)
                this.pending.shift();
        }
        return [];
    }
}
//# sourceMappingURL=buttonEvents.js.map