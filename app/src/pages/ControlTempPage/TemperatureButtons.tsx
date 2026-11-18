import { useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { media, palette, weight } from '@design/tokens';
import { Button, Box } from '@mui/material';
import { Add, Remove } from '@mui/icons-material';
import { useControlTempStore } from './controlTempStore.tsx';
import { useAppStore } from '@state/appStore.tsx';
import { postDeviceStatus } from '@api/deviceStatus.ts';
import { useSettings } from '@api/settings.ts';
import { MIN_TEMP_F, MAX_TEMP_F } from '@lib/temperatureConversions.ts';
import { stepTemperature, TemperatureStepState } from '@lib/temperatureStep';
import { bedCommandMessage } from '@lib/requestError.ts';
import useTemperatureFormat from '@lib/useTemperatureFormat';

type TemperatureButtonsProps = {
  refetch: any;
  currentTargetTemp: number;
  statusUnavailable?: boolean;
}

const DEBOUNCE_MS = 400;
export default function TemperatureButtons({ refetch, currentTargetTemp, statusUnavailable = false }: TemperatureButtonsProps) {
  const queryClient = useQueryClient();
  const { side, setIsUpdating: setStoreUpdating } = useAppStore();
  // Only clear the flag this component raised; the power save shares it.
  const holdsUpdating = useRef(false);
  const setIsUpdating = useCallback((value: boolean) => {
    holdsUpdating.current = value;
    setStoreUpdating(value);
  }, [setStoreUpdating]);
  const { deviceStatus, setDeviceStatus, beginEdit, endEdit, setCommandError } = useControlTempStore();
  const { data: settings } = useSettings();
  const format = useTemperatureFormat();
  const steps = useRef<{ side: typeof side; state?: TemperatureStepState }>({ side });
  if (steps.current.side !== side || steps.current.state?.value !== deviceStatus?.[side]?.targetTemperatureF
    || steps.current.state?.format !== format) steps.current = { side };
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editOpenRef = useRef(false);
  const inFlight = useRef(false);
  const ready = useRef(false);
  const mounted = useRef(true);
  const savedTarget = useRef(currentTargetTemp);
  const statusUnavailableRef = useRef(statusUnavailable);
  statusUnavailableRef.current = statusUnavailable;
  useEffect(() => {
    if (!editOpenRef.current && !inFlight.current) savedTarget.current = currentTargetTemp;
  }, [currentTargetTemp]);

  // A target sent to a side that was just turned off would count as a manual
  // change and could pause that side's schedule.
  const sideIsOff = useCallback(() => useControlTempStore.getState().deviceStatus?.[side]?.isOn === false, [side]);

  // After the stepper unmounts (a side switch), still deliver the last target.
  const sendLatest = useCallback(() => {
    ready.current = false;
    const target = useControlTempStore.getState().deviceStatus?.[side]?.targetTemperatureF;
    if (sideIsOff()) {
      setDeviceStatus({ [side]: { targetTemperatureF: savedTarget.current } });
      return;
    }
    if (statusUnavailableRef.current || !Number.isFinite(target)) return;
    postDeviceStatus({ [side]: { targetTemperatureF: target } }).catch((error: unknown) => {
      console.error(error);
      setDeviceStatus({ [side]: { targetTemperatureF: savedTarget.current } });
    });
  }, [side, setDeviceStatus, sideIsOff]);

  const postUpdate = useCallback(async () => {
    if (inFlight.current || !ready.current || !mounted.current) return;
    const target = useControlTempStore.getState().deviceStatus?.[side]?.targetTemperatureF;
    if (sideIsOff()) {
      // The power save owns the updating flag; only the unsent target is undone.
      ready.current = false;
      setDeviceStatus({ [side]: { targetTemperatureF: savedTarget.current } });
      if (editOpenRef.current) { editOpenRef.current = false; endEdit(); }
      return;
    }
    if (statusUnavailableRef.current || !Number.isFinite(target)) {
      ready.current = false;
      if (editOpenRef.current) { editOpenRef.current = false; endEdit(); }
      setIsUpdating(false);
      return;
    }
    inFlight.current = true;
    ready.current = false;
    setIsUpdating(true);
    try {
      await postDeviceStatus({ [side]: { targetTemperatureF: target } });
      setCommandError(undefined);
      // On a Smart Schedule night the Pod now holds this level; show it at once.
      void queryClient.invalidateQueries({ queryKey: ['useRhythmsLive'] });
      if (target !== undefined) savedTarget.current = target;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      console.error(error);
      setCommandError(bedCommandMessage(error));
      if (mounted.current && !ready.current && !debounceTimer.current) {
        setDeviceStatus({ [side]: { targetTemperatureF: savedTarget.current } });
      }
    } finally {
      inFlight.current = false;
      if (ready.current && !mounted.current) {
        sendLatest();
      } else if (mounted.current && ready.current) {
        void postUpdate();
      } else if (!debounceTimer.current) {
        if (editOpenRef.current) {
          editOpenRef.current = false;
          endEdit();
        }
        if (mounted.current) await refetch?.();
        setIsUpdating(false);
      }
    }
  }, [side, refetch, setIsUpdating, endEdit, setDeviceStatus, setCommandError, sendLatest, sideIsOff, queryClient]);

  const scheduleUpdate = useCallback(() => {
    ready.current = false;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      ready.current = true;
      void postUpdate();
    }, DEBOUNCE_MS);
  }, [postUpdate]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        ready.current = true;
      }
      debounceTimer.current = null;
      if (ready.current && !inFlight.current) sendLatest();
      if (!inFlight.current && holdsUpdating.current) setIsUpdating(false);
      if (editOpenRef.current) {
        editOpenRef.current = false;
        endEdit();
      }
    };
  }, [endEdit, setIsUpdating, sendLatest]);

  const isInAwayMode = settings?.[side]?.awayMode;
  if (isInAwayMode) return null;

  const disabled = statusUnavailable || isInAwayMode || !Number.isFinite(deviceStatus?.[side]?.targetTemperatureF);
  const targetF = deviceStatus?.[side]?.targetTemperatureF;
  const atMin = (targetF ?? MIN_TEMP_F) <= MIN_TEMP_F;
  const atMax = (targetF ?? MAX_TEMP_F) >= MAX_TEMP_F;

  const handleClick = (direction: 1 | -1) => {
    if (!deviceStatus || disabled) return;
    if ((direction === -1 && atMin) || (direction === 1 && atMax)) return;
    const currentF = useControlTempStore.getState().deviceStatus![side].targetTemperatureF;
    if (!Number.isFinite(currentF)) return;
    steps.current.state = stepTemperature(currentF, format, direction, steps.current.state);
    const nextF = steps.current.state.value;
    if (nextF === currentF) return;
    if (!editOpenRef.current) {
      editOpenRef.current = true;
      beginEdit();
    }
    setDeviceStatus({
      [side]: {
        targetTemperatureF: nextF,
      }
    });

    scheduleUpdate();
  };

  const stepperSx = (edge: string) => ({
    position: 'relative', overflow: 'visible', width: 64, height: 64, minWidth: 0, p: 0, borderRadius: '50%',
    bgcolor: 'transparent', color: palette.text.primary, boxShadow: `inset 0 0 0 2px ${edge}`,
    '&:hover': { bgcolor: 'transparent' },
    '& .MuiSvgIcon-root': { fontSize: 22 },
    '&[aria-disabled="true"]': { boxShadow: `inset 0 0 0 2px ${palette.step.disabled}`, color: palette.text.disabled, cursor: 'default' },
    '&[aria-disabled="true"] .stepper-label': { color: palette.text.disabled },
    [media.narrow]: { width: 56, height: 56 },
    [media.short]: { width: 56, height: 56 },
    [media.tight]: { width: 48, height: 48 },
  }) as const;
  const labelSx = {
    position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', mt: '5px', whiteSpace: 'nowrap',
    fontSize: 12.5, fontWeight: weight.heading, lineHeight: 1.3, color: palette.text.secondary,
    [media.narrow]: { fontSize: 12 },
    [media.tight]: { mt: '3px', fontSize: 12 },
  } as const;

  // aria-disabled, not disabled, so focus stays on a stepper that reaches its limit.
  return <Box sx={ { display: 'flex', gap: '48px', [media.narrow]: { gap: '44px' } } }>
    <Button
      aria-disabled={ disabled || atMin || undefined }
      sx={ stepperSx(palette.step.cool) }
      onClick={ () => handleClick(-1) }
      onKeyDown={ event => { if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); handleClick(-1); } } }>
      <Remove/>
      <Box component="span" className="stepper-label" sx={ labelSx }>Cooler</Box>
    </Button>
    <Button
      aria-disabled={ disabled || atMax || undefined }
      sx={ stepperSx(palette.step.warm) }
      onClick={ () => handleClick(1) }
      onKeyDown={ event => { if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); handleClick(1); } } }>
      <Add/>
      <Box component="span" className="stepper-label" sx={ labelSx }>Warmer</Box>
    </Button>
  </Box>;
}
