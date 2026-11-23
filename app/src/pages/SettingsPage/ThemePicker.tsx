import { useId, useState } from 'react';
import { Box, Button, FormControlLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { palette, themeTokens } from '@design/tokens';
import { THEME_IDS, isThemeId, type ThemeId } from '@design/themes/ids';
import { THEME_NAMES, THEME_PICKER_COPY } from '@design/themes/copy';
import { saveThemeId } from '@design/themePreference';
import ThemePreview from './ThemePreview';

type ThemePickerProps = { reload?: () => void };

const optionSx = { display: 'flex', alignItems: 'center', gap: 1.5 } as const;
const slotSx = { gridArea: '1 / 1' } as const;

// The look is applied before the first paint, so applying one saves and reloads. Choosing only selects,
// so arrowing through the radios never reloads.
export default function ThemePicker({ reload = () => window.location.reload() }: ThemePickerProps) {
  const labelId = useId();
  const [choice, setChoice] = useState<ThemeId>(themeTokens.id);
  const [failures, setFailures] = useState(0);
  const failed = failures > 0;
  const current = choice === themeTokens.id;
  const apply = () => {
    if (current) return;
    if (saveThemeId(choice)) reload();
    else setFailures(count => count + 1);
  };
  return (
    <Box>
      <Typography id={ labelId } variant="body2">{ THEME_PICKER_COPY.label }</Typography>
      <RadioGroup
        aria-labelledby={ labelId }
        value={ choice }
        onChange={ (_event, value) => {
          if (!isThemeId(value)) return;
          setChoice(value);
          setFailures(0);
        } }>
        { THEME_IDS.map(id => <FormControlLabel
          key={ id }
          value={ id }
          control={ <Radio/> }
          label={ <Box component="span" sx={ optionSx }><ThemePreview id={ id }/>{ THEME_NAMES[id] }</Box> }
          sx={ { minHeight: 44, ml: '-11px', mr: 0 } }/>) }
      </RadioGroup>
      { /* aria-disabled, not disabled, so the button stays in place and in the tab order */ }
      <Button
        variant="outlined"
        onClick={ apply }
        aria-disabled={ current || undefined }
        sx={ { mt: 1, '&[aria-disabled="true"]': { color: palette.text.disabled, borderColor: palette.border.control, cursor: 'default' } } }>
        { THEME_PICKER_COPY.apply }
      </Button>
      { /* One slot as tall as its longest line, so a refused save moves nothing. */ }
      <Box sx={ { display: 'grid', mt: 0.5 } }>
        <Typography variant="body2" color="text.secondary" sx={ { ...slotSx, visibility: failed ? 'hidden' : 'visible' } }>
          { THEME_PICKER_COPY.applyNote }
        </Typography>
        <Typography aria-hidden="true" variant="body2" sx={ { ...slotSx, visibility: 'hidden' } }>{ THEME_PICKER_COPY.saveFailed }</Typography>
        <Box role="alert" sx={ slotSx }>
          { failed && <Typography key={ failures } variant="body2" color="warning.main">{ THEME_PICKER_COPY.saveFailed }</Typography> }
        </Box>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={ { mt: 1 } }>{ THEME_PICKER_COPY.helper }</Typography>
    </Box>
  );
}
