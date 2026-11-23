import { Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import type { Settings } from '@api/settingsSchema.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useAppStore } from '@state/appStore.tsx';
import Section from './Section.tsx';
import ToggleRow from '@components/ToggleRow';
import CoverButtonOptions from './CoverButtonOptions.tsx';
import { coverButtonsPath, POD5_HUB_GESTURES } from './coverButtons.ts';
import { GESTURE_LABELS } from './tapActions.ts';

const gestureName = (gesture: keyof typeof GESTURE_LABELS) => GESTURE_LABELS[gesture].toLowerCase();
const POD5_HUB = `Your Pod 5 hub turns plus into a ${gestureName(POD5_HUB_GESTURES.plus)} and minus into a `
  + `${gestureName(POD5_HUB_GESTURES.minus)}. Nightstand reads center (logo) button clicks from the Pod's log, 3 to 25 s late. `
  + 'Set what each click does here.';
const POD4_HUB = 'Your Pod 4 hub ignores short clicks on the Pod 5 cover\'s plus, minus and center (logo) buttons. '
  + 'Nightstand reads them from the Pod\'s log, 15 to 25 s late.';

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
      <ToggleRow
        label="Buzz when a center button press is applied"
        disabled={ isUpdating || settings.features?.logoClickBuzz === undefined }
        checked={ settings.features?.logoClickBuzz ?? false }
        onChange={ next => save({ features: { logoClickBuzz: next } }) }
        description={ 'A 3 s vibration when Nightstand sets the center button temperature or starts a boost, '
          + '3 to 25 s after the press.' }/>
      <Typography
        variant="body2"
        color="text.secondary">{ POD5_HUB }</Typography>
      { options }
    </> : <>
      <ToggleRow
        label="Read cover buttons"
        disabled={ isUpdating || settings.features?.coverButtons === undefined }
        checked={ settings.features?.coverButtons ?? false }
        onChange={ next => save({ features: { coverButtons: next } }) }
        description={ POD4_HUB }>
        { settings.features?.coverButtons && options }
      </ToggleRow>
    </> }
  </Section>;
}
