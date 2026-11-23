import { media } from '@design/tokens';

export const PAGE_MAX_WIDTH = 720;
export const BED_MAX_WIDTH = 1000;
export const BED_PADDING_X = '32px';

// Banners above the page sit in the same column as the page below them,
// with the same width and side padding, so their edges meet its content.
export const bannerRailSx = (wide: boolean) => ({
  width: '100%',
  maxWidth: PAGE_MAX_WIDTH,
  boxSizing: 'border-box',
  px: { xs: 2, sm: 3 },
  ...(wide ? { [media.desktop]: { maxWidth: BED_MAX_WIDTH, px: BED_PADDING_X } } : {}),
}) as const;

// Bed and Elevation share this, so their tabs stay put when switching between the two.
export const bedPageSx = {
  [media.short]: { gap: 1, pt: 1 },
  [media.tight]: { gap: 0.5, pt: 0.5 },
  [media.desktop]: { maxWidth: BED_MAX_WIDTH, px: BED_PADDING_X, pt: '24px', pb: '40px' },
} as const;

export const isBedPath = (pathname: string) => ['/', '/temperature', '/elevation'].includes(pathname);
