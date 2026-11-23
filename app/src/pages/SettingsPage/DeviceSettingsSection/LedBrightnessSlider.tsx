import { useEffect, useRef, useState } from 'react';
import { postDeviceStatus, useDeviceStatus } from '@api/deviceStatus.ts';
import { DeviceStatus } from '@api/deviceStatusSchema.ts';
import _ from 'lodash';
import { useAppStore } from '@state/appStore.tsx';
import { Box, Slider, Typography } from '@mui/material';

// Keyboard arrows commit on every press, so saves are debounced and coalesced:
// the slider stays usable while one is in flight, and a press that lands
// meanwhile is sent when that save finishes.
const SAVE_DELAY_MS = 350;

export default function LedBrightnessSlider() {
  const { setIsUpdating } = useAppStore();
  const { data: deviceStatus, refetch } = useDeviceStatus();
  const [settingsCopy, setSettingsCopy] = useState<undefined | DeviceStatus['settings']>();
  const latest = useRef({ settingsCopy, serverSettings: deviceStatus?.settings });
  latest.current = { settingsCopy, serverSettings: deviceStatus?.settings };
  const pendingValue = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  // True from the first change until its save finishes. Pushed status updates
  // arrive every couple of seconds and must not pull the thumb back meanwhile.
  const editing = useRef(false);
  // Only clear the flag this slider raised; another save may hold it.
  const holdsUpdating = useRef(false);
  useEffect(() => {
    if (!deviceStatus || editing.current) return;
    const newDeviceStatus = _.cloneDeep(deviceStatus) as DeviceStatus;
    setSettingsCopy(newDeviceStatus.settings);
  }, [deviceStatus]);

  const handleChange = (settings: Partial<DeviceStatus['settings']>) => {
    editing.current = true;
    const newSettings = _.merge({}, settingsCopy, settings);
    setSettingsCopy(newSettings);
  };

  const flush = useRef<() => void>(() => undefined);
  flush.current = () => {
    const value = pendingValue.current;
    if (value === undefined || inFlight.current) return;
    pendingValue.current = undefined;
    inFlight.current = true;
    holdsUpdating.current = !useAppStore.getState().isUpdating;
    if (holdsUpdating.current) setIsUpdating(true);
    postDeviceStatus({
      settings: { ...latest.current.settingsCopy, ledBrightness: value },
    })
      .then(() => {
        // Wait 1 second before refreshing the device status
        return new Promise((resolve) => setTimeout(resolve, 1_000));
      })
      .then(() => refetch())
      .catch(error => {
        console.error(error);
        // The write failed, so the optimistic settingsCopy is now a lie. Revert
        // it to the server value; a refetch alone would not re-sync unchanged data.
        pendingValue.current = undefined;
        setSettingsCopy(latest.current.serverSettings);
      })
      .finally(() => {
        inFlight.current = false;
        if (holdsUpdating.current) setIsUpdating(false);
        holdsUpdating.current = false;
        flush.current();
        if (pendingValue.current === undefined && !inFlight.current && timer.current === undefined) {
          editing.current = false;
        }
      });
  };

  const handleSave = (_event: Event | React.SyntheticEvent, value: number | number[]) => {
    pendingValue.current = value as number;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      flush.current();
    }, SAVE_DELAY_MS);
  };

  // Leaving the page must not drop a change made a moment ago.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    flush.current();
  }, []);

  return (

    <Box sx={ { display: 'flex', flexDirection: 'column', gap: 1, width: '100%' } }>
      <Typography variant="body2">
        LED brightness
      </Typography>
      <Box>
        <Slider
          aria-label="LED brightness"
          value={ settingsCopy?.ledBrightness || 0 }
          onChangeCommitted={ handleSave }
          onChange={ (_, newValue) => {
            handleChange({
              ledBrightness: newValue as number,
            });
          } }
          min={ 0 }
          max={ 100 }
          step={ 1 }
          marks={ [
            { value: 0, label: 'Off' },
            { value: 100, label: '100%' },
          ] }
          sx={ { width: '100%', display: 'block', mb: 1, '& .MuiSlider-markLabel[data-index="0"]': { transform: 'none' },
            '& .MuiSlider-markLabel[data-index="1"]': { transform: 'translateX(-100%)' } } }
        />
      </Box>
    </Box>
  );
}
