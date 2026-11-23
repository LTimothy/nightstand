import ToggleRow from '@components/ToggleRow';
import { Box, TextField, Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import { useEffect, useRef, useState } from 'react';

import { Settings } from '@api/settingsSchema.ts';
import { Side, useAppStore } from '@state/appStore.tsx';
import { weight } from '@design/tokens';

const MAX_NAME_LENGTH = 20;

// Control and direction-override characters are dropped; the left and right
// marks stay because names in right-to-left scripts use them.
function stripUnsafe(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}

// The server counts UTF-16 units. A paste that is too long is trimmed by whole
// characters, so no emoji or joined sequence is cut in half.
function trimToLimit(value: string) {
  if (value.length <= MAX_NAME_LENGTH) return value;
  let name = '';
  const { Segmenter } = Intl as unknown as { Segmenter: new () => { segment: (text: string) => Iterable<{ segment: string }> } };
  for (const { segment } of new Segmenter().segment(value)) {
    if (name.length + segment.length > MAX_NAME_LENGTH) break;
    name += segment;
  }
  return name;
}

type AwayModeSwitchProps = {
  side: Side;
  settings?: Settings;
  // A save that resolves to false did not go through.
  updateSettings: (settings: DeepPartial<Settings>) => void | Promise<void | boolean>;
}

export default function SideSettings({ side, settings, updateSettings }: AwayModeSwitchProps) {
  const { isUpdating } = useAppStore();
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState(false);
  const savedName = settings?.[side]?.name;
  const loaded = !!settings;
  const title = side.charAt(0).toUpperCase() + side.slice(1);

  // Local state to manage the text field value
  const [sideName, setSideName] = useState(settings?.[side]?.name || '');
  // Update local state when settings change (e.g., from API)
  // Enter and the blur that follows must not send the same name twice.
  const lastSubmitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastSubmitted.current = undefined;
    setSideName(loaded ? savedName ?? side : '');
  }, [loaded, savedName, side]);

  const handleBlur = async () => {
    const name = sideName.trim();
    setNameError(!name);
    if (savingName || !name || name === savedName || name === lastSubmitted.current) return;
    lastSubmitted.current = name;
    setSavingName(true);
    try {
      if (await updateSettings({ [side]: { name } }) === false) lastSubmitted.current = undefined;
    } catch (error) {
      lastSubmitted.current = undefined;
      throw error;
    } finally {
      setSavingName(false);
    }
  };

  return (
    <Box sx={ { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2 } }>
      <Typography variant="body2" color="text.secondary" fontWeight={ weight.heading }>{ title } side</Typography>
      <TextField
        label="Name"
        placeholder="Enter side name"
        value={ sideName }
        onChange={ (e) => {
          const next = stripUnsafe(e.target.value);
          // Typing past the limit is refused, like maxLength, so the end of the name is never cut mid-edit.
          if (next.length > MAX_NAME_LENGTH && (e.nativeEvent as InputEvent).inputType === 'insertText') return;
          setSideName(trimToLimit(next));
          setNameError(false);
        } }
        onBlur={ () => void handleBlur() }
        disabled={ !settings }
        error={ nameError }
        helperText={ nameError ? 'Enter a side name.' : undefined }
        inputProps={ { 'aria-label': `${title} side name`, onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') void handleBlur();
        }, readOnly: savingName, style: { unicodeBidi: 'isolate' } } }
        fullWidth
      />
      <ToggleRow
        label="Away mode"
        ariaLabel={ `${title} away mode` }
        disabled={ isUpdating || !settings }
        checked={ settings?.[side]?.awayMode || false }
        onChange={ next => updateSettings({ [side]: { awayMode: next } }) }
      />
    </Box>
  );
}
