import { Box, Button } from '@mui/material';
import { Link, useLocation } from 'react-router-dom';
import { useBaseConfigured } from '@api/baseControl.ts';
import { media, palette, radius, weight } from '@design/tokens';

export default function BedTabs() {
  const configured = useBaseConfigured();
  const { pathname } = useLocation();
  const selectedPath = pathname === '/elevation' ? '/elevation' : '/';
  if (configured === false) return null;
  const destinations = [{ to: '/', label: 'Temperature' }, { to: '/elevation', label: 'Elevation' }];
  // Until the base check answers, the row keeps its space so the page below does not jump when it appears.
  const pending = configured === undefined;
  return (
    <Box
      component="nav"
      aria-label="Bed controls"
      aria-hidden={ pending || undefined }
      sx={ {
        display: 'flex', width: '100%', px: 0, borderBottom: 1, borderColor: 'divider', visibility: pending ? 'hidden' : undefined,
        [media.desktop]: { maxWidth: 440, alignSelf: 'flex-start' },
      } }>
      { destinations.map(({ to, label }) => <Button
        key={ to }
        component={ Link }
        to={ to }
        aria-current={ selectedPath === to ? 'page' : undefined }
        sx={ {
          // A phone under 840 px tall gives the row back its 4 px: the power button has to clear the bottom bar.
          minHeight: 48, [media.phoneShort]: { minHeight: 44 },
          flex: 1, px: 0, borderRadius: 0, position: 'relative', fontSize: 16, fontWeight: weight.medium,
          color: selectedPath === to ? 'text.primary' : 'text.secondary',
          // A short centred bar under the open tab, on the row's hairline.
          '&::after': selectedPath === to ? {
            content: '""', position: 'absolute', left: '50%', bottom: '-1px', width: 40, height: 2, ml: '-20px',
            borderRadius: `${radius.mark}px`, bgcolor: palette.accent,
          } : {},
        } }
      >{ label }</Button>) }
    </Box>
  );
}
