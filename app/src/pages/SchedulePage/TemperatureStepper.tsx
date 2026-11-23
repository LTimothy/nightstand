import { useEffect, useRef } from 'react';
import { Box, IconButton } from '@mui/material';
import Add from '@mui/icons-material/Add';
import Remove from '@mui/icons-material/Remove';
import {
  fahrenheitToDisplay, displayBounds, MIN_TEMP_F, MAX_TEMP_F, fahrenheitToLevel, formatTemperature, isTargetFormat,
  TemperatureFormat,
} from '@lib/temperatureConversions';
import { stepTemperature, TemperatureStepState } from '@lib/temperatureStep';
import { temperatureColor } from '@lib/temperatureColor';
import { palette, weight } from '@design/tokens';

export default function TemperatureStepper({ value, format, label, disabled, onChange }: {
  value: number; format: TemperatureFormat; label: string; disabled: boolean; onChange: (value: number) => void;
}) {
  const steps = useRef<TemperatureStepState | undefined>(undefined);
  if (value !== steps.current?.value || format !== steps.current?.format) steps.current = undefined;
  const current = useRef({ value, onChange, disabled, format });
  current.current = { value, onChange, disabled, format };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repeated = useRef(false);
  const holdingDirection = useRef<number | undefined>(undefined);
  const stop = () => { clearTimeout(timer.current); timer.current = undefined; holdingDirection.current = undefined; };
  useEffect(() => stop, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);
  const step = (direction: 1 | -1): boolean => {
    const state = current.current;
    if (state.disabled || !Number.isFinite(state.value)) { stop(); return false; }
    // Match the bed controls: one level, or one Fahrenheit degree in F/C modes.
    steps.current = stepTemperature(state.value, state.format, direction, steps.current);
    const temperature = steps.current.value;
    const atLimit = temperature === MIN_TEMP_F || temperature === MAX_TEMP_F;
    if (atLimit) stop();
    if (temperature === state.value) return false;
    current.current.value = temperature;
    state.onChange(temperature);
    return !atLimit;
  };
  const start = (direction: 1 | -1) => {
    stop();
    repeated.current = false;
    holdingDirection.current = direction;
    const repeat = () => {
      repeated.current = true;
      if (step(direction)) timer.current = setTimeout(repeat, 140);
    };
    if (!current.current.disabled) timer.current = setTimeout(repeat, 450);
  };
  const level = fahrenheitToLevel(value);
  return <Box sx={ { display: 'flex', alignItems: 'center', gap: 0.5, color: temperatureColor(level) } }>
    <IconButton
      aria-label={ `Decrease ${label.toLowerCase()}` }
      disabled={ disabled || !Number.isFinite(value) || value <= MIN_TEMP_F }
      sx={ { width: 44, height: 44, color: 'inherit', border: '1px solid', borderColor: palette.border.control, touchAction: 'none' } }
      onPointerDown={ event => { event.currentTarget.setPointerCapture?.(event.pointerId); start(-1); } }
      onPointerUp={ stop }
      onPointerCancel={ stop }
      onLostPointerCapture={ stop }
      onBlur={ () => { if (holdingDirection.current === -1) stop(); } }
      onClick={ event => { if (!repeated.current || event.detail === 0) step(-1); repeated.current = false; } }><Remove/></IconButton>
    <Box
      role="spinbutton"
      tabIndex={ disabled ? -1 : 0 }
      aria-label={ label }
      aria-disabled={ disabled }
      aria-valuemin={ displayBounds(format).min }
      aria-valuemax={ displayBounds(format).max }
      aria-valuenow={ fahrenheitToDisplay(value, format) }
      aria-valuetext={ formatTemperature(value, format) }
      onKeyDown={ event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          step(event.key === 'ArrowUp' ? 1 : -1);
        }
      } }
      sx={ { minWidth: isTargetFormat(format) || format === 'celsius' ? 80 : 62, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 24, fontWeight: weight.medium,
        fontVariantNumeric: 'tabular-nums', opacity: disabled ? 0.5 : 1,
        '&:focus-visible': { outline: '2px solid', outlineOffset: 3, borderRadius: 1 } } }>{ formatTemperature(value, format) }</Box>
    <IconButton
      aria-label={ `Increase ${label.toLowerCase()}` }
      disabled={ disabled || !Number.isFinite(value) || value >= MAX_TEMP_F }
      sx={ { width: 44, height: 44, color: 'inherit', border: '1px solid', borderColor: palette.border.control, touchAction: 'none' } }
      onPointerDown={ event => { event.currentTarget.setPointerCapture?.(event.pointerId); start(1); } }
      onPointerUp={ stop }
      onPointerCancel={ stop }
      onLostPointerCapture={ stop }
      onBlur={ () => { if (holdingDirection.current === 1) stop(); } }
      onClick={ event => { if (!repeated.current || event.detail === 0) step(1); repeated.current = false; } }><Add/></IconButton>
  </Box>;
}
