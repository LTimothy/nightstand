import { ReactNode } from 'react';
import { Box, LinearProgress, Typography } from '@mui/material';
import { palette, radius } from '@design/tokens';
import { formatBytes } from '../../lib/formatBytes.ts';

type UsageBarProps = {
  label: string;
  usedBytes: number;
  totalBytes: number;
  usedPercent: number;
  caption?: ReactNode;
};

export default function UsageBar({ label, usedBytes, totalBytes, usedPercent, caption }: UsageBarProps) {
  const barColor = usedPercent >= 90
    ? palette.status.error
    : usedPercent >= 75
      ? palette.status.warn
      : palette.text.secondary;

  return (
    <Box sx={ { '&:not(:last-child)': { mb: 1.5 } } }>
      <Box sx={ { display: 'flex', alignItems: 'center', gap: 1, mb: 1 } }>
        <Typography sx={ { fontSize: '1rem', color: palette.text.primary, flex: 1 } }>
          { label }
        </Typography>
        <Typography sx={ { fontSize: '0.875rem', color: palette.text.secondary } }>
          { formatBytes(usedBytes) } of { formatBytes(totalBytes) } used
        </Typography>
      </Box>

      <LinearProgress
        variant="determinate"
        value={ Math.min(usedPercent, 100) }
        sx={ {
          height: 6,
          borderRadius: radius.pill,
          backgroundColor: palette.border.subtle,
          '& .MuiLinearProgress-bar': { backgroundColor: barColor, borderRadius: radius.pill },
        } }
      />

      { caption && (
        <Typography sx={ { fontSize: '0.75rem', color: palette.text.tertiary, mt: 1 } }>
          { caption }
        </Typography>
      ) }
    </Box>
  );
}
