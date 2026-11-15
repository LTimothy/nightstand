// Test reporter that fails the run when a test file's results never reached the runner,
// which node:test otherwise counts as a pass. Keep the glob in step with the test script.
import { globSync } from 'node:fs';
import path from 'node:path';

export default async function* testFileGuard(source) {
  const reported = new Set();
  for await (const event of source) {
    if (event.type !== 'test:summary') continue;
    if (event.data.file) {
      reported.add(event.data.file);
      continue;
    }
    const missing = globSync('src/**/*.test.ts').map(file => path.resolve(file)).filter(file => !reported.has(file));
    if (missing.length > 0) {
      process.exitCode = 1;
      yield `${missing.length} test file(s) reported no summary:\n${missing.join('\n')}\n`;
    }
  }
}
