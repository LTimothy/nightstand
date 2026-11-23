import type { PropsWithChildren, ReactNode } from 'react';
import { Box } from '@mui/material';

// `above` sits just over the bar, so a save error is never hidden under it.
export default function DraftBar({ children, above }: PropsWithChildren<{ above?: ReactNode }>) {
  return <Box
    data-schedule-draft="true"
    sx={ {
      position: 'fixed', bottom: { xs: 'calc(72px + env(safe-area-inset-bottom, 0px))', md: 24 }, left: '50%', transform: 'translateX(-50%)',
      width: { xs: 'calc(100% - 32px)', sm: 'calc(100% - 48px)' }, maxWidth: 672,
      height: 60, p: 1, bgcolor: 'background.paper', display: 'flex', alignItems: 'center', gap: 1,
      border: 1, borderColor: 'divider', borderRadius: '24px', zIndex: 2,
    } }>
    { above && <Box sx={ { position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 8px)', maxHeight: '40vh', overflowY: 'auto' } }>
      { above }
    </Box> }
    { children }
  </Box>;
}
