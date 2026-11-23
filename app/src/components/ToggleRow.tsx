import { ReactNode } from 'react';
import { Box, Typography, Switch } from '@mui/material';

type ToggleRowProps = {
  label: string;
  ariaLabel?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  description?: ReactNode;
  children?: ReactNode;
};

// py 10px centres a one-line label on the 44px switch.
export default function ToggleRow({ label, ariaLabel, checked, onChange, disabled, description, children }: ToggleRowProps) {
  return (
    <Box sx={ { '&:not(:last-child)': { mb: description || children ? 1 : 0 } } }>
      <Box sx={ { display: 'flex', alignItems: 'flex-start', gap: 2 } }>
        <Box sx={ { flex: 1, minWidth: 0, py: '10px' } }>
          <Typography variant="body1" sx={ { color: 'text.primary' } }>{ label }</Typography>
          { description && (
            <Typography variant="body2" component="div" sx={ { color: 'text.secondary' } }>
              { description }
            </Typography>
          ) }
        </Box>
        <Switch
          sx={ { flexShrink: 0 } }
          disabled={ disabled }
          checked={ checked }
          onChange={ (event) => onChange(event.target.checked) }
          slotProps={ { input: { 'aria-label': ariaLabel ?? label } } }
        />
      </Box>
      { children && <Box sx={ { pl: 2, borderLeft: 1, borderColor: 'divider', mt: 0.5 } }>{ children }</Box> }
    </Box>
  );
}
