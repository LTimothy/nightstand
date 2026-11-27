import { describe, expect, it } from 'vitest';
import { getLogDescription, detectLogLevel } from './logsMeta.ts';

describe('getLogDescription', () => {
  it('matches rotated log files by their base name', () => {
    expect(getLogDescription('free-sleep-stream.log')).toBe('Live sensor stream, both sides');
    expect(getLogDescription('free-sleep-stream1.log')).toBe('Live sensor stream, both sides');
  });

  it('falls back to a generic description for unknown files', () => {
    expect(getLogDescription('some-unknown-thing.log')).toBe('System log file.');
  });
});

describe('detectLogLevel', () => {
  it('detects Python fixed-width formatted levels', () => {
    expect(detectLogLevel('2026-07-10 03:14:47 UTC | ERROR    | foo.py:1 | boom')).toBe('error');
    expect(detectLogLevel('2026-07-10 03:14:47 UTC | WARNING  | foo.py:1 | careful')).toBe('warn');
    expect(detectLogLevel('2026-07-10 03:14:47 UTC | DEBUG    | foo.py:1 | detail')).toBe('debug');
  });

  it('detects winston JSON levels', () => {
    expect(detectLogLevel('{"level":"error","message":"boom"}')).toBe('error');
    expect(detectLogLevel('{"level":"info","message":"ok"}')).toBe('info');
  });

  it('returns null for lines with no detectable level', () => {
    expect(detectLogLevel('just some plain text')).toBe(null);
  });
});
