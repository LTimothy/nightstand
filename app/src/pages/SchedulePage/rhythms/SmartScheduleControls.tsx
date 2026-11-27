import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ToggleRow from '@components/ToggleRow';
import type { SmartSchedule } from '@api/rhythmsSchema';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import LevelStepper from './LevelStepper';

type Props = {
  value: SmartSchedule;
  onChange: (next: SmartSchedule) => void;
  format: TemperatureFormat;
  trackingOn: boolean;
  daySleep: boolean;
  shortSleep?: boolean;
  disabled: boolean;
};

type SwitchKey = 'warmStart' | 'upEarly';
type WarmUp = 'off' | 'base' | 'above';

export default function SmartScheduleControls({ value, onChange, format, trackingOn, daySleep, shortSleep = false, disabled }: Props) {
  const toggle = (key: SwitchKey, label: string, description: string, blocked = false) => <ToggleRow
    key={ key }
    label={ label }
    description={ description }
    // A locked switch shows what the curve does, not the saved choice underneath.
    checked={ value[key] && !blocked }
    disabled={ disabled || blocked }
    onChange={ checked => {
      const next: SmartSchedule = { ...value };
      next[key] = checked;
      onChange(next);
    } }/>;
  const warmUp: WarmUp = !value.warmUp ? 'off' : value.warmUpTo === 'base' ? 'base' : 'above';
  const chooseWarmUp = (next: WarmUp) => {
    const rest = { ...value };
    delete rest.warmUpTo;
    onChange(next === 'off' ? { ...rest, warmUp: false }
      : next === 'base' ? { ...rest, warmUp: true, warmUpTo: 'base' } : { ...rest, warmUp: true });
  };
  return <Stack spacing={ 2 } sx={ { width: '100%' } }>
    { daySleep && <Typography variant="body2" role="note">
      This sleep is mostly during the day, so there is no warm start and the cool-down is a little quicker.
    </Typography> }
    { !daySleep && shortSleep && <Typography variant="body2" role="note">
      This sleep is shorter than 3 hours, so there is no warm start.
    </Typography> }
    <Box sx={ { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 1 } }>
      <Box sx={ { minWidth: 0, flex: '1 1 140px' } }>
        <Typography>Base temperature</Typography>
      </Box>
      <LevelStepper
        level={ value.baseLevel }
        format={ format }
        label="Base temperature"
        disabled={ disabled }
        onChange={ baseLevel => onChange({ ...value, baseLevel }) }/>
    </Box>
    <Box>
      <Typography id="smart-intensity-label" sx={ { mb: 1 } }>Size of changes</Typography>
      <ToggleButtonGroup
        exclusive
        color="primary"
        aria-labelledby="smart-intensity-label"
        value={ value.intensity }
        disabled={ disabled }
        onChange={ (_event, next: SmartSchedule['intensity'] | null) => { if (next) onChange({ ...value, intensity: next }); } }>
        <ToggleButton value="gentle">Gentle</ToggleButton>
        <ToggleButton value="standard">Standard</ToggleButton>
      </ToggleButtonGroup>
    </Box>
    { toggle('warmStart', 'Warm start', daySleep ? 'Off for this rhythm, because its sleep is mostly during the day.'
      : shortSleep ? 'Off for this rhythm, because its sleep is shorter than 3 hours.'
        : 'A little warmer when you get into bed.',
    daySleep || shortSleep) }
    <Box>
      <Typography id="smart-warmup-label" sx={ { mb: 1 } }>Warm-up before wake</Typography>
      <ToggleButtonGroup
        exclusive
        color="primary"
        aria-labelledby="smart-warmup-label"
        value={ warmUp }
        disabled={ disabled }
        onChange={ (_event, next: WarmUp | null) => { if (next) chooseWarmUp(next); } }>
        <ToggleButton value="off">Off</ToggleButton>
        <ToggleButton value="base">To base</ToggleButton>
        <ToggleButton value="above">Above base</ToggleButton>
      </ToggleButtonGroup>
    </Box>
    { toggle('upEarly', 'Skip the warm-up if I get up early', trackingOn
      ? 'Out of bed for 30 minutes near wake time: back to base.'
      : 'Needs Biometrics.', !trackingOn || !value.warmUp) }
  </Stack>;
}
