import { media, palette, radius } from '@design/tokens';

// One look for the Tonight card in every state, loaded or not, so the page keeps its shape.
export const cardSx = {
  width: '100%', bgcolor: palette.bg.elevated, borderRadius: `${radius.base}px`, border: 1, borderColor: 'divider',
  p: '8px 16px 6px', [media.narrow]: { p: '6px 14px 4px' }, [media.desktop]: { p: '12px 22px 10px' },
} as const;
export const headingSx = { minHeight: 44, display: 'flex', alignItems: 'center' } as const;
export const tonightLineSx = { fontSize: 15, color: 'text.secondary', m: '2px 0 12px', maxWidth: '46ch' } as const;
