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
let held = false;
let release = async () => { };
export const rebuildsHeld = () => held;
export function setRebuildRelease(hook) {
    release = hook;
}
// While several schedule files change, no rebuild sees some changed and some not; one runs after.
export async function holdJobRebuilds(work) {
    await settled;
    held = true;
    try {
        return await work();
    }
    finally {
        held = false;
        await release();
    }
}
//# sourceMappingURL=rebuildState.js.map