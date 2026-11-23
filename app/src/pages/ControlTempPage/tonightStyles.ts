import { media, palette, radius } from '@design/tokens';

// One look for the Tonight card in every state, loaded or not, so the page keeps its shape.
// Side padding, shared with the Last night chip so their text lines up.
export const CARD_PX = { base: 16, narrow: 14, desktop: 22 } as const;
// Water and hold alerts beside the card use the same side padding.
export const cardPxSx = {
  px: `${CARD_PX.base}px`, [media.narrow]: { px: `${CARD_PX.narrow}px` }, [media.desktop]: { px: `${CARD_PX.desktop}px` },
} as const;
export const cardSx = {
  width: '100%', bgcolor: palette.bg.elevated, borderRadius: `${radius.base}px`, border: 1, borderColor: 'divider',
  p: `8px ${CARD_PX.base}px 6px`, [media.narrow]: { p: `6px ${CARD_PX.narrow}px 4px` }, [media.desktop]: { p: `12px ${CARD_PX.desktop}px 10px` },
} as const;
export const headingSx = { minHeight: 44, display: 'flex', alignItems: 'center' } as const;
export const tonightLineSx = { fontSize: 15, color: 'text.secondary', m: '2px 0 12px', maxWidth: '46ch' } as const;
