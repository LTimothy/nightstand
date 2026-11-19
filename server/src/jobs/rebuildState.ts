// Set while setupJobs re-plans every job. Between cancelling the old jobs and
// planning the new ones the job list is empty, so it says nothing about what is due.
let rebuilding = false;
let settled: Promise<void> = Promise.resolve();
let settle = () => {};

export const isRebuilding = (): boolean => rebuilding;

// Resolves when the re-plan in progress, if any, has finished.
export const rebuildSettled = (): Promise<void> => settled;

export function setRebuilding(on: boolean): void {
  if (on && !rebuilding) settled = new Promise(resolve => { settle = resolve; });
  if (!on && rebuilding) settle();
  rebuilding = on;
}
