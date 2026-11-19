import { useRef, type MutableRefObject, type PointerEvent } from 'react';
import { Box } from '@mui/material';
import { palette } from '@design/tokens';
import { useAppStore } from '@state/appStore';
import {
  F_PER_LEVEL, fahrenheitToLevel, formatTemperature, MAX_TEMP_F, MIN_TEMP_F, NEUTRAL_F, type TemperatureFormat,
} from '@lib/temperatureConversions.ts';
import { stepToward } from '@lib/temperatureStep';
import { useControlTempStore } from './controlTempStore.tsx';
import { DIAL_HEIGHT, DIAL_WIDTH, dialPoint, pointLevel } from './dialGeometry';

type DialHandleProps = {
  target: number;
  format: TemperatureFormat;
  stepRef: MutableRefObject<((direction: 1 | -1) => void) | null>;
};

// A full bed of steps is well under this; it only stops a step that never lands.
const MAX_STEPS = 80;

// The target dot as a drag handle. Only the dot starts a drag, so a stray touch elsewhere changes nothing.
export default function DialHandle({ target, format, stepRef }: DialHandleProps) {
  const { side } = useAppStore();
  // Where the finger sits from the target, in levels, so grabbing the dot off-centre moves nothing.
  const grab = useRef<number | null>(null);
  const dot = dialPoint(fahrenheitToLevel(target));

  const currentF = () => useControlTempStore.getState().deviceStatus?.[side]?.targetTemperatureF;
  const stepTo = (level: number) => {
    let first: 1 | -1 | undefined;
    for (let i = 0; i < MAX_STEPS; i++) {
      const value = currentF();
      if (value === undefined || !Number.isFinite(value)) return;
      const direction = stepToward(value, format, level);
      // A level step can restore an off-grid value, so a reversal means the target is as close as it gets.
      if (!direction || !stepRef.current || (first && direction !== first)) return;
      first = direction;
      stepRef.current(direction);
      if (useControlTempStore.getState().deviceStatus?.[side]?.targetTemperatureF === value) return;
    }
  };

  const levelAt = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return undefined;
    return pointLevel(
      (event.clientX - rect.left) / rect.width * DIAL_WIDTH,
      (event.clientY - rect.top) / rect.height * DIAL_HEIGHT,
    );
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const level = levelAt(event);
    if (grab.current === null || level === undefined) return;
    stepTo(level - grab.current);
  };
  const end = () => { grab.current = null; };

  return <Box
    role="slider"
    tabIndex={ 0 }
    aria-label="Temperature"
    aria-valuemin={ MIN_TEMP_F }
    aria-valuemax={ MAX_TEMP_F }
    aria-valuenow={ target }
    aria-valuetext={ formatTemperature(target, format) }
    data-dial-handle
    onPointerDown={ event => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const level = levelAt(event);
      const value = currentF();
      grab.current = level === undefined || value === undefined ? null : level - (value - NEUTRAL_F) / F_PER_LEVEL;
    } }
    onPointerMove={ move }
    onPointerUp={ end }
    onPointerCancel={ end }
    onLostPointerCapture={ end }
    onKeyDown={ event => {
      const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key] as 1 | -1 | undefined;
      if (!direction) return;
      event.preventDefault();
      stepRef.current?.(direction);
    } }
    sx={ {
      position: 'absolute', left: `${dot.x / DIAL_WIDTH * 100}%`, top: `${dot.y / DIAL_HEIGHT * 100}%`,
      width: 48, height: 48, transform: 'translate(-50%, -50%)', borderRadius: '50%',
      cursor: 'grab', touchAction: 'none', outline: 'none',
      '&:active': { cursor: 'grabbing' },
      '&:focus-visible': { boxShadow: `0 0 0 2px ${palette.text.secondary}` },
    } }/>;
}
