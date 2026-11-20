/* eslint-disable react/no-multi-comp */ // SideButtons is only used here.
import { useId } from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, Stack, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import type { Settings, SideSettings } from '@api/settingsSchema.ts';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { weight } from '@design/tokens';
import TemperatureStepper from '../SchedulePage/TemperatureStepper';
import TemperatureChangeSelect from './TemperatureChangeSelect';
import FeatureToggleRow from './FeaturesSection/FeatureToggleRow';
import { coverButtonsPatch, DEFAULT_LOGO_F, readCoverButtons, type CoverButtonsPath, type CoverButtonValues } from './coverButtons';
import useTemperatureFormat from '@lib/useTemperatureFormat';

const DEFAULT_BOOST_MINUTES = 10;
const BOOST_MINUTES = Array.from({ length: 10 }, (_, i) => i + 1);
const SIDES = [['left', 'Left'], ['right', 'Right']] as const;

function SideButtons({ title, side, path, format, disabled, save }: {
  title: string; side: SideSettings | undefined; path: CoverButtonsPath; format: TemperatureFormat; disabled: boolean;
  save: (patch: DeepPartial<SideSettings>) => void;
}) {
  const titleId = useId();
  const lengthId = useId();
  const values = side ? readCoverButtons(path, side) : null;
  const change = (next: Partial<CoverButtonValues>) => { if (values) save(coverButtonsPatch(path, values, next)); };
  return <Stack
    role="group"
    aria-label={ `${title} side buttons` }
    spacing={ 1.5 }>
    <Typography
      id={ titleId }
      variant="body2"
      color="text.secondary"
      fontWeight={ weight.heading }>{ title }</Typography>
    { !values ? <Typography
      variant="body2"
      color="text.secondary">Could not read this side&apos;s button settings.</Typography> : <>
      { values.stepF === null ? <Typography
        variant="body2"
        color="text.secondary">
        Plus and minus are not a matching warmer and cooler pair. Set them under Bed and sides &gt; Tap gestures.
      </Typography> : <>
        <TemperatureChangeSelect
          label="Step per click"
          labelPrefixId={ titleId }
          valueF={ values.stepF }
          format={ format }
          disabled={ disabled }
          onChange={ stepF => change({ stepF }) }/>
        <FeatureToggleRow
          label="Swap plus and minus"
          ariaLabel={ `${title} swap plus and minus` }
          checked={ values.swapped }
          disabled={ disabled }
          onChange={ swapped => change({ swapped }) }/>
      </> }
      { path === 'taps' && <FeatureToggleRow
        label="Center button sets a temperature"
        ariaLabel={ `${title} center button sets a temperature` }
        checked={ values.logoF !== null }
        disabled={ disabled }
        onChange={ on => change({ logoF: on ? DEFAULT_LOGO_F : null }) }/> }
      { values.logoOther && <Typography
        variant="body2"
        color="text.secondary">The quad tap is set to another action under Bed and sides &gt; Tap gestures,
        so a single press only stops alarms.</Typography> }
      { values.logoF !== null && <Box>
        <Typography variant="body2">Center button temperature</Typography>
        <TemperatureStepper
          value={ values.logoF }
          format={ format }
          label={ `${title} center button temperature` }
          disabled={ disabled }
          onChange={ logoF => change({ logoF }) }/>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={ { mt: 1.5 } }>
          { path === 'taps' ? 'Also turns the side on.' : 'When no alarm is ringing, the center button sets this and turns the side on.' }
        </Typography>
      </Box> }
      { path === 'taps' && <>
        <FeatureToggleRow
          label="Double press for a boost"
          ariaLabel={ `${title} double press for a boost` }
          checked={ values.boostMinutes > 0 }
          disabled={ disabled }
          onChange={ on => change({ boostMinutes: on ? DEFAULT_BOOST_MINUTES : 0 }) }/>
        { values.boostMinutes > 0 && <Stack spacing={ 1.5 }>
          <Box>
            <Typography variant="body2">Boost temperature</Typography>
            <TemperatureStepper
              value={ values.boostF }
              format={ format }
              label={ `${title} boost temperature` }
              disabled={ disabled }
              onChange={ boostF => change({ boostF }) }/>
          </Box>
          <FormControl sx={ { minWidth: 140 } }>
            <InputLabel id={ lengthId }>Boost length</InputLabel>
            <Select
              labelId={ lengthId }
              label="Boost length"
              value={ values.boostMinutes }
              disabled={ disabled }
              SelectDisplayProps={ { 'aria-labelledby': `${titleId} ${lengthId}` } }
              onChange={ event => change({ boostMinutes: Number(event.target.value) }) }>
              { BOOST_MINUTES.map(minutes => <MenuItem
                key={ minutes }
                value={ minutes }>{ minutes } min</MenuItem>) }
            </Select>
          </FormControl>
          <Typography
            variant="body2"
            color="text.secondary">
            Sets this for { values.boostMinutes } min, then returns to the temperature from before the press.
            Only while the side is on. Changing the temperature ends it.
          </Typography>
        </Stack> }
      </> }
    </> }
  </Stack>;
}

export default function CoverButtonOptions({ path, settings, disabled, save }: {
  path: CoverButtonsPath; settings: Settings; disabled: boolean; save: (patch: DeepPartial<Settings>) => void;
}) {
  const format = useTemperatureFormat();
  return <Stack
    spacing={ 3 }
    // Indented under the switch on a Pod 4 hub; a Pod 5 hub has no switch to sit under.
    sx={ path === 'buttons' ? { pl: 2, my: 2, borderLeft: 1, borderColor: 'divider' } : { mt: 2 } }>
    { SIDES.map(([side, title]) => <SideButtons
      key={ side }
      title={ title }
      side={ settings[side] }
      path={ path }
      format={ format }
      disabled={ disabled }
      save={ patch => save({ [side]: patch }) }/>) }
  </Stack>;
}
