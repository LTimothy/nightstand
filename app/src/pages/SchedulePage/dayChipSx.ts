import { palette, radius } from '@design/tokens';

// `&&` outranks ToggleButtonGroup's own joined-button rules.
export const dayChipSx = {
  '&&': { width: 44, minHeight: 44, px: 0, m: 0, border: 1, borderColor: 'divider', borderRadius: `${radius.base}px` },
  '&&.Mui-selected, &&.Mui-selected:hover': { bgcolor: palette.accent, color: palette.bg.base, borderColor: palette.accent },
} as const;
