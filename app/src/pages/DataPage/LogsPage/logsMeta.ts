// Plain-English description for each known log file, matched by pattern
// since rotated files get a numeric suffix (free-sleep1.log, sleep-analyzer2.log, etc).
const LOG_DESCRIPTIONS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /^free-sleep-stream\d*\.log$/,
    description: 'Live sensor stream, both sides',
  },
  {
    pattern: /^free-sleep-update\d*\.log$/,
    description: 'In-app updater output',
  },
  {
    pattern: /^free-sleep\d*\.log$/,
    description: 'Main server: requests, jobs, hardware link (Franken)',
  },
  {
    pattern: /^sleep-analyzer\d*\.log$/,
    description: 'Nightly sleep analysis',
  },
  {
    pattern: /^calibrate-sensor\d*\.log$/,
    description: 'Presence calibration',
  },
];

export const getLogDescription = (filename: string): string => {
  const match = LOG_DESCRIPTIONS.find(({ pattern }) => pattern.test(filename));
  return match?.description ?? 'System log file.';
};

export type LogLevel = 'error' | 'warn' | 'debug' | 'info' | null;

// Every log format in this repo marks its level near the start of the line,
// either the Python fixed-width formatter ("| ERROR    |") or winston JSON
// ({"level":"error",...}). Detect either without needing to know which
// format a given line is in.
export const detectLogLevel = (line: string): LogLevel => {
  if (/"level":"error"|\|\s*ERROR\s*\|/.test(line)) return 'error';
  if (/"level":"warn"|\|\s*WARNING\s*\|/.test(line)) return 'warn';
  if (/"level":"debug"|\|\s*DEBUG\s*\|/.test(line)) return 'debug';
  if (/"level":"info"|\|\s*INFO\s*\|/.test(line)) return 'info';
  return null;
};
