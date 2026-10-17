import express from 'express';
import moment from 'moment-timezone';
import logger from '../../logger.js';
import settingsDB from '../../db/settings.js';
import schedulesDB from '../../db/schedules.js';
import { SCHEDULE_SIDES } from '../../db/scheduleKeys.js';
import { loadRhythms, RhythmsStateError, updateRhythms } from '../../db/rhythms.js';
import { NightExcludeSchema, RhythmsLiveQuerySchema, RhythmsSleepsQuerySchema, RhythmsUpdateSchema, SuggestionDismissSchema, SuggestionRestoreSchema, SuggestionsQuerySchema, } from '../../db/rhythmsSchema.js';
import { activation } from '../../jobs/rhythms/activation.js';
import { applyAlarmsEnabled, findOverlaps, resolveLegacySleeps, resolveSleeps } from '../../jobs/rhythms/resolve.js';
import { pruneChanges, sideIssues } from '../../jobs/rhythms/validate.js';
import { z } from 'zod';
import { enableRhythms } from '../../jobs/rhythms/enable.js';
import { disableRhythms } from '../../jobs/rhythms/handoff.js';
import { drivingSide } from '../../jobs/scheduleQueries.js';
import { appendNoteLines, forgetHandChanges, noteId, readChanges, rhythmPlanKey } from '../../jobs/rhythms/handChanges.js';
import { learnSuggestions } from '../../jobs/rhythms/learn.js';
import { liveCurveState, smartResolveHooks } from '../../jobs/rhythms/curveController.js';
const router = express.Router();
export const MAX_SLEEPS_WINDOW_MS = 16 * 24 * 60 * 60 * 1000;
// Changes reach 60 days ahead. Days 61 to 68 have none, so they hold every pair of consecutive weekdays.
const OVERLAP_CHECK_DAYS = 69;
const NOT_READY = {
    absent: 'Rhythms are not set up on this Pod',
    unsupported: 'The saved rhythms are from a newer version',
    invalid: 'The saved rhythms could not be read',
};
async function currentRhythms() {
    await settingsDB.read();
    await schedulesDB.read();
    const load = await loadRhythms();
    const result = activation(settingsDB.data, load, schedulesDB.data);
    const enabled = settingsDB.data.features?.rhythms === true;
    const body = {
        status: result.active ? { enabled, active: true } : { enabled, active: false, reason: result.reason },
        data: load.state === 'ok' ? load.db : null,
    };
    return { body, result };
}
router.get('/rhythms', async (_req, res) => {
    const { body } = await currentRhythms();
    res.json(body);
});
router.post('/rhythms', async (req, res) => {
    const parsed = RhythmsUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        logger.error('Invalid rhythms update:', parsed.error);
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    await settingsDB.read();
    const { timeZone } = settingsDB.data;
    const today = moment.tz(timeZone).format('YYYY-MM-DD');
    // Old changes are dropped first, so one that names a deleted rhythm cannot block the save.
    const updates = SCHEDULE_SIDES.flatMap(side => {
        const sent = parsed.data[side];
        return sent ? [{ side, next: { ...sent, changes: pruneChanges(sent.changes, today) } }] : [];
    });
    // Sleeps that have ended are not checked, so an overlap never names a past date.
    const from = new Date();
    const to = moment.tz(today, 'YYYY-MM-DD', timeZone).add(OVERLAP_CHECK_DAYS, 'days').toDate();
    let issues = [];
    let overlaps = [];
    try {
        await updateRhythms(draft => {
            if (!updates.length)
                return false;
            // Checked inside the write, so a concurrent save cannot restore a larger stored set point count.
            issues = updates.flatMap(({ side, next }) => sideIssues(next, today, draft[side]).map(issue => `${side}: ${issue}`));
            if (issues.length)
                return false;
            for (const { side, next } of updates)
                draft[side] = next;
            overlaps = updates.flatMap(({ side }) => findOverlaps({ db: draft, side, timeZone, from, to }).map(pair => ({ side, ...pair })));
            if (overlaps.length)
                return false;
        });
    }
    catch (error) {
        if (!(error instanceof RhythmsStateError))
            throw error;
        res.status(409).json({ error: NOT_READY[error.state], state: error.state });
        return;
    }
    if (issues.length) {
        res.status(400).json({ error: 'Invalid rhythms', details: issues });
        return;
    }
    if (overlaps.length) {
        res.status(400).json({ error: 'Two sleeps would overlap', overlaps });
        return;
    }
    const { body } = await currentRhythms();
    res.json(body);
});
router.get('/rhythms/sleeps', async (req, res) => {
    const parsed = RhythmsSleepsQuerySchema.safeParse(req.query);
    const from = parsed.success ? new Date(parsed.data.from) : undefined;
    const to = parsed.success ? new Date(parsed.data.to) : undefined;
    if (!parsed.success || !from || !to || to <= from || to.getTime() - from.getTime() > MAX_SLEEPS_WINDOW_MS) {
        res.status(400).json({ error: 'Pass side, and from and to at most 16 days apart' });
        return;
    }
    const { side } = parsed.data;
    const { result } = await currentRhythms();
    // Under Rhythms an away side follows the present side, whose alarms ring only there.
    const driver = result.active ? drivingSide(settingsDB.data, side) : side;
    if (!driver) {
        res.json([]);
        return;
    }
    const window = { side: driver, timeZone: settingsDB.data.timeZone, from, to };
    const sleeps = result.active
        ? resolveSleeps({ db: result.db, ...window, ...smartResolveHooks })
        : resolveLegacySleeps({ schedules: schedulesDB.data, ...window });
    res.json(applyAlarmsEnabled(sleeps, driver === side && settingsDB.data[side].alarmsEnabled));
});
// Loaded on use so importing this router does not start the scheduler.
async function rebuildSchedule() {
    const { setupJobs } = await import('../../jobs/jobScheduler.js');
    await setupJobs();
}
const EnableBodySchema = z.object({}).strict();
const DisableBodySchema = z.object({ powerOffNow: z.boolean().optional() }).strict();
router.post('/rhythms/enable', async (req, res) => {
    const parsed = EnableBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const result = await enableRhythms(rebuildSchedule);
    if ('error' in result) {
        res.status(409).json(result);
        return;
    }
    res.json(result);
});
router.post('/rhythms/disable', async (req, res) => {
    const parsed = DisableBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    res.json(await disableRhythms({ powerOffNow: parsed.data.powerOffNow ?? false }, rebuildSchedule));
});
// The live Smart Schedule night for a side; an away side reads the present side's.
router.get('/rhythms/live', async (req, res) => {
    const parsed = RhythmsLiveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: 'Pass side' });
        return;
    }
    await settingsDB.read();
    const driver = drivingSide(settingsDB.data, parsed.data.side);
    res.json(driver ? liveCurveState(driver) : null);
});
const NO_SUGGESTIONS = { enabled: false, nights: {}, suggestions: [], dismissed: [], log: [] };
const suggestionsOn = () => settingsDB.data.features?.rhythmSuggestions === true;
// Suggestions from hand changes for one side's rhythms. An away side shows
// its own rhythms' evidence from before it went away.
router.get('/rhythms/suggestions', async (req, res) => {
    const parsed = SuggestionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ error: 'Pass side' });
        return;
    }
    const { result } = await currentRhythms();
    if (!suggestionsOn() || !result.active) {
        res.json(NO_SUGGESTIONS);
        return;
    }
    const { side } = parsed.data;
    const lines = (await readChanges()).filter(line => line.side === side);
    const rhythms = Object.values(result.db[side].rhythms).map(rhythm => ({ rhythm, planKey: rhythmPlanKey(rhythm) }));
    const body = { enabled: true, ...learnSuggestions(lines, rhythms, new Date()) };
    res.json(body);
});
// The saved rhythm a note route names, or null once a refusal was sent.
async function noteTarget(res, side, rhythmId) {
    const { body, result } = await currentRhythms();
    if (!suggestionsOn() || !result.active) {
        res.status(409).json({ error: 'Suggestions from your changes is off' });
        return null;
    }
    const rhythms = body.data?.[side].rhythms;
    if (!rhythms || !Object.hasOwn(rhythms, rhythmId)) {
        res.status(404).json({ error: 'This side has no such rhythm' });
        return null;
    }
    return rhythms[rhythmId];
}
router.post('/rhythms/suggestions/exclude', async (req, res) => {
    const parsed = NightExcludeSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const { side, rhythmId, date, excluded } = parsed.data;
    if (!await noteTarget(res, side, rhythmId))
        return;
    const noted = (await readChanges()).some(line => (line.kind === 'night' || line.kind === 'change')
        && line.side === side && line.rhythmId === rhythmId && line.date === date);
    if (!noted) {
        res.status(400).json({ error: 'There are no notes for that night' });
        return;
    }
    await appendNoteLines([{ v: 1, kind: 'exclude', at: new Date().toISOString(), side, rhythmId, date, excluded }]);
    res.status(204).end();
});
// Works with the feature off, so notes can always be deleted.
router.post('/rhythms/suggestions/forget', async (_req, res) => {
    await forgetHandChanges();
    res.status(204).end();
});
// Don't suggest this (one line per checked row, for the current plan) or Hide for 14 nights (one line).
router.post('/rhythms/suggestions/dismiss', async (req, res) => {
    const parsed = SuggestionDismissSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const body = parsed.data;
    const rhythm = await noteTarget(res, body.side, body.rhythmId);
    if (!rhythm)
        return;
    const base = {
        v: 1, kind: 'dismiss', at: new Date().toISOString(), side: body.side, rhythmId: body.rhythmId,
        planKey: rhythmPlanKey(rhythm),
    };
    const lines = body.scope === 'later'
        ? [{ ...base, id: noteId(), key: null, time: null, scope: 'later' }]
        : body.rows.map(row => ({ ...base, id: noteId(), key: row.key, time: row.time, scope: 'plan' }));
    await appendNoteLines(lines);
    res.json({ ids: lines.map(line => line.id) });
});
// Undo after hiding, or Show again in the notes.
router.post('/rhythms/suggestions/restore', async (req, res) => {
    const parsed = SuggestionRestoreSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request data', details: parsed.error.errors });
        return;
    }
    const { result } = await currentRhythms();
    if (!suggestionsOn() || !result.active) {
        res.status(409).json({ error: 'Suggestions from your changes is off' });
        return;
    }
    const { side, ids } = parsed.data;
    const hidden = (await readChanges())
        .filter((line) => line.kind === 'dismiss' && line.side === side && ids.includes(line.id));
    if (!hidden.length) {
        res.status(404).json({ error: 'Nothing is hidden with those ids' });
        return;
    }
    // Only ids that matched a hide, one line per rhythm, so a restore line is pruned with its own rhythm.
    const byRhythm = new Map();
    for (const line of hidden)
        byRhythm.set(line.rhythmId, [...(byRhythm.get(line.rhythmId) ?? []), line.id]);
    const at = new Date().toISOString();
    await appendNoteLines([...byRhythm].map(([rhythmId, matched]) => ({
        v: 1, kind: 'restore', at, side, rhythmId, ids: matched,
    })));
    res.status(204).end();
});
export default router;
//# sourceMappingURL=rhythms.js.map