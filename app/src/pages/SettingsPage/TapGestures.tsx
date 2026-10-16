/* eslint-disable react/no-multi-comp */ // GestureRow is only used here.
import { useId } from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import { GestureSchema, type Gesture, type Settings, type TapAction } from '@api/settingsSchema.ts';
import { useBaseConfigured } from '@api/baseControl.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useAppStore } from '@state/appStore.tsx';
import { type TemperatureFormat } from '@lib/temperatureConversions';
import { withCurrentValue } from '@lib/selectOptions';
import { weight } from '@design/tokens';
import TemperatureStepper from '../SchedulePage/TemperatureStepper';
import TemperatureChangeSelect from './TemperatureChangeSelect';
import { coverButtonsPath, POD5_HUB_GESTURES } from './FeaturesSection/coverButtons';
import { ACTIONS, actionOf, GESTURE_LABELS, tapFor, type ActionKey } from './tapActions';

const SNOOZE_SECONDS = [60, 120, 180, 240, 300, 360, 420, 480, 540, 600];
const gestureName = (gesture: Gesture) => GESTURE_LABELS[gesture].toLowerCase();
const SIDES = [['left', 'Left'], ['right', 'Right']] as const;

type Props = {
  settings?: Settings;
  updateSettings: (patch: DeepPartial<Settings>) => unknown;
};

function GestureRow({ gesture, side, sideId, tap, format, baseConfigured, disabled, save }: {
  gesture: Gesture; side: string; sideId: string; tap: TapAction; format: TemperatureFormat; baseConfigured: boolean | undefined;
  disabled: boolean;
  save: (tap: TapAction) => void;
}) {
  const id = useId();
  const snoozeId = useId();
  const label = GESTURE_LABELS[gesture];
  const action = actionOf(tap);
  const choices = (Object.keys(ACTIONS) as ActionKey[]).filter(key => key !== 'base' || baseConfigured !== false || action === 'base');
  const note = tap.type === 'set_temperature' ? 'Also turns the side on.'
    : tap.type === 'alarm' ? 'Only while an alarm rings or is snoozed.'
      : tap.type === 'base_control' && baseConfigured === false ? 'No adjustable base is set up, so this does nothing.' : '';
  return <Box>
    <Box sx={ { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 } }>
      <FormControl sx={ { minWidth: 180, flex: '1 1 180px' } }>
        <InputLabel id={ id }>{ label }</InputLabel>
        <Select
          labelId={ id }
          label={ label }
          value={ action }
          disabled={ disabled }
          SelectDisplayProps={ { 'aria-labelledby': `${sideId} ${id}` } }
          onChange={ event => save(tapFor(event.target.value as ActionKey, tap, format)) }>
          { choices.map(key => <MenuItem
            key={ key }
            value={ key }>{ ACTIONS[key] }</MenuItem>) }
        </Select>
      </FormControl>
      { tap.type === 'temperature' && <TemperatureChangeSelect
        label={ `${label} step` }
        labelPrefixId={ sideId }
        valueF={ tap.amount }
        format={ format }
        disabled={ disabled }
        onChange={ amount => save({ ...tap, amount }) }/> }
      { tap.type === 'set_temperature' && <TemperatureStepper
        value={ tap.temperatureF }
        format={ format }
        label={ `${side} ${label} temperature` }
        disabled={ disabled }
        onChange={ temperatureF => save({ ...tap, temperatureF }) }/> }
      { tap.type === 'alarm' && tap.behavior === 'snooze' && <FormControl sx={ { minWidth: 140 } }>
        <InputLabel id={ snoozeId }>{ `${label} snooze` }</InputLabel>
        <Select
          labelId={ snoozeId }
          label={ `${label} snooze` }
          value={ tap.snoozeDuration }
          disabled={ disabled }
          SelectDisplayProps={ { 'aria-labelledby': `${sideId} ${snoozeId}` } }
          onChange={ event => save({ ...tap, snoozeDuration: Number(event.target.value) }) }>
          { withCurrentValue(SNOOZE_SECONDS, tap.snoozeDuration).map(seconds => <MenuItem
            key={ seconds }
            value={ seconds }>{ `${Math.round(seconds / 6) / 10} min` }</MenuItem>) }
        </Select>
      </FormControl> }
    </Box>
    { note && <Typography
      variant="body2"
      color="text.secondary"
      sx={ { mt: 0.5 } }>{ note }</Typography> }
  </Box>;
}

export default function TapGestures({ settings, updateSettings }: Props) {
  const { isUpdating } = useAppStore();
  const baseConfigured = useBaseConfigured();
  const { data: deviceStatus } = useDeviceStatus();
  const sideId = useId();
  if (!settings) return null;
  const format = settings.temperatureFormat ?? 'fahrenheit';
  const coverButtons = coverButtonsPath(deviceStatus?.hubVersion, deviceStatus?.coverVersion) === 'taps';
  return <Stack spacing={ 3 }>
    <Typography
      variant="body2"
      color="text.secondary">What a double, triple or quad tap does on each side.</Typography>
    { coverButtons && <Typography
      variant="body2"
      color="text.secondary">
      { `On your Pod 5 cover, plus is a ${gestureName(POD5_HUB_GESTURES.plus)} and minus a ${gestureName(POD5_HUB_GESTURES.minus)}. `
        + 'Settings > Features > Cover buttons sets them too.' }
    </Typography> }
    { SIDES.map(([side, title]) => {
      const taps = settings[side]?.taps;
      return <Stack
        key={ side }
        role="group"
        aria-label={ `${title} side taps` }
        spacing={ 2 }>
        <Typography
          id={ `${sideId}-${side}` }
          variant="body2"
          color="text.secondary"
          fontWeight={ weight.heading }>{ title }</Typography>
        { taps ? GestureSchema.options.map(gesture => <GestureRow
          key={ gesture }
          gesture={ gesture }
          side={ title }
          sideId={ `${sideId}-${side}` }
          tap={ taps[gesture] }
          format={ format }
          baseConfigured={ baseConfigured }
          disabled={ isUpdating }
          save={ tap => updateSettings({ [side]: { taps: { [gesture]: tap } } }) }/>)
          : <Typography
            variant="body2"
            color="text.secondary">Could not read this side&apos;s tap actions.</Typography> }
      </Stack>;
    }) }
  </Stack>;
}
