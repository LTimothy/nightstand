import { expect, it } from 'vitest';
import { media } from '@design/tokens';
import { BED_MAX_WIDTH, BED_PADDING_X, PAGE_MAX_WIDTH, bannerRailSx, isBedPath } from './pageRail';

it('gives banners the page column width and padding', () => {
  expect(bannerRailSx(false)).toMatchObject({ width: '100%', maxWidth: PAGE_MAX_WIDTH, px: { xs: 2, sm: 3 } });
  expect(bannerRailSx(false)).not.toHaveProperty([media.desktop]);
});

it('widens to the Bed column on a desktop', () => {
  expect(bannerRailSx(true)).toMatchObject({ [media.desktop]: { maxWidth: BED_MAX_WIDTH, px: BED_PADDING_X } });
  expect(BED_MAX_WIDTH).toBe(1000);
});

it('treats only the Bed routes as wide', () => {
  expect(['/', '/temperature'].every(isBedPath)).toBe(true);
  expect(isBedPath('/elevation')).toBe(true);
  expect(['/schedules', '/settings/versions', '/sleep'].some(isBedPath)).toBe(false);
});
