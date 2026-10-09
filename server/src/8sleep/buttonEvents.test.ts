import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ButtonEventMachine } from './buttonEvents.js';

const topRight = { side: 'right', button: 'top', kind: 'click', at: 1000 };
const bottomLeft = { side: 'left', button: 'bottom', kind: 'click', at: 1000 };

function click(machine: ButtonEventMachine, side: 'L' | 'R', code: number, at = 1000): void {
  assert.deepEqual(machine.push(`[tca8418${side}] gpi press ${code}`, at), []);
  assert.deepEqual(machine.push(`[tca8418${side}] gpi release ${code}`, at), []);
}

describe('ButtonEventMachine', () => {
  it('timestamps emitted clicks with the ignoring result', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'R', 97, 1000);
    assert.deepEqual(machine.push('[TTC] ignoring 1 short clicks', 6000), [{ ...topRight, at: 6000 }]);
  });

  it('drops pending clicks older than five seconds at the ignoring result', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'R', 97, 1000);
    click(machine, 'L', 99, 5000);
    assert.deepEqual(machine.push('[TTC] ignoring 2 short clicks', 6001), [{ ...bottomLeft, at: 6001 }]);
  });

  it('keeps only the last eight pending clicks', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'L', 99);
    for (let index = 0; index < 8; index += 1) click(machine, 'R', 97);
    assert.deepEqual(machine.push('[TTC] ignoring 9 short clicks', 1000), Array(8).fill(topRight));
  });

  it('waits for the firmware to say a click was ignored', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'R', 97);
    assert.deepEqual(machine.push('[TTC] ignoring 1 short clicks', 1000), [topRight]);
    assert.deepEqual(machine.push('[TTC] ignoring 1 short clicks', 1000), []);
  });

  it('emits at most the last N clicks in order across both sides', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'R', 99);
    click(machine, 'L', 99);
    click(machine, 'R', 97);
    assert.deepEqual(machine.push('[TTC] ignoring 2 short clicks', 1000), [bottomLeft, topRight]);
    assert.deepEqual(machine.push('[TTC] ignoring 2 short clicks', 1000), []);
  });

  it('does not invent missing clicks or emit any for zero', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'R', 97);
    assert.deepEqual(machine.push('[TTC] ignoring 5 short clicks', 1000), [topRight]);
    click(machine, 'R', 97);
    assert.deepEqual(machine.push('[TTC] ignoring 0 short clicks', 1000), []);
    assert.deepEqual(machine.push('[TTC] ignoring 1 short clicks', 1000), []);
  });

  for (const handled of [
    '[TTC] right top button clicked 1 times',
    '[TTC] left top button clicked 2 times',
    '[thermostat] temp_up right -24->-14',
    '[thermostat] temp_down left -14->-24',
    '[TTC] another firmware result',
  ]) {
    it(`clears pending clicks on ${handled}`, () => {
      const machine = new ButtonEventMachine();
      click(machine, 'R', 97);
      assert.deepEqual(machine.push(handled, 1000), []);
      assert.deepEqual(machine.push('[TTC] ignoring 1 short clicks', 1000), []);
    });
  }

  it('collapses repeated presses and ignores releases without a press', () => {
    const machine = new ButtonEventMachine();
    machine.push('[tca8418R] gpi release 97', 1000);
    machine.push('[tca8418R] gpi press 97', 1000);
    machine.push('[tca8418R] gpi press 97', 1000);
    machine.push('[tca8418R] gpi release 97', 1000);
    machine.push('[tca8418R] gpi release 97', 1000);
    assert.deepEqual(machine.push('[TTC] ignoring 2 short clicks', 1000), [topRight]);
  });

  it('ignores logo clicks, invalid keypad noise and incomplete presses', () => {
    const machine = new ButtonEventMachine();
    click(machine, 'L', 98);
    click(machine, 'R', 105);
    machine.push('[tca8418R] invalid gpi->row 105->255', 1000);
    machine.push('[tca8418R] gpi press 127', 1000);
    machine.push('[tca8418R] gpi press 97', 1000);
    assert.deepEqual(machine.push('[TTC] ignoring 4 short clicks', 1000), []);
  });

  it('leaves firmware long presses without an ignoring result alone', () => {
    const machine = new ButtonEventMachine();
    machine.push('[tca8418R] gpi press 97', 1000);
    machine.push('[buttons] long press top: 500ms', 1000);
    assert.deepEqual(machine.push('[tca8418R] gpi release 97', 1000), []);
    assert.deepEqual(machine.push('[buttons] top button held for 500ms', 1000), []);
  });
});
