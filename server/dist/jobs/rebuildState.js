// Set while setupJobs re-plans every job. Between cancelling the old jobs and
// planning the new ones the job list is empty, so it says nothing about what is due.
let rebuilding = false;
let settled = Promise.resolve();
let settle = () => { };
export const isRebuilding = () => rebuilding;
// Resolves when the re-plan in progress, if any, has finished.
export const rebuildSettled = () => settled;
export function setRebuilding(on) {
    if (on && !rebuilding)
        settled = new Promise(resolve => { settle = resolve; });
    if (!on && rebuilding)
        settle();
    rebuilding = on;
}
//# sourceMappingURL=rebuildState.js.map