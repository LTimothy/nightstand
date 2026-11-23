import { ReactNode } from 'react';
import { Box, Typography, Switch } from '@mui/material';
import { palette } from '@design/tokens';

type FeatureToggleRowProps = {
  label: string;
  ariaLabel?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
};

// Presentation only, no opinion on what backs the toggle: the settings
// features object, the services store (biometrics), or anything else a
// future flag needs. Every Settings toggle row was hand-rolled inline
// before this; this is the first shared one.
export default function FeatureToggleRow({ label, checked, onChange, disabled, description, ariaLabel }: FeatureToggleRowProps) {
  return (
    <Box sx={ { '&:not(:last-child)': { mb: description ? 2 : 1 } } }>
      <Box sx={ { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 0.5 } }>
        <Typography sx={ { fontSize: '1rem', color: palette.text.primary } }>{ label }</Typography>
        <Switch
          sx={ { flexShrink: 0 } }
          disabled={ disabled }
          checked={ checked }
          onChange={ (event) => onChange(event.target.checked) }
          slotProps={ { input: { 'aria-label': ariaLabel ?? label } } }
        />
      </Box>
      { description && (
        <Box display='flex' gap={ 1 } alignItems='flex-start'>
          <Typography component="div" sx={ { color: palette.text.secondary, fontSize: '0.875rem', lineHeight: 1.5 } }>
            { description }
          </Typography>
        </Box>
      ) }
    </Box>
  );
}
