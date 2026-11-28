import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import eventBus from '../events/eventBus.js';
import { emitButtonRecord, resetButtonRecordEvents } from './buttonRecordEvents.js';

describe('emitButtonRecord', () => {
  const record = { side: 'right' as const, control: 'top' as const, count: 2, timestamp: 1000 };
  let seen: unknown[] = [];
  let stop: () => void;
  beforeEach(() => {
    resetButtonRecordEvents();
    seen = [];
    stop = eventBus.subscribe('button', env => seen.push(env.payload));
  });
  afterEach(() => stop());

  it('sends a record once', () => {
    assert.equal(emitButtonRecord(record, 1001), true);
    assert.equal(emitButtonRecord(record, 1002), false);
    assert.deepEqual(seen, [{ side: 'right', button: 'top', clicks: 2, source: 'record' }]);
  });

  it('drops a record older than 30 seconds', () => {
    assert.equal(emitButtonRecord(record, 1031), false);
    assert.deepEqual(seen, []);
  });

  it('drops a record with no side or no control', () => {
    assert.equal(emitButtonRecord({ ...record, side: null }, 1001), false);
    assert.equal(emitButtonRecord({ side: 'left', count: 1, timestamp: 1000 }, 1001), false);
    assert.deepEqual(seen, []);
  });

  it('sends the middle button', () => {
    assert.equal(emitButtonRecord({ ...record, control: 'middle', timestamp: 2000 }, 2001), true);
    assert.deepEqual(seen, [{ side: 'right', button: 'middle', clicks: 2, source: 'record' }]);
  });
});
