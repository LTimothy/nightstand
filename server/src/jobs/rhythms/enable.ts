import logger from '../../logger.js';
import { updateSettings } from '../../db/settings.js';
import schedulesDB from '../../db/schedules.js';
import { createRhythms, loadRhythms, updateRhythms } from '../../db/rhythms.js';
import { weeklyRhythms } from './convert.js';
import { legacyFingerprint } from './fingerprint.js';

export const ENABLE_ERRORS = {
  unsupported: 'Rhythms data is from a newer version of Nightstand. Update Nightstand to turn Rhythms on.',
  invalid: 'Rhythms data could not be read, so Rhythms was not turned on.',
  unconvertible: 'A night in the weekly schedule cannot become a rhythm, for example one with more than 10 alarms. '
    + 'Change that night, then turn Rhythms on.',
};

// The weekly schedule is only read here. The first time converts it; later
// times accept the weekly schedule as it is now and keep the rhythms as saved,
// which is also how the app goes back to Rhythms after a fingerprint mismatch.
export async function enableRhythms(rebuild: () => Promise<void>): Promise<{ converted: boolean } | { error: string }> {
  await schedulesDB.read();
  const fingerprint = legacyFingerprint(schedulesDB.data);
  const load = await loadRhythms();
  if (load.state === 'unsupported') return { error: ENABLE_ERRORS.unsupported };
  if (load.state === 'invalid') return { error: ENABLE_ERRORS.invalid };
  let converted = false;
  if (load.state === 'absent') {
    const created = weeklyRhythms(schedulesDB.data);
    if (!created.success) {
      logger.warn(`Rhythms not turned on, the weekly schedule does not convert: ${created.error.message}`);
      return { error: ENABLE_ERRORS.unconvertible };
    }
    await createRhythms(created.data);
    converted = true;
  } else if (load.db.legacyFingerprint !== fingerprint) {
    await updateRhythms(draft => { draft.legacyFingerprint = fingerprint; });
  }
  await updateSettings(draft => {
    if (draft.features.rhythms) return false;
    draft.features.rhythms = true;
  });
  await rebuild();
  logger.info(converted ? 'Rhythms turned on from the weekly schedule' : 'Rhythms turned on');
  return { converted };
}
