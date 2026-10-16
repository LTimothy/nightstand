import { useId } from 'react';
import { FormControl, InputLabel, MenuItem, Select } from '@mui/material';
import { F_PER_LEVEL, formatTemperatureChange, type TemperatureFormat } from '@lib/temperatureConversions';
import { withCurrentValue } from '@lib/selectOptions';

const STEPS_F = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LEVEL_STEPS_F = [1, 2, 3].map(levels => levels * F_PER_LEVEL);

export default function TemperatureChangeSelect({ label, labelPrefixId, valueF, format, disabled, onChange }: {
  label: string; labelPrefixId?: string; valueF: number; format: TemperatureFormat; disabled: boolean; onChange: (valueF: number) => void;
}) {
  const id = useId();
  return <FormControl sx={ { minWidth: 140 } }>
    <InputLabel id={ id }>{ label }</InputLabel>
    <Select
      labelId={ id }
      label={ label }
      value={ valueF }
      disabled={ disabled }
      SelectDisplayProps={ labelPrefixId ? { 'aria-labelledby': `${labelPrefixId} ${id}` } : undefined }
      onChange={ event => onChange(Number(event.target.value)) }>
      { withCurrentValue(format === 'level' ? LEVEL_STEPS_F : STEPS_F, valueF).map(step => <MenuItem
        key={ step }
        value={ step }>{ formatTemperatureChange(step, format) }</MenuItem>) }
    </Select>
  </FormControl>;
}
