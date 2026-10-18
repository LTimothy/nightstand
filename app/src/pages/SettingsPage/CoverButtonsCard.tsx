import { Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import type { Settings } from '@api/settingsSchema.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useAppStore } from '@state/appStore.tsx';
import Section from './Section.tsx';
import FeatureToggleRow from './FeaturesSection/FeatureToggleRow.tsx';
import CoverButtonOptions from './CoverButtonOptions.tsx';
import { coverButtonsPath, POD5_HUB_GESTURES } from './coverButtons.ts';
import { GESTURE_LABELS } from './tapActions.ts';

const gestureName = (gesture: keyof typeof GESTURE_LABELS) => GESTURE_LABELS[gesture].toLowerCase();
const POD5_HUB = `Your Pod 5 hub turns plus into a ${gestureName(POD5_HUB_GESTURES.plus)} and minus into a `
  + `${gestureName(POD5_HUB_GESTURES.minus)}; the logo is probably a ${gestureName(POD5_HUB_GESTURES.logo)}, not yet checked. `
  + 'Set what each click does here.';
const POD4_HUB = 'Your Pod 4 hub ignores short clicks on the Pod 5 cover. Nightstand reads them from the Pod\'s log, 15 to 25 s late.';

type Props = {
  settings?: Settings;
  updateSettings: (patch: DeepPartial<Settings>) => unknown;
};

// Only hardware that can use the cover buttons shows this card.
export default function CoverButtonsCard({ settings, updateSettings }: Props) {
  const { isUpdating } = useAppStore();
  const { data: deviceStatus } = useDeviceStatus();
  const path = coverButtonsPath(deviceStatus?.hubVersion, deviceStatus?.coverVersion);
  if (!settings || !path) return null;
  const save = (patch: DeepPartial<Settings>) => { void updateSettings(patch); };
  const options = <CoverButtonOptions
    path={ path }
    settings={ settings }
    disabled={ isUpdating }
    save={ save }/>;
  return <Section title="Cover buttons">
    { path === 'taps' ? <>
      <Typography
        variant="body2"
        color="text.secondary">{ POD5_HUB }</Typography>
      { options }
    </> : <>
      <FeatureToggleRow
        label="Read cover buttons"
        disabled={ isUpdating || settings.features?.coverButtons === undefined }
        checked={ settings.features?.coverButtons ?? false }
        onChange={ next => save({ features: { coverButtons: next } }) }
        description={ POD4_HUB }/>
      { settings.features?.coverButtons && options }
    </> }
  </Section>;
}
