import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// config.ts throws if these aren't set, and reading it is what sets
// lowDbFolder for the db module under test. Must run before the dynamic
// import below. A fresh temp dir keeps this test isolated from any real
// servicesDB.json on the machine running it.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-services-test-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
let updateServices;
let servicesDB;
let ServicesSchema;
before(async () => {
    ({ default: servicesDB, updateServices } = await import('./services.js'));
    ({ ServicesSchema } = await import('./servicesSchema.js'));
});
describe('updateServices', () => {
    // Regression test for a real production incident: analyzeSleepLeft and
    // analyzeSleepRight POST their status independently, milliseconds apart.
    // Without serialization, both requests' read() loads the pre-update
    // state, and whichever write() lands second overwrites the first job's
    // status. analyzeSleepLeft's "failed" was silently lost to
    // analyzeSleepRight's write, leaving the UI stuck showing "started"
    // forever even though the log confirmed both jobs had finished.
    it('does not lose an update when two updates race', async () => {
        await Promise.all([
            updateServices({ biometrics: { jobs: { analyzeSleepLeft: { status: 'failed', message: 'left', timestamp: '' } } } }),
            updateServices({ biometrics: { jobs: { analyzeSleepRight: { status: 'failed', message: 'right', timestamp: '' } } } }),
        ]);
        await servicesDB.read();
        assert.equal(servicesDB.data.biometrics.jobs.analyzeSleepLeft.status, 'failed');
        assert.equal(servicesDB.data.biometrics.jobs.analyzeSleepRight.status, 'failed');
    });
    it('applies updates in call order', async () => {
        await updateServices({ biometrics: { jobs: { calibrateLeft: { status: 'started', message: '', timestamp: '' } } } });
        await updateServices({ biometrics: { jobs: { calibrateLeft: { status: 'healthy', message: '', timestamp: '' } } } });
        await servicesDB.read();
        assert.equal(servicesDB.data.biometrics.jobs.calibrateLeft.status, 'healthy');
    });
    // The calibration/sleep-analysis jobs report 'waiting_for_data' on a
    // fresh install instead of 'failed'. That POST must pass the /api/services
    // schema validation and persist like any other status, or the fresh-install
    // state would 400 at the server boundary.
    it('accepts and persists the waiting_for_data status', async () => {
        const parsed = ServicesSchema.deepPartial().safeParse({
            biometrics: { jobs: { calibrateRight: { status: 'waiting_for_data' } } },
        });
        assert.equal(parsed.success, true);
        await updateServices({
            biometrics: { jobs: { calibrateRight: { status: 'waiting_for_data', message: 'Waiting for enough sensor data.', timestamp: '' } } },
        });
        await servicesDB.read();
        assert.equal(servicesDB.data.biometrics.jobs.calibrateRight.status, 'waiting_for_data');
    });
    // Regression test for the raw-body-merge bug the POST /services route was
    // fixed for: StatusInfoSchema (nested under biometrics.jobs.*) isn't
    // `.strict()`, so an extra property on a job status object passes
    // deepPartial().safeParse() (silently stripped from the validated
    // result) but would have been written to servicesDB.json verbatim if the
    // route still merged the raw body instead of validationResult.data.
    it('does not persist an unknown property that the validated result already stripped', async () => {
        const raw = {
            biometrics: { jobs: { calibrateLeft: { status: 'healthy', message: '', timestamp: '', extraField: 'should not persist' } } },
        };
        const parsed = ServicesSchema.deepPartial().safeParse(raw);
        assert.equal(parsed.success, true);
        if (!parsed.success)
            return;
        assert.ok(!('extraField' in (parsed.data.biometrics?.jobs?.calibrateLeft ?? {})));
        await updateServices(parsed.data);
        await servicesDB.read();
        assert.equal('extraField' in servicesDB.data.biometrics.jobs.calibrateLeft, false);
    });
});
describe('readings and heartbeats', () => {
    const file = () => path.join(dataFolder, 'lowdb', 'servicesDB.json');
    const temps = { ambient: 2100, heatsink: 2500, left: 2900, right: 3000, lastUpdated: '2026-10-18T10:00:30.000Z' };
    it('keeps sensor temperatures and heartbeats in memory without rewriting the file', async () => {
        await updateServices({ biometrics: { jobs: { stream: { status: 'healthy', message: '', timestamp: '2026-10-18T10:00:00.000Z' } } } });
        const before = readFileSync(file(), 'utf8');
        await updateServices({ biometrics: { sensorTemps: temps } });
        await updateServices({ biometrics: { jobs: { stream: { status: 'healthy', message: '', timestamp: '2026-10-18T10:01:00.000Z' } } } });
        assert.equal(readFileSync(file(), 'utf8'), before);
        await servicesDB.read();
        assert.equal(servicesDB.data.biometrics.sensorTemps?.ambient, 2100);
        assert.equal(servicesDB.data.biometrics.jobs.stream.timestamp, '2026-10-18T10:01:00.000Z');
    });
    it('writes the file when a status changes, with the latest readings', async () => {
        await updateServices({ biometrics: { jobs: { stream: { status: 'failed', message: 'stopped', timestamp: '2026-10-18T10:02:00.000Z' } } } });
        const saved = JSON.parse(readFileSync(file(), 'utf8'));
        assert.equal(saved.biometrics.jobs.stream.status, 'failed');
        assert.equal(saved.biometrics.jobs.stream.timestamp, '2026-10-18T10:02:00.000Z');
        assert.equal(saved.biometrics.sensorTemps.ambient, 2100);
    });
});
//# sourceMappingURL=services.test.js.map